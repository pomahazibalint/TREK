import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';
import { checkSsrf } from '../utils/ssrfGuard';

// ── Interfaces ───────────────────────────────────────────────────────────────

interface NominatimResult {
  osm_type: string;
  osm_id: string;
  name?: string;
  display_name?: string;
  lat: string;
  lon: string;
}

interface OverpassElement {
  tags?: Record<string, string>;
}

interface WikiCommonsPage {
  imageinfo?: { url?: string; extmetadata?: { Artist?: { value?: string } } }[];
}

interface GooglePlaceResult {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  priceLevel?: number;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  types?: string[];
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
}

interface GooglePlaceDetails extends GooglePlaceResult {
  userRatingCount?: number;
  regularOpeningHours?: { weekdayDescriptions?: string[]; openNow?: boolean };
  googleMapsUri?: string;
  editorialSummary?: { text: string };
  reviews?: { authorAttribution?: { displayName?: string; photoUri?: string }; rating?: number; text?: { text?: string }; relativePublishTimeDescription?: string }[];
  photos?: { name: string; authorAttributions?: { displayName?: string }[] }[];
  priceLevel?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const UA = 'TREK Travel Planner (https://github.com/mauriceboe/NOMAD)';

// ── Photo cache ──────────────────────────────────────────────────────────────

const photoCache = new Map<string, { photoUrl: string; attribution: string | null; fetchedAt: number; error?: boolean }>();
const PHOTO_TTL = 12 * 60 * 60 * 1000; // 12 hours
const ERROR_TTL = 5 * 60 * 1000; // 5 min for errors
const CACHE_MAX_ENTRIES = 1000;
const CACHE_PRUNE_TARGET = 500;
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ── Search cache ──────────────────────────────────────────────────────────────

const searchCache = new Map<string, { data: { places: Record<string, unknown>[]; source: string }; fetchedAt: number }>();
const SEARCH_TTL = 24 * 60 * 60 * 1000; // 24 hours
const SEARCH_CACHE_MAX_ENTRIES = 500;
const SEARCH_CACHE_PRUNE_TARGET = 250;

// ── Details cache ─────────────────────────────────────────────────────────────

const detailsCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
const DETAILS_TTL = 6 * 60 * 60 * 1000; // 6 hours
const DETAILS_CACHE_MAX_ENTRIES = 500;
const DETAILS_CACHE_PRUNE_TARGET = 250;

function pruneCache<T extends { fetchedAt: number }>(
  cache: Map<string, T>,
  ttl: number,
  maxEntries: number,
  pruneTarget: number,
  now: number,
): void {
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt > ttl) cache.delete(key);
  }
  if (cache.size > maxEntries) {
    const entries = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    entries.slice(0, entries.length - pruneTarget).forEach(([key]) => cache.delete(key));
  }
}

setInterval(() => {
  const now = Date.now();
  pruneCache(photoCache, PHOTO_TTL, CACHE_MAX_ENTRIES, CACHE_PRUNE_TARGET, now);
  pruneCache(searchCache, SEARCH_TTL, SEARCH_CACHE_MAX_ENTRIES, SEARCH_CACHE_PRUNE_TARGET, now);
  pruneCache(detailsCache, DETAILS_TTL, DETAILS_CACHE_MAX_ENTRIES, DETAILS_CACHE_PRUNE_TARGET, now);
}, CACHE_CLEANUP_INTERVAL);

// ── App setting helper ───────────────────────────────────────────────────────

function getAppSetting(key: string): string | null {
  return (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

// ── API key retrieval ────────────────────────────────────────────────────────

export function getMapsKey(userId: number): string | null {
  const user = db.prepare('SELECT maps_api_key FROM users WHERE id = ?').get(userId) as { maps_api_key: string | null } | undefined;
  const user_key = decrypt_api_key(user?.maps_api_key);
  if (user_key) return user_key;
  const admin = db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get() as { maps_api_key: string } | undefined;
  return decrypt_api_key(admin?.maps_api_key) || null;
}

// ── Nominatim search ─────────────────────────────────────────────────────────

export async function searchNominatim(query: string, lang?: string) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    limit: '10',
    'accept-language': lang || 'en',
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!response.ok) throw new Error('Nominatim API error');
  const data = await response.json() as NominatimResult[];
  return data.map(item => ({
    google_place_id: null,
    osm_id: `${item.osm_type}:${item.osm_id}`,
    name: item.name || item.display_name?.split(',')[0] || '',
    address: item.display_name || '',
    lat: parseFloat(item.lat) || null,
    lng: parseFloat(item.lon) || null,
    rating: null,
    website: null,
    phone: null,
    source: 'openstreetmap',
  }));
}

