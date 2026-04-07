import type { RouteResult, RouteSegment, Waypoint, TransportMode } from '../../types'
import { mapsApi } from '../../api/client'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1'

// Client-side cache: same waypoints + profile → same OSRM geometry
const routeCache = new Map<string, { result: RouteResult; fetchedAt: number }>()
const ROUTE_CACHE_TTL = 10 * 60 * 1000 // 10 minutes
const ROUTE_CACHE_MAX = 200
const ROUTE_CACHE_PRUNE_TARGET = 100

function routeCacheKey(waypoints: Waypoint[], profile: TransportMode): string {
  return `${profile}:${waypoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')}`
}

function pruneRouteCache(now: number): void {
  for (const [key, entry] of routeCache) {
    if (now - entry.fetchedAt > ROUTE_CACHE_TTL) routeCache.delete(key)
  }
  if (routeCache.size > ROUTE_CACHE_MAX) {
    const sorted = [...routeCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)
    sorted.slice(0, sorted.length - ROUTE_CACHE_PRUNE_TARGET).forEach(([k]) => routeCache.delete(k))
  }
}

/** Fetches a full route via OSRM and returns coordinates, per-leg segments, distance, and duration estimates.
 *  Results are cached client-side for 10 minutes to reduce OSRM API load. */
export async function calculateRoute(
  waypoints: Waypoint[],
  profile: TransportMode = 'driving',
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteResult> {
  if (!waypoints || waypoints.length < 2) {
    throw new Error('At least 2 waypoints required')
  }

  const now = Date.now()
  const cacheKey = routeCacheKey(waypoints, profile)
  const cached = routeCache.get(cacheKey)
  if (cached && now - cached.fetchedAt < ROUTE_CACHE_TTL) {
    return cached.result
  }

  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/${profile}/${coords}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`

  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error('Route could not be calculated')
  }

  const data = await response.json()

  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    throw new Error('No route found')
  }

  const route = data.routes[0]
  const coordinates: [number, number][] = route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng])

  const distance: number = route.distance
  let duration: number
  if (profile === 'walking') {
    duration = distance / (5000 / 3600)
  } else if (profile === 'cycling') {
    duration = distance / (15000 / 3600)
  } else {
    duration = route.duration
  }

  const walkingDuration = distance / (5000 / 3600)
  const drivingDuration: number = profile === 'driving' ? route.duration : distance / (50000 / 3600)

  const segments: RouteSegment[] = (route.legs ?? []).map(
    (leg: { distance: number; duration: number }, i: number): RouteSegment => {
      const from: [number, number] = [waypoints[i].lat, waypoints[i].lng]
      const to: [number, number] = [waypoints[i + 1].lat, waypoints[i + 1].lng]
      const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
      return {
        mid, from, to,
        walkingText: formatDuration(leg.distance / (5000 / 3600)),
        drivingText: formatDuration(leg.duration),
        distanceText: formatDistance(leg.distance),
        distanceM: leg.distance,
      }
    }
  )

  const result: RouteResult = {
    coordinates,
    distance,
    duration,
    distanceText: formatDistance(distance),
    durationText: formatDuration(duration),
    walkingText: formatDuration(walkingDuration),
    drivingText: formatDuration(drivingDuration),
    segments,
  }

  pruneRouteCache(now)
  routeCache.set(cacheKey, { result, fetchedAt: now })

  return result
}

/** Groups consecutive legs that share the same transport mode into batched OSRM calls.
 *  If all legs use the same mode, delegates to a single calculateRoute call.
 *  Parallel sub-calls each hit the per-profile cache, so re-routing the same day is cheap. */
export async function calculateMultiModeRoute(
  waypoints: Waypoint[],
  legModes: TransportMode[],
  { signal }: { signal?: AbortSignal } = {}
): Promise<RouteResult> {
  if (waypoints.length < 2 || legModes.length !== waypoints.length - 1) {
    throw new Error('legModes length must equal waypoints.length - 1')
  }

  // Fast path: all legs use the same mode
  if (legModes.every((m) => m === legModes[0])) {
    return calculateRoute(waypoints, legModes[0], { signal })
  }

  // Group consecutive legs by mode, sharing boundary waypoints between groups
  type RouteGroup = { waypoints: Waypoint[]; profile: TransportMode }
  const groups: RouteGroup[] = []
  let start = 0
  for (let i = 1; i < legModes.length; i++) {
    if (legModes[i] !== legModes[i - 1]) {
      groups.push({ waypoints: waypoints.slice(start, i + 1), profile: legModes[i - 1] })
      start = i
    }
  }
  groups.push({ waypoints: waypoints.slice(start), profile: legModes[legModes.length - 1] })

  const results = await Promise.all(groups.map((g) => calculateRoute(g.waypoints, g.profile, { signal })))

  // Concatenate geometry — skip the first coord of each subsequent group (duplicate junction point)
  const combinedCoordinates: [number, number][] = results.flatMap((r, i) =>
    i === 0 ? r.coordinates : r.coordinates.slice(1)
  )
  const combinedSegments: RouteSegment[] = results.flatMap((r) => r.segments ?? [])
  const totalDistance = results.reduce((sum, r) => sum + r.distance, 0)
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0)

  return {
    coordinates: combinedCoordinates,
    segments: combinedSegments,
    distance: totalDistance,
    duration: totalDuration,
    distanceText: formatDistance(totalDistance),
    durationText: formatDuration(totalDuration),
    walkingText: formatDuration(totalDistance / (5000 / 3600)),
    drivingText: formatDuration(totalDistance / (50000 / 3600)),
  }
}

/** Samples up to 100 evenly-spaced points from route coordinates and fetches their elevation. */
export async function fetchElevationForRoute(coordinates: [number, number][]): Promise<number[]> {
  if (coordinates.length === 0) return []
  const MAX_POINTS = 100
  const last = coordinates[coordinates.length - 1]
  const step = coordinates.length <= MAX_POINTS ? 1 : Math.ceil(coordinates.length / (MAX_POINTS - 1))
  const sampled: { latitude: number; longitude: number }[] = []
  for (let i = 0; i < coordinates.length; i += step) {
    if (sampled.length >= MAX_POINTS - 1) break
    sampled.push({ latitude: coordinates[i][0], longitude: coordinates[i][1] })
  }
  // Ensure last point is always included
  if (sampled[sampled.length - 1].latitude !== last[0] || sampled[sampled.length - 1].longitude !== last[1]) {
    sampled.push({ latitude: last[0], longitude: last[1] })
  }
  const data = await mapsApi.elevation(sampled)
  return (data.results as { elevation: number }[]).map(r => r.elevation)
}

export function generateGoogleMapsUrl(places: Waypoint[]): string | null {
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length === 0) return null
  if (valid.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${valid[0].lat},${valid[0].lng}`
  }
  const stops = valid.map((p) => `${p.lat},${p.lng}`).join('/')
  return `https://www.google.com/maps/dir/${stops}`
}

