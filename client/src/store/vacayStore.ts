import { create } from 'zustand'
import apiClient from '../api/client'
import type { AxiosResponse } from 'axios'
import type { VacayPlan, VacayPlanSummary, VacayUser, VacayEntry, VacayStat, HolidaysMap, HolidayInfo, VacayHolidayCalendar } from '../types'

const ax = apiClient

interface PendingInvite {
  id?: number
  user_id: number
  username: string
}

interface IncomingInvite {
  id?: number
  plan_id: number
  plan_name: string
  username?: string
}

interface VacayPlanResponse {
  plan: VacayPlan
  users: VacayUser[]
  pendingInvites: PendingInvite[]
  incomingInvites: IncomingInvite[]
  isOwner: boolean
  shareDetailsDefault: boolean
}

interface VacayYearsResponse {
  years: number[]
}

interface VacayEntriesResponse {
  entries: VacayEntry[]
  companyHolidays: string[]
}

interface VacayStatsResponse {
  stats: VacayStat[]
}

interface VacayHolidayRaw {
  date: string
  name: string
  localName: string
  global: boolean
  counties: string[] | null
}

function planUrl(planId: number) {
  return `/addons/vacay/plans/${planId}`
}

const api = {
  getPlans: (): Promise<{ plans: VacayPlanSummary[] }> =>
    ax.get('/addons/vacay/plans').then((r: AxiosResponse) => r.data),
  createPlan: (name: string): Promise<{ plan: VacayPlan }> =>
    ax.post('/addons/vacay/plans', { name }).then((r: AxiosResponse) => r.data),
  getPlan: (planId: number): Promise<VacayPlanResponse> =>
    ax.get(planUrl(planId)).then((r: AxiosResponse) => r.data),
  updatePlan: (planId: number, data: Partial<VacayPlan>): Promise<{ plan: VacayPlan }> =>
    ax.put(planUrl(planId), data).then((r: AxiosResponse) => r.data),
  updateColor: (planId: number, color: string, targetUserId?: number): Promise<unknown> =>
    ax.put(`${planUrl(planId)}/color`, { color, target_user_id: targetUserId }).then((r: AxiosResponse) => r.data),
  invite: (planId: number, userId: number): Promise<unknown> =>
    ax.post(`${planUrl(planId)}/invite`, { user_id: userId }).then((r: AxiosResponse) => r.data),
  acceptInvite: (planId: number): Promise<unknown> =>
    ax.post('/addons/vacay/invite/accept', { plan_id: planId }).then((r: AxiosResponse) => r.data),
  declineInvite: (planId: number): Promise<unknown> =>
    ax.post('/addons/vacay/invite/decline', { plan_id: planId }).then((r: AxiosResponse) => r.data),
  cancelInvite: (planId: number, userId: number): Promise<unknown> =>
    ax.post(`${planUrl(planId)}/invite/cancel`, { user_id: userId }).then((r: AxiosResponse) => r.data),
  leaveCalendar: (planId: number): Promise<unknown> =>
    ax.post(`${planUrl(planId)}/leave`).then((r: AxiosResponse) => r.data),
  availableUsers: (planId: number): Promise<{ users: VacayUser[] }> =>
    ax.get(`${planUrl(planId)}/available-users`).then((r: AxiosResponse) => r.data),
  getYears: (planId: number): Promise<VacayYearsResponse> =>
    ax.get(`${planUrl(planId)}/years`).then((r: AxiosResponse) => r.data),
  addYear: (planId: number, year: number): Promise<VacayYearsResponse> =>
    ax.post(`${planUrl(planId)}/years`, { year }).then((r: AxiosResponse) => r.data),
  removeYear: (planId: number, year: number): Promise<VacayYearsResponse> =>
    ax.delete(`${planUrl(planId)}/years/${year}`).then((r: AxiosResponse) => r.data),
  getEntries: (planId: number, year: number): Promise<VacayEntriesResponse> =>
    ax.get(`${planUrl(planId)}/entries/${year}`).then((r: AxiosResponse) => r.data),
  toggleEntry: (planId: number, date: string, targetUserId?: number): Promise<unknown> =>
    ax.post(`${planUrl(planId)}/entries/toggle`, { date, target_user_id: targetUserId }).then((r: AxiosResponse) => r.data),
  batchEntries: (planId: number, dates: string[], note: string | null, eventName: string | null, location: string | null, showDetails: number | null): Promise<unknown> => {
    const body: Record<string, unknown> = { dates }
    if (note !== null)        body.note = note
    if (eventName !== null)   body.event_name = eventName
    if (location !== null)    body.location = location
    if (showDetails !== null) body.show_details = showDetails
    return ax.post(`${planUrl(planId)}/entries/batch`, body).then((r: AxiosResponse) => r.data)
  },
  removeEntries: (planId: number, dates: string[]): Promise<unknown> =>
    ax.delete(`${planUrl(planId)}/entries/batch`, { data: { dates } }).then((r: AxiosResponse) => r.data),
  toggleCompanyHoliday: (planId: number, date: string): Promise<unknown> =>
    ax.post(`${planUrl(planId)}/entries/company-holiday`, { date }).then((r: AxiosResponse) => r.data),
  getStats: (planId: number, year: number): Promise<VacayStatsResponse> =>
    ax.get(`${planUrl(planId)}/stats/${year}`).then((r: AxiosResponse) => r.data),
  updateStats: (planId: number, year: number, days: number, targetUserId?: number): Promise<unknown> =>
    ax.put(`${planUrl(planId)}/stats/${year}`, { vacation_days: days, target_user_id: targetUserId }).then((r: AxiosResponse) => r.data),
  getCountries: (): Promise<{ countries: string[] }> =>
    ax.get('/addons/vacay/holidays/countries').then((r: AxiosResponse) => r.data),
  getHolidays: (year: number, country: string): Promise<VacayHolidayRaw[]> =>
    ax.get(`/addons/vacay/holidays/${year}/${country}`).then((r: AxiosResponse) => r.data),
  addHolidayCalendar: (planId: number, data: { region: string; color?: string; label?: string | null }): Promise<{ calendar: VacayHolidayCalendar }> =>
    ax.post(`${planUrl(planId)}/holiday-calendars`, data).then((r: AxiosResponse) => r.data),
  updateHolidayCalendar: (planId: number, id: number, data: { region?: string; color?: string; label?: string | null }): Promise<{ calendar: VacayHolidayCalendar }> =>
    ax.put(`${planUrl(planId)}/holiday-calendars/${id}`, data).then((r: AxiosResponse) => r.data),
  deleteHolidayCalendar: (planId: number, id: number): Promise<unknown> =>
    ax.delete(`${planUrl(planId)}/holiday-calendars/${id}`).then((r: AxiosResponse) => r.data),
  setShareDetailsDefault: (value: boolean): Promise<unknown> =>
    ax.put('/addons/vacay/settings/share-details-default', { value }).then((r: AxiosResponse) => r.data),
}