// ── Overpass API (OSM details) ───────────────────────────────────────────────

export async function fetchOverpassDetails(osmType: string, osmId: string): Promise<OverpassElement | null> {
  const typeMap: Record<string, string> = { node: 'node', way: 'way', relation: 'rel' };
  const oType = typeMap[osmType];
  if (!oType) return null;
  const query = `[out:json][timeout:5];${oType}(${osmId});out tags;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return null;
    const data = await res.json() as { elements?: OverpassElement[] };
    return data.elements?.[0] || null;
  } catch { return null; }
}

// ── Opening hours parsing ────────────────────────────────────────────────────

export function parseOpeningHours(ohString: string): { weekdayDescriptions: string[]; openNow: boolean | null } {
  const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const result: string[] = LONG.map(d => `${d}: ?`);

  // Parse segments like "Mo-Fr 09:00-18:00; Sa 10:00-14:00"
  for (const segment of ohString.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(.+)$/i);
    if (!match) continue;
    const [, daysPart, timePart] = match;
    const dayIndices = new Set<number>();
    for (const range of daysPart.split(',')) {
      const parts = range.trim().split('-').map(d => DAYS.indexOf(d.trim()));
      if (parts.length === 2 && parts[0] >= 0 && parts[1] >= 0) {
        for (let i = parts[0]; i !== (parts[1] + 1) % 7; i = (i + 1) % 7) dayIndices.add(i);
        dayIndices.add(parts[1]);
      } else if (parts[0] >= 0) {
        dayIndices.add(parts[0]);
      }
    }
    for (const idx of dayIndices) {
      result[idx] = `${LONG[idx]}: ${timePart.trim()}`;
    }
  }

  // Compute openNow
  let openNow: boolean | null = null;
  try {
    const now = new Date();
    const jsDay = now.getDay();
    const dayIdx = jsDay === 0 ? 6 : jsDay - 1;
    const todayLine = result[dayIdx];
    const timeRanges = [...todayLine.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    if (timeRanges.length > 0) {
      const nowMins = now.getHours() * 60 + now.getMinutes();
      openNow = timeRanges.some(m => {
        const start = parseInt(m[1]) * 60 + parseInt(m[2]);
        const end = parseInt(m[3]) * 60 + parseInt(m[4]);
        return end > start ? nowMins >= start && nowMins < end : nowMins >= start || nowMins < end;
      });
    }
  } catch { /* best effort */ }

  return { weekdayDescriptions: result, openNow };
}

// ── Build standardized OSM details ───────────────────────────────────────────

export function buildOsmDetails(tags: Record<string, string>, osmType: string, osmId: string) {
  let opening_hours: string[] | null = null;
  let open_now: boolean | null = null;
  if (tags.opening_hours) {
    const parsed = parseOpeningHours(tags.opening_hours);
    const hasData = parsed.weekdayDescriptions.some(line => !line.endsWith('?'));
    if (hasData) {
      opening_hours = parsed.weekdayDescriptions;
      open_now = parsed.openNow;
    }
  }
  return {
    website: tags['contact:website'] || tags.website || null,
    phone: tags['contact:phone'] || tags.phone || null,
    opening_hours,
    open_now,
    osm_url: `https://www.openstreetmap.org/${osmType}/${osmId}`,
    summary: tags.description || null,
    source: 'openstreetmap' as const,
  };
}

// ── Wikimedia Commons photo lookup ───────────────────────────────────────────