/** Reorders waypoints using a nearest-neighbor heuristic to minimize total Euclidean distance. */
export function optimizeRoute(places: Waypoint[]): Waypoint[] {
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length <= 2) return places

  const visited = new Set<number>()
  const result: Waypoint[] = []
  let current = valid[0]
  visited.add(0)
  result.push(current)

  while (result.length < valid.length) {
    let nearestIdx = -1
    let minDist = Infinity
    for (let i = 0; i < valid.length; i++) {
      if (visited.has(i)) continue
      const d = Math.sqrt(
        Math.pow(valid[i].lat - current.lat, 2) + Math.pow(valid[i].lng - current.lng, 2)
      )
      if (d < minDist) { minDist = d; nearestIdx = i }
    }
    if (nearestIdx === -1) break
    visited.add(nearestIdx)
    current = valid[nearestIdx]
    result.push(current)
  }
  return result
}

/** Fetches per-leg distance/duration from OSRM and returns segment metadata (midpoints, walking/driving times). */
export async function calculateSegments(
  waypoints: Waypoint[],
  { signal, profile = 'driving' }: { signal?: AbortSignal; profile?: TransportMode } = {}
): Promise<RouteSegment[]> {
  if (!waypoints || waypoints.length < 2) return []

  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/${profile}/${coords}?overview=false&geometries=geojson&steps=false&annotations=distance,duration`

  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('Route could not be calculated')

  const data = await response.json()
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('No route found')

  const legs = data.routes[0].legs
  return legs.map((leg: { distance: number; duration: number }, i: number): RouteSegment => {
    const from: [number, number] = [waypoints[i].lat, waypoints[i].lng]
    const to: [number, number] = [waypoints[i + 1].lat, waypoints[i + 1].lng]
    const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
    const walkingDuration = leg.distance / (5000 / 3600)
    return {
      mid, from, to,
      walkingText: formatDuration(walkingDuration),
      drivingText: formatDuration(leg.duration),
      distanceText: formatDistance(leg.distance),
      distanceM: leg.distance,
    }
  })
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`
  }
  return `${(meters / 1000).toFixed(1)} km`
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) {
    return `${h} h ${m} min`
  }
  return `${m} min`
}
