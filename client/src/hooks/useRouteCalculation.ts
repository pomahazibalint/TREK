import { useState, useCallback, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { useTripStore } from '../store/tripStore'
import { calculateMultiModeRoute, fetchElevationForRoute, elevationCacheKey, getCachedElevation, setCachedElevation } from '../components/Map/RouteCalculator'
import type { TripStoreState } from '../store/tripStore'
import type { RouteSegment, RouteResult, TransportMode, Assignment, Waypoint } from '../types'

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
  const [isRecalculating, setIsRecalculating] = useState(false)
  const routeCalcEnabled = useSettingsStore((s) => s.settings.route_calculation) !== false
  const routeAbortRef = useRef<AbortController | null>(null)
  const lastDayIdRef = useRef<number | null>(null)
  // Track generation to know which calculation result is the most recent
  const calculationGenRef = useRef(0)
  // Track if a manual (forceMode) call is in progress to deprioritize reactive calls
  const forceModeInFlightRef = useRef(false)

  const updateRouteForDay = useCallback(async (dayId: number | null, forceMode?: TransportMode) => {
    // If a forceMode call is in flight and this is a reactive call (no forceMode), skip it silently
    if (!forceMode && forceModeInFlightRef.current) {
      return
    }

    const myGeneration = ++calculationGenRef.current
    const isForceMode = !!forceMode
    if (isForceMode) {
      forceModeInFlightRef.current = true
    }

    setIsRecalculating(true)
    try {
      const freshState = useTripStore.getState()
      const currentAssignments = freshState.assignments || {}
      let da: Assignment[] = []
      if (dayId) {
        da = (currentAssignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
      } else {
        const sortedDays = (freshState.days || []).slice().sort((a, b) => a.order_index - b.order_index)
        for (const d of sortedDays) {
          const dayAssignments = (currentAssignments[String(d.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
          da.push(...dayAssignments)
        }
      }
      const places = da.map((a) => a.place).filter((p) => p?.lat && p?.lng)
      if (places.length < 2) {
        if (myGeneration === calculationGenRef.current) {
          setRoute(null)
          setRouteSegments([])
        }
        return
      }
      const waypoints = places.map((p) => ({ lat: p.lat!, lng: p.lng! }))
      if (!routeCalcEnabled) {
        if (myGeneration === calculationGenRef.current) {
          setRoute(waypoints.map((p) => [p.lat, p.lng]))
          setRouteSegments([])
        }
        return
      }
      // When forceMode is provided (e.g., from handleTransportModeChange), use it for all legs.
      // Otherwise, each leg uses its place's transport_mode; fall back to the day default.
      // Use slice(0, -1) to get all places except the last (since N places have N-1 legs)
      const legModes: TransportMode[] = forceMode
        ? places.slice(0, -1).map(() => forceMode)
        : places.slice(0, -1).map((p) => (p.transport_mode || transportMode) as TransportMode)

      // Abort on day change, or if a forceMode call is starting and this is a reactive call
      if ((dayId !== lastDayIdRef.current || isForceMode) && routeAbortRef.current) {
        routeAbortRef.current.abort()
      }
      lastDayIdRef.current = dayId
      const controller = new AbortController()
      routeAbortRef.current = controller
      const result = await calculateMultiModeRoute(waypoints, legModes, { signal: controller.signal })

      // Only use result if this is the most recent calculation
      if (myGeneration === calculationGenRef.current && !controller.signal.aborted) {
        setRoute(result.coordinates)
        setRouteSegments(result.segments ?? [])
        setRouteInfo(result)
        if (elevationEnabled) {
          const elevKey = elevationCacheKey(waypoints, legModes)
          const cachedElev = getCachedElevation(elevKey)
          if (cachedElev) {
            setRouteInfo(prev => prev ? { ...prev, elevationProfile: cachedElev } : null)
          } else {
            fetchElevationForRoute(result.coordinates).then(elevationProfile => {
              if (!controller.signal.aborted && myGeneration === calculationGenRef.current) {
                setCachedElevation(elevKey, elevationProfile)
                setRouteInfo(prev => prev ? { ...prev, elevationProfile } : null)
              }
            }).catch(() => {/* elevation is optional */})
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      // OSRM unavailable — fall back to straight lines so the map still shows something
      if (myGeneration === calculationGenRef.current) {
        const freshState = useTripStore.getState()
        const currentAssignments = freshState.assignments || {}
        let da: Assignment[] = []
        if (dayId) {
          da = (currentAssignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
        } else {
          const sortedDays = (freshState.days || []).slice().sort((a, b) => a.order_index - b.order_index)
          for (const d of sortedDays) {
            const dayAssignments = (currentAssignments[String(d.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
            da.push(...dayAssignments)
          }
        }
        const places = da.map((a) => a.place).filter((p) => p?.lat && p?.lng)
        const waypoints = places.map((p) => ({ lat: p.lat!, lng: p.lng! }))
        setRoute(waypoints.map((p) => [p.lat, p.lng]))
        setRouteSegments([])
        setRouteInfo(null)
      }
    } finally {
      if (isForceMode) {
        forceModeInFlightRef.current = false
      }
      if (myGeneration === calculationGenRef.current) {
        setIsRecalculating(false)
      }
    }
  }, [routeCalcEnabled, elevationEnabled])

  // Recalculate when assignments change (transport mode changes via forceMode callback)
  const assignments = tripStore.assignments
  const days = (tripStore as any).days
  const selectedDayAssignments = selectedDayId ? assignments?.[String(selectedDayId)] : null
  useEffect(() => {
    updateRouteForDay(selectedDayId)
  }, [selectedDayId, selectedDayId ? selectedDayAssignments : assignments, updateRouteForDay, days])

  return { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay, isRecalculating }
}