export async function fetchWikimediaPhoto(lat: number, lng: number, name?: string): Promise<{ photoUrl: string; attribution: string | null } | null> {
  // Strategy 1: Search Wikipedia for the place name -> get the article image
  if (name) {
    try {
      const searchParams = new URLSearchParams({
        action: 'query', format: 'json',
        titles: name,
        prop: 'pageimages',
        piprop: 'thumbnail',
        pithumbsize: '400',
        pilimit: '1',
        redirects: '1',
      });
      const res = await fetch(`https://en.wikipedia.org/w/api.php?${searchParams}`, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const data = await res.json() as { query?: { pages?: Record<string, { thumbnail?: { source?: string } }> } };
        const pages = data.query?.pages;
        if (pages) {
          for (const page of Object.values(pages)) {
            if (page.thumbnail?.source) {
              return { photoUrl: page.thumbnail.source, attribution: 'Wikipedia' };
            }
          }
        }
      }
    } catch { /* fall through to geosearch */ }
  }

  // Strategy 2: Wikimedia Commons geosearch by coordinates
  const params = new URLSearchParams({
    action: 'query', format: 'json',
    generator: 'geosearch',
    ggsprimary: 'all',
    ggsnamespace: '6',
    ggsradius: '300',
    ggscoord: `${lat}|${lng}`,
    ggslimit: '5',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime',
    iiurlwidth: '400',
  });
  try {
    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = await res.json() as { query?: { pages?: Record<string, WikiCommonsPage & { imageinfo?: { mime?: string }[] }> } };
    const pages = data.query?.pages;
    if (!pages) return null;
    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      // Only use actual photos (JPEG/PNG), skip SVGs and PDFs
      const mime = (info as { mime?: string })?.mime || '';
      if (info?.url && (mime.startsWith('image/jpeg') || mime.startsWith('image/png'))) {
        const attribution = info.extmetadata?.Artist?.value?.replace(/<[^>]+>/g, '').trim() || null;
        return { photoUrl: info.url, attribution };
      }
    }
    return null;
  } catch { return null; }
}

// ── Autocomplete (Google predictions or Nominatim fallback) ──────────────────

interface GoogleAutocompletePrediction {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
  };
}

export async function autocompletePlaces(
  userId: number,
  input: string,
  lang?: string,
): Promise<{ places: Record<string, unknown>[]; source: string }> {
  if (getAppSetting('maps_autocomplete_disabled') === 'true') {
    throw Object.assign(new Error('Place search is disabled by the administrator'), { status: 503 });
  }
  const apiKey = getMapsKey(userId);

  const nominatimOnly = !apiKey || getAppSetting('maps_autocomplete_nominatim_only') === 'true';

  if (nominatimOnly) {
    const params = new URLSearchParams({
      q: input,
      format: 'json',
      addressdetails: '1',
      limit: '5',
      'accept-language': lang || 'en',
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': UA },
    });
    if (!response.ok) throw new Error('Nominatim API error');
    const data = await response.json() as NominatimResult[];
    const places = data
      .filter(item => item.osm_id && item.osm_type)
      .map(item => ({
        google_place_id: null,
        osm_id: `${item.osm_type}:${item.osm_id}`,
        name: item.name || item.display_name?.split(',')[0] || '',
        address: item.display_name || '',
        lat: parseFloat(item.lat) || null,
        lng: parseFloat(item.lon) || null,
        source: 'openstreetmap',
      }));
    return { places, source: 'openstreetmap' };
  }

  const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
    },
    body: JSON.stringify({ input, languageCode: lang || 'en' }),
  });

  const data = await response.json() as { suggestions?: GoogleAutocompletePrediction[]; error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places Autocomplete error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const places = (data.suggestions || [])
    .filter(s => s.placePrediction?.placeId)
    .map(s => ({
      google_place_id: s.placePrediction!.placeId,
      osm_id: null,
      name: s.placePrediction!.structuredFormat?.mainText?.text || s.placePrediction!.text?.text || '',
      address: s.placePrediction!.structuredFormat?.secondaryText?.text || s.placePrediction!.text?.text || '',
      lat: null,
      lng: null,
      source: 'google',
    }));

  return { places, source: 'google' };
}

// ── Search places (Google or Nominatim fallback) ─────────────────────────────

