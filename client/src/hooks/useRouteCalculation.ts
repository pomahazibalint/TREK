import { useState, useCallback, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { calculateMultiModeRoute, fetchElevationForRoute } from '../components/Map/RouteCalculator'
import type { TripStoreState } from '../store/tripStore'
import type { RouteSegment, RouteResult, TransportMode, Assignment } from '../types'

/**
 * Manages route calculation state for a selected day. Extracts geo-coded waypoints from
 * day assignments, fetches real road-following geometry from OSRM, and updates route and
 * per-segment duration labels. Falls back to straight lines if OSRM is unavailable.
 * Aborts in-flight requests when the day changes.
 */
export function useRouteCalculation(
  tripStore: TripStoreState,
  selectedDayId: number | null,
  transportMode: TransportMode = 'walking',
  elevationEnabled = true
) {
  const [route, setRoute] = useState<[number, number][] | null>(null)
  const [routeInfo, setRouteInfo] = useState<RouteResult | null>(null)
  const [routeSegments, setRouteSegments] = useState<RouteSegment[]>([])
  const routeCalcEnabled = useSettingsStore((s) => s.settings.route_calculation) !== false
  const routeAbortRef = useRef<AbortController | null>(null)
  // Keep a ref to the latest tripStore so updateRouteForDay never has a stale closure
  const tripStoreRef = useRef(tripStore)
  tripStoreRef.current = tripStore

  const updateRouteForDay = useCallback(async (dayId: number | null) => {
    if (routeAbortRef.current) routeAbortRef.current.abort()
    const currentAssignments = tripStoreRef.current.assignments || {}
    let da: Assignment[] = []
    if (dayId) {
      da = (currentAssignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    } else {
      const sortedDays = (tripStoreRef.current.days || []).slice().sort((a, b) => a.order_index - b.order_index)
      for (const d of sortedDays) {
        const dayAssignments = (currentAssignments[String(d.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
        da.push(...dayAssignments)
      }
    }
    const places = da.map((a) => a.place).filter((p) => p?.lat && p?.lng)
    if (places.length < 2) { setRoute(null); setRouteSegments([]); return }
    const waypoints = places.map((p) => ({ lat: p.lat!, lng: p.lng! }))
    if (!routeCalcEnabled) {
      setRoute(waypoints.map((p) => [p.lat, p.lng]))
      setRouteSegments([])
      return
    }
    // Each leg uses the destination place's transport_mode; fall back to the day default
    const legModes: TransportMode[] = places.slice(1).map((p) => (p.transport_mode || transportMode) as TransportMode)
    const controller = new AbortController()
    routeAbortRef.current = controller
    try {
      const result = await calculateMultiModeRoute(waypoints, legModes, { signal: controller.signal })
      if (!controller.signal.aborted) {
        setRoute(result.coordinates)
        setRouteSegments(result.segments ?? [])
        setRouteInfo(result)
        // Fetch elevation in the background and update routeInfo when ready
        if (elevationEnabled) {
          fetchElevationForRoute(result.coordinates).then(elevationProfile => {
            if (!controller.signal.aborted) {
              setRouteInfo(prev => prev ? { ...prev, elevationProfile } : null)
            }
          }).catch(() => {/* elevation is optional */})
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      // OSRM unavailable — fall back to straight lines so the map still shows something
      setRoute(waypoints.map((p) => [p.lat, p.lng]))
      setRouteSegments([])
      setRouteInfo(null)
    }
  }, [routeCalcEnabled, transportMode, elevationEnabled])

  // Recalculate when assignments change OR when transport mode changes
  const assignments = tripStore.assignments
  const days = (tripStore as any).days
  const selectedDayAssignments = selectedDayId ? assignments?.[String(selectedDayId)] : null
  useEffect(() => {
    updateRouteForDay(selectedDayId)
  }, [selectedDayId, selectedDayId ? selectedDayAssignments : assignments, updateRouteForDay, days])

  return { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay }
}