interface VacayState {
  plans: VacayPlanSummary[]
  selectedPlanId: number | null
  plan: VacayPlan | null
  users: VacayUser[]
  pendingInvites: PendingInvite[]
  incomingInvites: IncomingInvite[]
  isOwner: boolean
  shareDetailsDefault: boolean
  years: number[]
  entries: VacayEntry[]
  companyHolidays: string[]
  stats: VacayStat[]
  selectedYear: number
  selectedUserId: number | null
  holidays: HolidaysMap
  loading: boolean

  setSelectedYear: (year: number) => void
  setSelectedUserId: (id: number | null) => void
  loadPlans: () => Promise<void>
  selectPlan: (planId: number) => Promise<void>
  createPlan: (name: string) => Promise<number>
  loadPlan: () => Promise<void>
  updatePlan: (updates: Partial<VacayPlan>) => Promise<void>
  updateColor: (color: string, targetUserId?: number) => Promise<void>
  invite: (userId: number) => Promise<void>
  acceptInvite: (planId: number) => Promise<void>
  declineInvite: (planId: number) => Promise<void>
  cancelInvite: (userId: number) => Promise<void>
  leaveCalendar: () => Promise<void>
  loadYears: () => Promise<void>
  addYear: (year: number) => Promise<void>
  removeYear: (year: number) => Promise<void>
  loadEntries: (year?: number) => Promise<void>
  toggleEntry: (date: string, targetUserId?: number) => Promise<void>
  saveEntryDetails: (dates: string[], note: string | null, eventName: string | null, location: string | null, showDetails: number | null) => Promise<void>
  removeEntries: (dates: string[]) => Promise<void>
  toggleCompanyHoliday: (date: string) => Promise<void>
  loadStats: (year?: number) => Promise<void>
  updateVacationDays: (year: number, days: number, targetUserId?: number) => Promise<void>
  loadHolidays: (year?: number) => Promise<void>
  addHolidayCalendar: (data: { region: string; color?: string; label?: string | null }) => Promise<void>
  updateHolidayCalendar: (id: number, data: { region?: string; color?: string; label?: string | null }) => Promise<void>
  deleteHolidayCalendar: (id: number) => Promise<void>
  updateShareDetailsDefault: (value: boolean) => Promise<void>
  loadAll: () => Promise<void>
}