export async function searchPlaces(userId: number, query: string, lang?: string): Promise<{ places: Record<string, unknown>[]; source: string }> {
  if (getAppSetting('maps_autocomplete_disabled') === 'true') {
    throw Object.assign(new Error('Place search is disabled by the administrator'), { status: 503 });
  }
  const apiKey = getMapsKey(userId);
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = `${apiKey ? 'google' : 'osm'}:${normalizedQuery}:${lang || 'en'}`;

  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_TTL) return cached.data;

  if (!apiKey) {
    const places = await searchNominatim(query, lang);
    const result = { places, source: 'openstreetmap' };
    searchCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  }

  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.websiteUri,places.nationalPhoneNumber,places.types,places.regularOpeningHours',
    },
    body: JSON.stringify({ textQuery: query, languageCode: lang || 'en' }),
  });

  const data = await response.json() as { places?: GooglePlaceResult[]; error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const places = (data.places || []).map((p: GooglePlaceResult) => ({
    google_place_id: p.id,
    name: p.displayName?.text || '',
    address: p.formattedAddress || '',
    lat: p.location?.latitude || null,
    lng: p.location?.longitude || null,
    rating: p.rating || null,
    price_level: p.priceLevel ?? null,
    website: p.websiteUri || null,
    phone: p.nationalPhoneNumber || null,
    opening_hours: p.regularOpeningHours?.weekdayDescriptions || null,
    source: 'google',
  }));

  const result = { places, source: 'google' };
  searchCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
  return result;
}

// ── Place details (Google or OSM) ────────────────────────────────────────────

