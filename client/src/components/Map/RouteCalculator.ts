import type { RouteResult, RouteSegment, Waypoint, TransportMode } from '../../types'
import { mapsApi } from '../../api/client'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1'

// Client-side cache: same waypoints + profile → same OSRM geometry
const routeCache = new Map<string, { result: RouteResult; fetchedAt: number }>()
const ROUTE_CACHE_TTL = 10 * 60 * 1000 // 10 minutes
const ROUTE_CACHE_MAX = 200
const ROUTE_CACHE_PRUNE_TARGET = 100

// Elevation cache: survives route cache eviction, keyed by waypoints + all leg modes
const elevationCache = new Map<string, number[]>()

// Distance matrix cache: NxN arrays of durations and distances from OSRM table API
const matrixCache = new Map<string, { durations: number[][]; distances: number[][]; fetchedAt: number }>()
const MATRIX_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

export type DistanceMatrix = { durations: number[][]; distances: number[][] }

function routeCacheKey(waypoints: Waypoint[], profile: TransportMode): string {
  return `${profile}:${waypoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')}`
}

export function elevationCacheKey(waypoints: Waypoint[], modes: TransportMode[]): string {
  return `elev:${modes.join('+')}:${waypoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')}`
}

export function getCachedElevation(key: string): number[] | undefined {
  return elevationCache.get(key)
}

export function setCachedElevation(key: string, profile: number[]): void {
  elevationCache.set(key, profile)
}

/**
 * Splits a combined route geometry into per-leg slices by finding the closest
 * point in the coordinate array to each intermediate waypoint.
 * Searching forward from the previous split avoids backward matches and is O(n) total.
 */
function splitGeometryByWaypoints(
  coords: [number, number][],
  waypoints: Waypoint[]
): [number, number][][] {
  if (waypoints.length < 2) return [coords]
  const splitIndices: number[] = [0]
  let searchFrom = 0
  for (let i = 1; i < waypoints.length - 1; i++) {
    const wp = waypoints[i]
    let minDist = Infinity, bestIdx = searchFrom
    for (let j = searchFrom; j < coords.length; j++) {
      const d = (coords[j][0] - wp.lat) ** 2 + (coords[j][1] - wp.lng) ** 2
      if (d < minDist) { minDist = d; bestIdx = j }
    }
    splitIndices.push(bestIdx)
    searchFrom = bestIdx
  }
  splitIndices.push(coords.length - 1)
  return splitIndices.slice(0, -1).map((start, i) => coords.slice(start, splitIndices[i + 1] + 1))
}

/** Returns the geographic midpoint along a polyline by accumulated distance. */
export function geometryMidpoint(coords: [number, number][]): [number, number] {
  if (coords.length === 1) return coords[0]
  if (coords.length === 2) return [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2]
  let total = 0
  const segLengths: number[] = []
  for (let i = 1; i < coords.length; i++) {
    const d = Math.sqrt((coords[i][0] - coords[i - 1][0]) ** 2 + (coords[i][1] - coords[i - 1][1]) ** 2)
    segLengths.push(d)
    total += d
  }
  const half = total / 2
  let walked = 0
  for (let i = 0; i < segLengths.length; i++) {
    if (walked + segLengths[i] >= half) {
      const t = (half - walked) / segLengths[i]
      return [coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), coords[i][1] + t * (coords[i + 1][1] - coords[i][1])]
    }
    walked += segLengths[i]
  }
  return coords[coords.length - 1]
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
 *  Results are cached client-side for 10 minutes to reduce OSRM API load.
 *  Includes exponential backoff retry for transient network failures. */
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

  const osrmProfile = profile === 'walking' ? 'foot' : profile === 'cycling' ? 'bicycle' : 'car'
  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/${osrmProfile}/${coords}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`

  // Retry transient network failures with exponential backoff (up to 3 attempts)
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal })
      if (!response.ok) {
        throw new Error('Route could not be calculated')
      }

      const data = await response.json()
      if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
        throw new Error('No route found')
      }
      // Success — parse and cache
      const result = parseRouteResponse(data, waypoints, profile)
      pruneRouteCache(now)
      routeCache.set(cacheKey, { result, fetchedAt: now })
      return result
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Don't retry on abort signals or HTTP errors
      if (lastError.name === 'AbortError' || lastError.message === 'Route could not be calculated') {
        throw lastError
      }
      // For transient network errors, wait before retrying (exponential backoff)
      if (attempt < 2) {
        const delay = Math.pow(2, attempt) * 100 // 100ms, 200ms, 400ms
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }
  // All retries exhausted
  throw lastError || new Error('Failed to calculate route')
}

function parseRouteResponse(data: any, waypoints: Waypoint[], profile: TransportMode): RouteResult {
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

  const legGeometries = splitGeometryByWaypoints(coordinates, waypoints)
  const segments: RouteSegment[] = (route.legs ?? []).map(
    (leg: { distance: number; duration: number }, i: number): RouteSegment => {
      const from: [number, number] = [waypoints[i].lat, waypoints[i].lng]
      const to: [number, number] = [waypoints[i + 1].lat, waypoints[i + 1].lng]
      const geometry = legGeometries[i] ?? [from, to]
      const mid = geometryMidpoint(geometry)
      return {
        mid, from, to, geometry, mode: profile,
        walkingText: formatDuration(leg.distance / (5000 / 3600)),
        drivingText: formatDuration(leg.duration),
        distanceText: formatDistance(leg.distance),
        distanceM: leg.distance,
      }
    }
  )

  return {
    coordinates,
    distance,
    duration,
    distanceText: formatDistance(distance),
    durationText: formatDuration(duration),
    walkingText: formatDuration(walkingDuration),
    drivingText: formatDuration(drivingDuration),
    segments,
  }
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

function matrixCacheKey(waypoints: Waypoint[], profile: TransportMode): string {
  return `${profile}:${waypoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|')}`
}

