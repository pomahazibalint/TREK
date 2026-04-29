// Shared types for the TREK travel planner

export type TransportMode = 'walking' | 'cycling' | 'driving'

export interface User {
  id: number
  username: string
  email: string
  role: 'admin' | 'user'
  avatar_url: string | null
  maps_api_key: string | null
  created_at: string
  /** Present after load; true when TOTP MFA is enabled for password login */
  mfa_enabled?: boolean
  /** True when a password change is required before the user can continue */
  must_change_password?: boolean
}

export interface Trip {
  id: number
  title: string
  description: string | null
  start_date: string
  end_date: string
  currency: string
  cover_image: string | null
  is_archived: boolean
  reminder_days: number
  owner_id: number
  created_at: string
  updated_at: string
  has_foreign_currency_expenses?: number
  day_count?: number
  user_id?: number
  name?: string
  settled_at?: string | null
  settled_by?: number | null
  settled_by_username?: string | null
  missing_dates?: number
  budget_unsettled?: number
  empty_itinerary?: number
  upcoming_days?: number | null
}

export type TripBadgePriority = 'warning' | 'nudge'

export interface TripBadge {
  key: string
  priority: TripBadgePriority
  labelKey: string
  labelParams?: Record<string, string | number>
  detailKey: string
  actionKey: string
  actionPath: string
  actionCallback?: () => void
}

export interface TripUserSettings {
  add_to_calendar: number
}

export interface Day {
  id: number
  trip_id: number
  date: string
  title: string | null
  notes: string | null
  start_time: string | null
  end_time: string | null
  assignments: Assignment[]
  notes_items: DayNote[]
  day_number?: number
  order_index?: number
}

export interface Place {
  id: number
  trip_id: number
  name: string
  description: string | null
  lat: number | null
  lng: number | null
  address: string | null
  category_id: number | null
  icon: string | null
  price: number | null
  currency: string | null
  price_level: number | null
  image_url: string | null
  photo_url: string | null
  thumb_b64: string | null
  google_place_id: string | null
  osm_id: string | null
  route_geometry: string | null
  place_time: string | null
  end_time: string | null
  transport_mode: TransportMode
  duration_minutes: number | null
  phone: string | null
  website: string | null
  notes: string | null
  opening_hours: string[] | null
  created_at: string
  category?: string | null
}

export interface Assignment {
  id: number
  day_id: number
  place_id?: number
  order_index: number
  notes: string | null
  place: Place
  participants?: { user_id: number; username: string; avatar?: string | null }[]
}

export interface DayNote {
  id: number
  day_id: number
  text: string
  time: string | null
  icon: string | null
  sort_order?: number
  created_at: string
}

export interface PackingItem {
  id: number
  trip_id: number
  name: string
  category: string | null
  checked: number
  quantity: number
  bag_id?: number | null
  weight_grams?: number | null
}

export interface TodoItem {
  id: number
  trip_id: number
  name: string
  category: string | null
  checked: number
  sort_order: number
  due_date: string | null
  description: string | null
  assigned_user_id: number | null
  priority: number
}

export interface Tag {
  id: number
  name: string
  color: string | null
  user_id: number
}

export interface Category {
  id: number
  name: string
  icon: string | null
  user_id: number
  color?: string | null
}

export interface BudgetItem {
  id: number
  trip_id: number
  name: string
  total_price: number
  currency: string
  total_price_ref: number | null
  exchange_rate: number | null
  tip_ref: number
  category: string | null
  note: string | null
  sort_order: number
  reservation_id: number | null
  members: BudgetMember[]
  expense_date: string | null
}

export interface BudgetMember {
  user_id: number
  amount_owed: number
  amount_paid: number
  amount_owed_ref: number
  amount_paid_ref: number
  username?: string
  avatar_url?: string | null
}

export interface Reservation {
  id: number
  trip_id: number
  name: string
  title?: string
  type: string
  status: 'pending' | 'confirmed'
  date: string | null
  time: string | null
  reservation_time?: string | null
  reservation_end_time?: string | null
  location?: string | null
  confirmation_number: string | null
  notes: string | null
  url: string | null
  day_id?: number | null
  place_id?: number | null
  assignment_id?: number | null
  accommodation_id?: number | null
  day_plan_position?: number | null
  day_positions?: Record<string | number, number> | null
  accommodation_name?: string | null
  metadata?: Record<string, string> | string | null
  created_at: string
}

export interface TripFile {
  id: number
  trip_id: number
  place_id?: number | null
  reservation_id?: number | null
  note_id?: number | null
  uploaded_by?: number | null
  uploaded_by_name?: string | null
  uploaded_by_avatar?: string | null
  filename: string
  original_name: string
  file_size?: number | null
  mime_type: string
  description?: string | null
  starred?: number
  deleted_at?: string | null
  created_at: string
  reservation_title?: string
  linked_reservation_ids?: number[]
  linked_place_ids?: number[]
  url?: string
  assignment_id?: number | null
}