export const useVacayStore = create<VacayState>((set, get) => ({
  plans: [],
  selectedPlanId: null,
  plan: null,
  users: [],
  pendingInvites: [],
  incomingInvites: [],
  isOwner: true,
  shareDetailsDefault: true,
  years: [],
  entries: [],
  companyHolidays: [],
  stats: [],
  selectedYear: new Date().getFullYear(),
  selectedUserId: null,
  holidays: {},
  loading: false,

  setSelectedYear: (year: number) => set({ selectedYear: year }),
  setSelectedUserId: (id: number | null) => set({ selectedUserId: id }),

  loadPlans: async () => {
    const data = await api.getPlans()
    set({ plans: data.plans })
  },

  selectPlan: async (planId: number) => {
    set({ selectedPlanId: planId })
    await get().loadAll()
  },

  createPlan: async (name: string) => {
    const data = await api.createPlan(name)
    await get().loadPlans()
    return data.plan.id
  },

  loadPlan: async () => {
    const planId = get().selectedPlanId
    if (!planId) return
    const data = await api.getPlan(planId)
    set({
      plan: data.plan,
      users: data.users,
      pendingInvites: data.pendingInvites,
      incomingInvites: data.incomingInvites,
      isOwner: data.isOwner,
      shareDetailsDefault: data.shareDetailsDefault,
    })
  },

  updatePlan: async (updates: Partial<VacayPlan>) => {
    const planId = get().selectedPlanId
    if (!planId) return
    const data = await api.updatePlan(planId, updates)
    set({ plan: data.plan })
    await get().loadEntries()
    await get().loadStats()
    await get().loadHolidays()
  },

  updateColor: async (color: string, targetUserId?: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.updateColor(planId, color, targetUserId)
    await get().loadPlan()
    await get().loadEntries()
  },

  invite: async (userId: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.invite(planId, userId)
    await get().loadPlan()
  },

  acceptInvite: async (planId: number) => {
    await api.acceptInvite(planId)
    await get().loadPlans()
    await get().loadAll()
  },

  declineInvite: async (planId: number) => {
    await api.declineInvite(planId)
    await get().loadPlan()
  },

  cancelInvite: async (userId: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.cancelInvite(planId, userId)
    await get().loadPlan()
  },

  leaveCalendar: async () => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.leaveCalendar(planId)
    const plans = get().plans
    const remaining = plans.filter(p => p.id !== planId)
    const nextPlanId = remaining.length > 0 ? remaining[0].id : null
    set({ selectedPlanId: nextPlanId })
    await get().loadPlans()
    if (nextPlanId) await get().loadAll()
  },

  loadYears: async () => {
    const planId = get().selectedPlanId
    if (!planId) return
    const data = await api.getYears(planId)
    set({ years: data.years })
    if (data.years.length > 0) {
      set({ selectedYear: data.years[data.years.length - 1] })
    }
  },

  addYear: async (year: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    const data = await api.addYear(planId, year)
    set({ years: data.years })
    await get().loadStats(year)
  },

  removeYear: async (year: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    const data = await api.removeYear(planId, year)
    const updates: Partial<VacayState> = { years: data.years }
    if (get().selectedYear === year) {
      updates.selectedYear = data.years.length > 0
        ? data.years[data.years.length - 1]
        : new Date().getFullYear()
    }
    set(updates)
    await get().loadStats()
  },

  loadEntries: async (year?: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    const y = year || get().selectedYear
    const data = await api.getEntries(planId, y)
    set({ entries: data.entries, companyHolidays: data.companyHolidays })
  },

  toggleEntry: async (date: string, targetUserId?: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.toggleEntry(planId, date, targetUserId)
    await get().loadEntries()
    await get().loadStats()
  },

  saveEntryDetails: async (dates: string[], note: string | null, eventName: string | null, location: string | null, showDetails: number | null) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.batchEntries(planId, dates, note, eventName, location, showDetails)
    await get().loadEntries()
    await get().loadStats()
  },

  removeEntries: async (dates: string[]) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.removeEntries(planId, dates)
    await get().loadEntries()
    await get().loadStats()
  },

  toggleCompanyHoliday: async (date: string) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.toggleCompanyHoliday(planId, date)
    await get().loadEntries()
    await get().loadStats()
  },

  loadStats: async (year?: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    const y = year || get().selectedYear
    const data = await api.getStats(planId, y)
    set({ stats: data.stats })
  },

  updateVacationDays: async (year: number, days: number, targetUserId?: number) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.updateStats(planId, year, days, targetUserId)
    await get().loadStats(year)
  },

  loadHolidays: async (year?: number) => {
    const y = year || get().selectedYear
    const plan = get().plan
    const calendars = plan?.holiday_calendars ?? []
    if (!plan?.holidays_enabled || calendars.length === 0) {
      set({ holidays: {} })
      return
    }
    const map: HolidaysMap = {}
    for (const cal of calendars) {
      const country = cal.region.split('-')[0]
      const region = cal.region.includes('-') ? cal.region : null
      try {
        const data = await api.getHolidays(y, country)
        const hasRegions = data.some((h: VacayHolidayRaw) => h.counties && h.counties.length > 0)
        if (hasRegions && !region) continue
        data.forEach((h: VacayHolidayRaw) => {
          if (h.global || !h.counties || (region && h.counties.includes(region))) {
            if (!map[h.date]) {
              map[h.date] = { name: h.name, localName: h.localName, color: cal.color, label: cal.label } as HolidayInfo
            }
          }
        })
      } catch { /* API error, skip */ }
    }
    set({ holidays: map })
  },

  addHolidayCalendar: async (data) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.addHolidayCalendar(planId, data)
    await get().loadPlan()
    await get().loadHolidays()
  },

  updateHolidayCalendar: async (id, data) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.updateHolidayCalendar(planId, id, data)
    await get().loadPlan()
    await get().loadHolidays()
  },

  deleteHolidayCalendar: async (id) => {
    const planId = get().selectedPlanId
    if (!planId) return
    await api.deleteHolidayCalendar(planId, id)
    await get().loadPlan()
    await get().loadHolidays()
  },

  updateShareDetailsDefault: async (value: boolean) => {
    await api.setShareDetailsDefault(value)
    set({ shareDetailsDefault: value })
  },

  loadAll: async () => {
    set({ loading: true })
    try {
      await get().loadPlans()
      const state = get()
      if (!state.selectedPlanId && state.plans.length > 0) {
        set({ selectedPlanId: state.plans[0].id })
      }
      if (!get().selectedPlanId) return
      await get().loadPlan()
      await get().loadYears()
      const year = get().selectedYear
      await get().loadEntries(year)
      await get().loadStats(year)
      await get().loadHolidays(year)
    } finally {
      set({ loading: false })
    }
  },
}))
