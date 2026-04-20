import type { Trip, TripBadge } from '../types'

export function computeTripBadges(trip: Trip, conflictDates?: string[], callbacks?: { onMissingDates?: () => void }): TripBadge[] {
  const today = new Date().toISOString().split('T')[0]
  const badges: TripBadge[] = []
  const tripId = trip.id

  if (trip.budget_unsettled) {
    badges.push({
      key: 'budgetUnsettled',
      priority: 'warning',
      labelKey: 'tripBadge.budgetUnsettled',
      detailKey: 'tripBadge.budgetUnsettled.detail',
      actionKey: 'tripBadge.budgetUnsettled.action',
      actionPath: `/trips/${tripId}?tab=budget`,
    })
  }

  if (conflictDates && conflictDates.length > 0) {
    badges.push({
      key: 'calendarConflict',
      priority: 'warning',
      labelKey: 'tripBadge.calendarConflict',
      detailKey: 'tripBadge.calendarConflict.detail',
      actionKey: 'tripBadge.calendarConflict.action',
      actionPath: '/vacay',
    })
  }

  if (trip.missing_dates) {
    badges.push({
      key: 'missingDates',
      priority: 'nudge',
      labelKey: 'tripBadge.missingDates',
      detailKey: 'tripBadge.missingDates.detail',
      actionKey: 'tripBadge.missingDates.action',
      actionPath: `/trips/${tripId}`,
      ...(callbacks?.onMissingDates ? { actionCallback: callbacks.onMissingDates } : {}),
    })
  }

  const isNotPast = !trip.end_date || trip.end_date >= today
  if (!trip.missing_dates && trip.empty_itinerary && isNotPast) {
    if (trip.upcoming_days !== null && trip.upcoming_days !== undefined) {
      badges.push({
        key: 'upcomingSoon',
        priority: 'nudge',
        labelKey: 'tripBadge.upcomingSoon',
        labelParams: { days: trip.upcoming_days },
        detailKey: 'tripBadge.upcomingSoon.detail',
        actionKey: 'tripBadge.upcomingSoon.action',
        actionPath: `/trips/${tripId}`,
      })
    } else {
      badges.push({
        key: 'emptyItinerary',
        priority: 'nudge',
        labelKey: 'tripBadge.emptyItinerary',
        detailKey: 'tripBadge.emptyItinerary.detail',
        actionKey: 'tripBadge.emptyItinerary.action',
        actionPath: `/trips/${tripId}`,
      })
    }
  }

  return badges
}
