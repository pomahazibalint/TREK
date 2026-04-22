import { useState, useEffect } from 'react'
import { tripsApi } from '../api/client'
import { concurrentMap } from '../utils/concurrentMap'
import type { Trip } from '../types'

export function useTripConflicts(trips: Trip[]): Map<number, string[]> {
  const [conflicts, setConflicts] = useState<Map<number, string[]>>(new Map())

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0]
    const eligible = trips.filter(t => t.start_date && t.end_date && t.end_date >= today)
    if (eligible.length === 0) return

    let cancelled = false
    concurrentMap(
      eligible,
      t => tripsApi.getCalendarConflicts(t.id)
        .then(data => ({ id: t.id, dates: (data.conflict_dates as string[]) || [] }))
        .catch(() => ({ id: t.id, dates: [] })),
      4
    ).then(results => {
      if (cancelled) return
      const map = new Map<number, string[]>()
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.dates.length > 0) {
          map.set(r.value.id, r.value.dates)
        }
      }
      setConflicts(map)
    })

    return () => { cancelled = true }
  }, [trips.map(t => t.id).join(',')])

  return conflicts
}