export interface Settings {
  map_tile_url: string
  default_lat: number
  default_lng: number
  default_zoom: number
  dark_mode: boolean | string
  default_currency: string
  language: string
  temperature_unit: string
  time_format: string
  show_place_description: boolean
  route_calculation?: boolean
  blur_booking_codes?: boolean
  dashboard_currency?: string
  dashboard_timezone?: string
}

export interface AssignmentsMap {
  [dayId: string]: Assignment[]
}

export interface DayNotesMap {
  [dayId: string]: DayNote[]
}

export interface RouteSegment {
  mid: [number, number]
  from: [number, number]
  to: [number, number]
  walkingText: string
  drivingText: string
  distanceText: string
  distanceM: number
  mode: TransportMode
  geometry: [number, number][]
}

export interface RouteResult {
  coordinates: [number, number][]
  distance: number
  duration: number
  distanceText: string
  durationText: string
  walkingText: string
  drivingText: string
  segments?: RouteSegment[]
  elevationProfile?: number[]
}

export interface Waypoint {
  lat: number
  lng: number
}

// User with optional OIDC fields
export interface UserWithOidc extends User {
  oidc_issuer?: string | null
}

// Accommodation type (day_accommodations joined with place data)
export interface Accommodation {
  id: number
  trip_id: number
  place_id: number
  start_day_id: number
  end_day_id: number
  check_in: string | null
  check_out: string | null
  confirmation: string | null
  notes: string | null
  place_name: string
  address: string | null
  lat: number | null
  lng: number | null
  created_at: string
}

// Trip member (owner or collaborator)
export interface TripMember {
  id: number
  username: string
  email?: string
  avatar_url?: string | null
  avatar?: string | null
  role?: string
}

// Photo type
export interface Photo {
  id: number
  trip_id: number
  filename: string
  original_name: string
  mime_type: string
  size: number
  file_size?: number | null
  caption: string | null
  place_id: number | null
  day_id: number | null
  taken_at: string | null
  latitude: number | null
  longitude: number | null
  city: string | null
  country: string | null
  camera_make: string | null
  camera_model: string | null
  width: number | null
  height: number | null
  user_id: number | null
  username: string | null
  user_avatar: string | null
  created_at: string
  url?: string
  // provider photos (Immich/Synology) adapted to this shape
  provider?: string
  asset_id?: string
}

// Atlas place detail
export interface AtlasPlace {
  id: number
  name: string
  lat: number | null
  lng: number | null
}

// GeoJSON types (simplified for atlas map)
export interface GeoJsonFeature {
  type: 'Feature'
  properties: Record<string, string | number | null | undefined>
  geometry: {
    type: string
    coordinates: unknown
  }
  id?: string
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

// App config from /auth/app-config
export interface AppConfig {
  has_users: boolean
  allow_registration: boolean
  demo_mode: boolean
  oidc_configured: boolean
  oidc_display_name?: string
  has_maps_key?: boolean
  allowed_file_types?: string
  timezone?: string
  /** When true, users without MFA cannot use the app until they enable it */
  require_mfa?: boolean
}

// Translation function type
export type TranslationFn = (key: string, params?: Record<string, string | number | null>) => string

// WebSocket event type
export interface WebSocketEvent {
  type: string
  [key: string]: unknown
}

// Vacay types
export interface VacayHolidayCalendar {
  id: number
  plan_id: number
  region: string
  label: string | null
  color: string
  sort_order: number
}

export interface VacayPlan {
  id: number
  name: string
  is_personal: boolean
  holidays_enabled: boolean
  holidays_region: string | null
  holiday_calendars: VacayHolidayCalendar[]
  block_weekends: boolean
  carry_over_enabled: boolean
  company_holidays_enabled: boolean
  owner_id?: number
  created_at?: string
  weekend_days?: string | null
}

export interface VacayPlanSummary {
  id: number
  name: string
  is_personal: boolean
  is_owner: boolean
  member_count: number
}

export interface VacayUser {
  id: number
  username: string
  color: string | null
}

export interface VacayEntry {
  date: string
  user_id: number
  plan_id?: number
  person_color?: string
  person_name?: string
  show_details?: number
  busy_only?: boolean
  note?: string | null
  event_name?: string | null
  location?: string | null
}

export interface VacayStat {
  user_id: number
  vacation_days: number
  used: number
  person_color?: string | null
  person_name?: string
  remaining?: number
  carried_over?: number
  username?: string
  avatar_url?: string | null
  color?: string | null
  total_available?: number
}

export interface HolidayInfo {
  name: string
  localName: string
  color: string
  label: string | null
}

export interface HolidaysMap {
  [date: string]: HolidayInfo
}

// API error shape from axios
export interface ApiError {
  response?: {
    data?: {
      error?: string
    }
    status?: number
  }
  message: string
}

/** Safely extract an error message from an unknown catch value */
export function getApiErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const apiErr = err as ApiError
    if (apiErr.response?.data?.error) return apiErr.response.data.error
  }
  if (err instanceof Error) return err.message
  return fallback
}

// MergedItem used in day notes hook
export type MergedItem =
  | { type: 'place'; sortKey: number; data: Assignment }
  | { type: 'note'; sortKey: number; data: DayNote }
  | { type: 'transport'; sortKey: number; data: Reservation; minutes?: number }