export async function calculateDistanceMatrix(
  waypoints: Waypoint[],
  profile: TransportMode = 'driving',
  { signal }: { signal?: AbortSignal } = {}
): Promise<DistanceMatrix | null> {
  if (!waypoints || waypoints.length < 2) return null

  const now = Date.now()
  const cacheKey = matrixCacheKey(waypoints, profile)
  const cached = matrixCache.get(cacheKey)
  if (cached && now - cached.fetchedAt < MATRIX_CACHE_TTL) {
    return { durations: cached.durations, distances: cached.distances }
  }

  const osrmProfile = profile === 'walking' ? 'foot' : profile === 'cycling' ? 'bicycle' : 'car'
  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(';')
  const url = `${OSRM_BASE}/table/v1/${osrmProfile}/${coords}?annotations=duration,distance`

  try {
    const response = await fetch(url, { signal })
    if (!response.ok) return null

    const data = await response.json()
    if (data.code !== 'Ok' || !data.durations || !data.distances) return null

    // Replace null entries with Infinity
    const durations = (data.durations as (number | null)[][]).map(row =>
      row.map(d => d === null ? Infinity : d)
    )
    const distances = (data.distances as (number | null)[][]).map(row =>
      row.map(d => d === null ? Infinity : d)
    )

    matrixCache.set(cacheKey, { durations, distances, fetchedAt: now })
    return { durations, distances }
  } catch (err: unknown) {
    return null
  }
}

/** 2-opt local search: iteratively improves a tour by reversing segments. */
function twoOpt(tour: number[], dist: (i: number, j: number) => number): number[] {
  let improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < tour.length - 2; i++) {
      for (let k = i + 2; k < tour.length; k++) {
        const a = tour[i], b = tour[i + 1], c = tour[k], d = tour[(k + 1) % tour.length]
        const oldDist = dist(a, b) + dist(c, d)
        const newDist = dist(a, c) + dist(b, d)
        if (newDist < oldDist) {
          tour = [...tour.slice(0, i + 1), ...tour.slice(i + 1, k + 1).reverse(), ...tour.slice(k + 1)]
          improved = true
        }
      }
    }
  }
  return tour
}

/** Reorders waypoints using nearest-neighbor + 2-opt improvement. Optionally uses distance matrix. */
export function optimizeRoute(
  places: Waypoint[],
  matrix?: DistanceMatrix | null,
  startIndex = 0
): Waypoint[] {
  const valid = places.filter((p) => p.lat && p.lng)
  if (valid.length <= 2) return places

  // Distance function: use matrix if available, else Euclidean
  const dist = (i: number, j: number): number => {
    if (!matrix) {
      return Math.sqrt(
        Math.pow(valid[i].lat - valid[j].lat, 2) + Math.pow(valid[i].lng - valid[j].lng, 2)
      )
    }
    return matrix.distances[i][j]
  }

  // Nearest-neighbor from startIndex
  const visited = new Set<number>()
  const tour: number[] = []
  let current = startIndex
  visited.add(current)
  tour.push(current)

  while (tour.length < valid.length) {
    let nearestIdx = -1
    let minDist = Infinity
    for (let i = 0; i < valid.length; i++) {
      if (visited.has(i)) continue
      const d = dist(current, i)
      if (d < minDist) { minDist = d; nearestIdx = i }
    }
    if (nearestIdx === -1) break
    visited.add(nearestIdx)
    current = nearestIdx
    tour.push(current)
  }

  // Apply 2-opt improvement
  const improved = twoOpt(tour, dist)

  // Map indices back to places
  return improved.map(i => valid[i])
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