export async function getPlaceDetails(userId: number, placeId: string, lang?: string): Promise<{ place: Record<string, unknown> }> {
  if (getAppSetting('maps_details_disabled') === 'true') {
    throw Object.assign(new Error('Place details are disabled by the administrator'), { status: 503 });
  }

  const cacheKey = `${placeId}:${lang || 'de'}`;

  const cached = detailsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < DETAILS_TTL) return { place: cached.data };

  // DB persistent cache — check before hitting API (shared across users, survives restarts)
  const dbCached = db.prepare('SELECT data FROM place_details_cache WHERE place_id = ? AND lang = ?').get(placeId, lang || 'de') as { data: string } | undefined;
  if (dbCached) {
    try {
      const place = JSON.parse(dbCached.data);
      detailsCache.set(cacheKey, { data: place, fetchedAt: Date.now() });
      return { place };
    } catch { /* corrupt row — fall through to API */ }
  }

  // OSM details: placeId is "node:123456" or "way:123456" etc.
  if (placeId.includes(':')) {
    const [osmType, osmId] = placeId.split(':');
    const element = await fetchOverpassDetails(osmType, osmId);
    const place = !element?.tags ? buildOsmDetails({}, osmType, osmId) : buildOsmDetails(element.tags, osmType, osmId);
    detailsCache.set(cacheKey, { data: place, fetchedAt: Date.now() });
    try { db.prepare('INSERT OR REPLACE INTO place_details_cache (place_id, lang, data, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(placeId, lang || 'de', JSON.stringify(place)); } catch { /* non-fatal */ }
    return { place };
  }

  // Google details
  const apiKey = getMapsKey(userId);
  if (!apiKey) {
    throw Object.assign(new Error('Google Maps API key not configured'), { status: 400 });
  }

  const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=${lang || 'de'}`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,rating,priceLevel,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri,reviews,editorialSummary',
    },
  });

  const data = await response.json() as GooglePlaceDetails & { error?: { message?: string } };

  if (!response.ok) {
    const err = new Error(data.error?.message || 'Google Places API error') as Error & { status: number };
    err.status = response.status;
    throw err;
  }

  const place = {
    google_place_id: data.id,
    name: data.displayName?.text || '',
    address: data.formattedAddress || '',
    lat: data.location?.latitude || null,
    lng: data.location?.longitude || null,
    rating: data.rating || null,
    price_level: data.priceLevel ?? null,
    rating_count: data.userRatingCount || null,
    website: data.websiteUri || null,
    phone: data.nationalPhoneNumber || null,
    opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
    open_now: data.regularOpeningHours?.openNow ?? null,
    google_maps_url: data.googleMapsUri || null,
    summary: data.editorialSummary?.text || null,
    reviews: (data.reviews || []).slice(0, 5).map((r: NonNullable<GooglePlaceDetails['reviews']>[number]) => ({
      author: r.authorAttribution?.displayName || null,
      rating: r.rating || null,
      text: r.text?.text || null,
      time: r.relativePublishTimeDescription || null,
      photo: r.authorAttribution?.photoUri || null,
    })),
    source: 'google' as const,
  };

  detailsCache.set(cacheKey, { data: place, fetchedAt: Date.now() });
  try { db.prepare('INSERT OR REPLACE INTO place_details_cache (place_id, lang, data, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(placeId, lang || 'de', JSON.stringify(place)); } catch { /* non-fatal */ }
  return { place };
}

// ── Place photo (Google or Wikimedia, with caching + DB persistence) ─────────

export async function getPlacePhoto(
  userId: number,
  placeId: string,
  lat: number,
  lng: number,
  name?: string,
): Promise<{ photoUrl: string | null; attribution: string | null }> {
  // Check in-memory cache first
  const cached = photoCache.get(placeId);
  if (cached) {
    const ttl = cached.error ? ERROR_TTL : PHOTO_TTL;
    if (Date.now() - cached.fetchedAt < ttl) {
      if (cached.error) return { photoUrl: null, attribution: null };
      return { photoUrl: cached.photoUrl, attribution: cached.attribution };
    }
    photoCache.delete(placeId);
  }

  // Check persistent photo cache (survives server restarts, shared across users)
  const dbCached = db.prepare(
    'SELECT photo_url, attribution FROM place_photo_cache WHERE place_key = ?'
  ).get(placeId) as { photo_url: string | null; attribution: string | null } | undefined;
  if (dbCached) {
    db.prepare("UPDATE place_photo_cache SET last_used_at = CURRENT_TIMESTAMP WHERE place_key = ?").run(placeId);
    if (dbCached.photo_url) {
      photoCache.set(placeId, { photoUrl: dbCached.photo_url, attribution: dbCached.attribution, fetchedAt: Date.now() });
      return { photoUrl: dbCached.photo_url, attribution: dbCached.attribution };
    }
    photoCache.set(placeId, { photoUrl: '', attribution: null, fetchedAt: Date.now(), error: true });
    return { photoUrl: null, attribution: null };
  }

  const apiKey = getMapsKey(userId);
  const isCoordLookup = placeId.startsWith('coords:');

  // No Google key or coordinate-only lookup -> try Wikimedia
  if (!apiKey || isCoordLookup) {
    if (!isNaN(lat) && !isNaN(lng)) {
      try {
        const wiki = await fetchWikimediaPhoto(lat, lng, name);
        if (wiki) {
          photoCache.set(placeId, { ...wiki, fetchedAt: Date.now() });
          try {
            db.prepare(
              'INSERT OR REPLACE INTO place_photo_cache (place_key, photo_url, attribution, source) VALUES (?, ?, ?, ?)'
            ).run(placeId, wiki.photoUrl, wiki.attribution, 'wikimedia');
          } catch { /* non-fatal */ }
          return wiki;
        }
      } catch { /* fall through */ }
    }
    photoCache.set(placeId, { photoUrl: '', attribution: null, fetchedAt: Date.now(), error: true });
    try {
      db.prepare(
        'INSERT OR IGNORE INTO place_photo_cache (place_key, photo_url, attribution, source) VALUES (?, NULL, NULL, ?)'
      ).run(placeId, isCoordLookup ? 'wikimedia' : 'google');
    } catch { /* non-fatal */ }
    return { photoUrl: null, attribution: null };
  }

  // Google Photos API fetch
  const detailsRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'photos',
    },
  });
  const details = await detailsRes.json() as GooglePlaceDetails & { error?: { message?: string } };

  if (!detailsRes.ok) {
    console.error('Google Places photo details error:', details.error?.message || detailsRes.status);
    photoCache.set(placeId, { photoUrl: '', attribution: null, fetchedAt: Date.now(), error: true });
    return { photoUrl: null, attribution: null };
  }

  if (!details.photos?.length) {
    photoCache.set(placeId, { photoUrl: '', attribution: null, fetchedAt: Date.now(), error: true });
    try {
      db.prepare(
        'INSERT OR IGNORE INTO place_photo_cache (place_key, photo_url, attribution, source) VALUES (?, NULL, NULL, ?)'
      ).run(placeId, 'google');
    } catch { /* non-fatal */ }
    return { photoUrl: null, attribution: null };
  }

  const photo = details.photos[0];
  const photoName = photo.name;
  const attribution = photo.authorAttributions?.[0]?.displayName || null;

  const mediaRes = await fetch(
    `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=400&skipHttpRedirect=true`,
    { headers: { 'X-Goog-Api-Key': apiKey } }
  );
  const mediaData = await mediaRes.json() as { photoUri?: string };
  const photoUrl = mediaData.photoUri;

  if (!photoUrl) {
    photoCache.set(placeId, { photoUrl: '', attribution, fetchedAt: Date.now(), error: true });
    return { photoUrl: null, attribution: null };
  }

  photoCache.set(placeId, { photoUrl, attribution, fetchedAt: Date.now() });

  try {
    db.prepare(
      'INSERT OR REPLACE INTO place_photo_cache (place_key, photo_url, attribution, source) VALUES (?, ?, ?, ?)'
    ).run(placeId, photoUrl, attribution, 'google');
  } catch { /* non-fatal */ }

  return { photoUrl, attribution };
}

// ── Reverse geocoding ────────────────────────────────────────────────────────

export async function reverseGeocode(lat: string, lng: string, lang?: string): Promise<{ name: string | null; address: string | null }> {
  // Round to 4 decimal places (~11 m precision) for cache key
  const latKey = Math.round(parseFloat(lat) * 10000) / 10000;
  const lngKey = Math.round(parseFloat(lng) * 10000) / 10000;

  const dbRow = db.prepare('SELECT name, address FROM geocode_cache WHERE lat_key = ? AND lng_key = ?').get(latKey, lngKey) as { name: string | null; address: string | null } | undefined;
  if (dbRow) return { name: dbRow.name, address: dbRow.address };

  const params = new URLSearchParams({
    lat, lon: lng, format: 'json', addressdetails: '1', zoom: '18',
    'accept-language': lang || 'en',
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
    headers: { 'User-Agent': UA },
  });
  if (!response.ok) return { name: null, address: null };
  const data = await response.json() as { name?: string; display_name?: string; address?: Record<string, string> };
  const addr = data.address || {};
  const name = data.name || addr.tourism || addr.amenity || addr.shop || addr.building || addr.road || null;
  const result = { name, address: data.display_name || null };

  try { db.prepare('INSERT OR REPLACE INTO geocode_cache (lat_key, lng_key, name, address) VALUES (?, ?, ?, ?)').run(latKey, lngKey, result.name, result.address); } catch { /* non-fatal */ }
  return result;
}

// ── Resolve Google Maps URL ──────────────────────────────────────────────────

export async function resolveGoogleMapsUrl(url: string): Promise<{ lat: number; lng: number; name: string | null; address: string | null }> {
  let resolvedUrl = url;

  // Follow redirects for short URLs (goo.gl, maps.app.goo.gl) with SSRF protection
  const parsed = new URL(url);
  if (['goo.gl', 'maps.app.goo.gl'].includes(parsed.hostname)) {
    const ssrf = await checkSsrf(url, true);
    if (!ssrf.allowed) throw Object.assign(new Error('URL blocked by SSRF check'), { status: 403 });
    const redirectRes = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    resolvedUrl = redirectRes.url;
  }

  // Extract coordinates from Google Maps URL patterns:
  // /@48.8566,2.3522,15z  or  /place/.../@48.8566,2.3522
  // ?q=48.8566,2.3522  or  ?ll=48.8566,2.3522
  let lat: number | null = null;
  let lng: number | null = null;
  let placeName: string | null = null;

  // Pattern: /@lat,lng
  const atMatch = resolvedUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) { lat = parseFloat(atMatch[1]); lng = parseFloat(atMatch[2]); }

  // Pattern: !3dlat!4dlng (Google Maps data params)
  if (!lat) {
    const dataMatch = resolvedUrl.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
    if (dataMatch) { lat = parseFloat(dataMatch[1]); lng = parseFloat(dataMatch[2]); }
  }

  // Pattern: ?q=lat,lng or &q=lat,lng
  if (!lat) {
    const qMatch = resolvedUrl.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (qMatch) { lat = parseFloat(qMatch[1]); lng = parseFloat(qMatch[2]); }
  }

  // Extract place name from URL path: /place/Place+Name/@...
  const placeMatch = resolvedUrl.match(/\/place\/([^/@]+)/);
  if (placeMatch) {
    placeName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
  }

  if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
    throw Object.assign(new Error('Could not extract coordinates from URL'), { status: 400 });
  }

  // Reverse geocode to get address
  const nominatimRes = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
    { headers: { 'User-Agent': 'TREK-Travel-Planner/1.0' }, signal: AbortSignal.timeout(8000) }
  );
  const nominatim = await nominatimRes.json() as { display_name?: string; name?: string; address?: Record<string, string> };

  const name = placeName || nominatim.name || nominatim.address?.tourism || nominatim.address?.building || null;
  const address = nominatim.display_name || null;

  return { lat, lng, name, address };
}
