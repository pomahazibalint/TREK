import { useState, useMemo, useEffect, useRef } from 'react'
import { PhotoLightbox } from './PhotoLightbox'
import { PhotoUpload } from './PhotoUpload'
import PhotoMapView from './PhotoMapView'
import { Upload, Camera, Grid, Map as MapIcon, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, X, MapPin } from 'lucide-react'
import Modal from '../shared/Modal'
import { getLocaleForLanguage, useTranslation } from '../../i18n'
import type { Photo, Place, Day, Assignment } from '../../types'

interface PhotoGalleryProps {
  photos: Photo[]
  onUpload?: (fd: FormData) => Promise<void>
  onDelete?: (photoId: number) => Promise<void>
  onUpdate?: (photoId: number, data: Partial<Photo>) => Promise<void>
  places: Place[]
  days: Day[]
  tripId: number
  onPhotoClick?: (photo: Photo, filteredPhotos: Photo[]) => void
  headerActions?: React.ReactNode
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function photoDate(p: Photo): string | null {
  const raw = p.taken_at || p.created_at
  if (!raw) return null
  try { return new Date(raw).toISOString().slice(0, 10) } catch { return null }
}

function photoTimeMinutes(p: Photo): number | null {
  const raw = p.taken_at
  if (!raw) return null
  try {
    const d = new Date(raw)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
  } catch { return null }
}

function assignmentTimeMinutes(a: Assignment): number | null {
  const t = a.place?.place_time
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  return isNaN(h) ? null : h * 60 + (m || 0)
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0')
  const m = (minutes % 60).toString().padStart(2, '0')
  return `${h}:${m}`
}

function formatDateLabel(date: string, locale: string): string {
  try {
    return new Date(date + 'T12:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  } catch { return date }
}

// ── Section model ─────────────────────────────────────────────────────────────

interface Section {
  key: string
  type: 'trip-day' | 'date-group' | 'undated'
  day?: Day
  date?: string
  photos: Photo[]
}

function buildSections(photos: Photo[], days: Day[]): Section[] {
  const dayById = new Map(days.map(d => [d.id, d]))
  const dayByDate = new Map(days.filter(d => d.date).map(d => [d.date, d]))
  const sections = new Map<string, Section>()

  // Most recent day first
  for (const day of [...days].reverse()) {
    const key = `day-${day.id}`
    sections.set(key, { key, type: 'trip-day', day, photos: [] })
  }

  const dateGroups = new Map<string, Section>()
  const undated: Section = { key: 'undated', type: 'undated', photos: [] }

  for (const p of photos) {
    if (p.day_id && dayById.has(p.day_id)) {
      sections.get(`day-${p.day_id}`)!.photos.push(p)
    } else {
      const date = photoDate(p)
      if (date && dayByDate.has(date)) {
        // Photo date matches a trip day — put it in that day's section
        sections.get(`day-${dayByDate.get(date)!.id}`)!.photos.push(p)
      } else if (date) {
        if (!dateGroups.has(date)) dateGroups.set(date, { key: `date-${date}`, type: 'date-group', date, photos: [] })
        dateGroups.get(date)!.photos.push(p)
      } else {
        undated.photos.push(p)
      }
    }
  }

  // Most recent date first
  const sortedDateGroups = [...dateGroups.values()].sort((a, b) => (a.date! < b.date! ? 1 : -1))

  const result = [...sections.values(), ...sortedDateGroups]
  if (undated.photos.length > 0) result.push(undated)
  return result
}

function defaultExpandedKey(sections: Section[]): string | null {
  // Sections are already in descending order — first one with photos is the most recent
  const withPhotos = sections.filter(s => s.photos.length > 0)
  if (withPhotos.length === 0) return null
  const tripDay = withPhotos.find(s => s.type === 'trip-day')
  return (tripDay ?? withPhotos[0]).key
}

// ── Timeline events ───────────────────────────────────────────────────────────

type TimelineEvent =
  | { kind: 'place'; assignment: Assignment; sortMinutes: number | null }
  | { kind: 'photo'; photo: Photo; sortMinutes: number | null }

function buildTimelineEvents(section: Section): TimelineEvent[] {
  const events: TimelineEvent[] = []

  if (section.day?.assignments) {
    for (const a of [...section.day.assignments].sort((x, y) => (x.order_index ?? 0) - (y.order_index ?? 0))) {
      events.push({ kind: 'place', assignment: a, sortMinutes: assignmentTimeMinutes(a) })
    }
  }

  for (const p of section.photos) {
    events.push({ kind: 'photo', photo: p, sortMinutes: photoTimeMinutes(p) })
  }

  return events.sort((a, b) => {
    if (a.sortMinutes !== null && b.sortMinutes !== null) return a.sortMinutes - b.sortMinutes
    if (a.sortMinutes !== null) return -1
    if (b.sortMinutes !== null) return 1
    // Both null: places before photos
    if (a.kind === 'place' && b.kind === 'photo') return -1
    if (a.kind === 'photo' && b.kind === 'place') return 1
    return 0
  })
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function locationLabel(p: Photo): string | null {
  const parts = [p.city, p.country].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

function applyFilters(
  photos: Photo[],
  filterDayIds: Set<number>,
  filterLocation: string,
  filterUploaders: Set<number>,
  filterDateFrom: string,
  filterDateTo: string,
): Photo[] {
  return photos.filter(p => {
    if (filterDayIds.size > 0 && (p.day_id == null || !filterDayIds.has(p.day_id))) return false
    if (filterLocation) {
      const loc = locationLabel(p)?.toLowerCase() ?? ''
      if (!loc.includes(filterLocation.toLowerCase())) return false
    }
    if (filterUploaders.size > 0 && (p.user_id == null || !filterUploaders.has(p.user_id))) return false
    if (filterDateFrom) {
      const d = photoDate(p)
      if (!d || d < filterDateFrom) return false
    }
    if (filterDateTo) {
      const d = photoDate(p)
      if (!d || d > filterDateTo) return false
    }
    return true
  })
}

// ── Section header label ──────────────────────────────────────────────────────

function sectionLabel(s: Section, places: Place[], locale: string): { title: string; subtitle: string | null } {
  if (s.type === 'undated') return { title: 'Undated', subtitle: null }

  if (s.type === 'date-group') {
    const title = formatDateLabel(s.date!, locale)
    const cities = [...new Set(s.photos.map(p => p.city).filter(Boolean))]
    return { title, subtitle: cities.slice(0, 2).join(', ') || null }
  }

  // trip-day
  const day = s.day!
  const dateStr = day.date ? formatDateLabel(day.date, locale) : null
  const title = `Day ${day.day_number ?? ''}${dateStr ? ' · ' + dateStr : ''}`

  // Subtitle: place names from assignments, or fallback to photo cities
  const assignedPlaceNames = (day.assignments || [])
    .map(a => a.place?.name)
    .filter(Boolean)
    .slice(0, 2)
  const subtitle = assignedPlaceNames.length
    ? assignedPlaceNames.join(', ')
    : [...new Set(s.photos.map(p => p.city).filter(Boolean))].slice(0, 2).join(', ') || null

  return { title, subtitle }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Avatar({ username, avatar, size = 20 }: { username: string | null; avatar?: string | null; size?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, fontWeight: 700, color: 'var(--text-muted)' }}>
      {avatar ? <img src={avatar} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" /> : (username?.[0] ?? '?').toUpperCase()}
    </div>
  )
}

function PhotoThumb({ photo, isSelected, onClick }: { photo: Photo; isSelected: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{ aspectRatio: '1', borderRadius: 10, overflow: 'hidden', cursor: 'pointer', position: 'relative', background: 'var(--bg-tertiary)', outline: isSelected ? '2px solid var(--accent)' : 'none', outlineOffset: 2 }}
      className="group"
    >
      <img src={photo.url} alt={photo.caption || photo.original_name}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.2s' }}
        className="group-hover:scale-105"
        loading="lazy"
        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0)', transition: 'background 0.2s' }} className="group-hover:bg-black/40">
        {(photo.caption || photo.city) && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '6px 8px', opacity: 0, transition: 'opacity 0.2s' }} className="group-hover:opacity-100">
            {photo.caption && <p style={{ color: '#fff', fontSize: 11, fontWeight: 600, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo.caption}</p>}
            {photo.city && <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 10, margin: 0 }}>{photo.city}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Location combobox ─────────────────────────────────────────────────────────

function LocationFilter({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  const [input, setInput] = useState(value)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setInput(value) }, [value])

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = options.filter(o => o.toLowerCase().includes(input.toLowerCase()))

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '5px 10px', fontSize: 13, background: value ? 'var(--accent)' : 'var(--bg-input)', color: value ? 'var(--accent-text)' : 'var(--text-primary)', cursor: 'text' }}>
        <MapPin size={13} style={{ flexShrink: 0 }} />
        <input
          value={input}
          onChange={e => { setInput(e.target.value); if (!e.target.value) onChange('') }}
          onFocus={() => setOpen(true)}
          placeholder="Location"
          style={{ border: 'none', outline: 'none', background: 'transparent', color: 'inherit', fontSize: 13, width: 90, fontFamily: 'inherit' }}
        />
        {value && <X size={13} style={{ cursor: 'pointer', flexShrink: 0 }} onClick={() => { onChange(''); setInput('') }} />}
      </div>
      {open && filtered.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 100, minWidth: 180, maxHeight: 200, overflowY: 'auto' }}>
          {filtered.map(o => (
            <div key={o} onMouseDown={() => { onChange(o); setInput(o); setOpen(false) }}
              style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', color: 'var(--text-primary)', background: o === value ? 'var(--bg-secondary)' : 'transparent' }}
              className="hover:bg-[var(--bg-secondary)]"
            >{o}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Day section (grid mode) ───────────────────────────────────────────────────

function DaySection({ section, expanded, onToggle, photos, places, days, onPhotoClick, locale }: {
  section: Section; expanded: boolean; onToggle: () => void
  photos: Photo[]; places: Place[]; days: Day[]
  onPhotoClick: (photo: Photo) => void; locale: string
}) {
  const { title, subtitle } = sectionLabel(section, places, locale)
  const count = photos.length

  return (
    <div style={{ border: '1px solid var(--border-primary)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', background: 'var(--bg-secondary)', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}
      >
        {expanded ? <ChevronDown size={16} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }} /> : <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: 2 }} />}
        <div style={{ flex: 1, minWidth: 0, paddingBottom: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
            <span style={{ fontSize: 12, color: 'var(--text-faint)', background: 'var(--bg-tertiary)', borderRadius: 20, padding: '1px 8px' }}>{count}</span>
          </div>
          {subtitle && <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{subtitle}</p>}
        </div>
      </button>
      {expanded && count > 0 && (
        <div style={{ padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
            {photos.map(p => (
              <PhotoThumb key={p.id} photo={p} isSelected={false} onClick={() => onPhotoClick(p)} />
            ))}
          </div>
        </div>
      )}
      {expanded && count === 0 && (
        <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--text-faint)', fontStyle: 'italic', textAlign: 'center' }}>No photos for this day</div>
      )}
    </div>
  )
}

// ── Timeline event row ────────────────────────────────────────────────────────

function TimelineEventRow({ event, onPhotoClick }: { event: TimelineEvent; onPhotoClick: (p: Photo) => void }) {
  const timeLabel = event.sortMinutes !== null ? formatTime(event.sortMinutes) : null

  if (event.kind === 'place') {
    const place = event.assignment.place
    return (
      <div style={{ display: 'flex', gap: 12, padding: '8px 0', alignItems: 'flex-start' }}>
        <div style={{ width: 36, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
          {timeLabel && <span style={{ fontSize: 10, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{timeLabel}</span>}
        </div>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0, marginTop: 6 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{place?.name}</span>
          {place?.category && <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 6 }}>{place.category}</span>}
        </div>
      </div>
    )
  }

  // photo event
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', alignItems: 'flex-start' }}>
      <div style={{ width: 36, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
        {timeLabel && <span style={{ fontSize: 10, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>{timeLabel}</span>}
      </div>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--border-primary)', flexShrink: 0, marginTop: 6 }} />
      <div
        onClick={() => onPhotoClick(event.photo)}
        style={{ width: 72, height: 72, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', flexShrink: 0, background: 'var(--bg-tertiary)' }}
        className="group"
      >
        <img src={event.photo.url} alt={event.photo.caption || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'transform 0.15s' }} className="group-hover:scale-105" loading="lazy" />
      </div>
      {event.photo.caption && (
        <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>{event.photo.caption}</span>
      )}
    </div>
  )
}

// ── Timeline day section ──────────────────────────────────────────────────────

function TimelineDaySection({ section, expanded, onToggle, filteredPhotos, places, days, onPhotoClick, locale }: {
  section: Section; expanded: boolean; onToggle: () => void
  filteredPhotos: Photo[]; places: Place[]; days: Day[]
  onPhotoClick: (photo: Photo) => void; locale: string
}) {
  const { title, subtitle } = sectionLabel(section, places, locale)
  const sectionWithFilteredPhotos = { ...section, photos: filteredPhotos }
  const events = buildTimelineEvents(sectionWithFilteredPhotos)
  const hasContent = events.length > 0

  return (
    <div style={{ borderLeft: '2px solid var(--border-primary)', paddingLeft: 16 }}>
      <button
        onClick={onToggle}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0 12px', fontFamily: 'inherit', textAlign: 'left' }}
      >
        {expanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{subtitle}</span>}
        <span style={{ fontSize: 11, color: 'var(--text-faint)', background: 'var(--bg-secondary)', borderRadius: 20, padding: '1px 7px' }}>{filteredPhotos.length}</span>
      </button>
      {expanded && hasContent && (
        <div style={{ paddingBottom: 16 }}>
          {events.map((ev, i) => (
            <TimelineEventRow key={i} event={ev} onPhotoClick={onPhotoClick} />
          ))}
        </div>
      )}
      {expanded && !hasContent && (
        <div style={{ paddingBottom: 16, fontSize: 13, color: 'var(--text-faint)', fontStyle: 'italic' }}>No content for this day</div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PhotoGallery({ photos, onUpload, onDelete, onUpdate, places, days, tripId, onPhotoClick: onPhotoClickProp, headerActions }: PhotoGalleryProps) {
  const { t, language } = useTranslation()
  const locale = getLocaleForLanguage(language)

  const [viewMode, setViewMode] = useState<'grid' | 'map'>('grid')
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [showUpload, setShowUpload] = useState(false)

  // Filters
  const [filterDayIds, setFilterDayIds] = useState<Set<number>>(new Set())
  const [filterLocation, setFilterLocation] = useState('')
  const [filterUploaders, setFilterUploaders] = useState<Set<number>>(new Set())
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')

  // Expanded sections
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const sectionsRef = useRef<Section[]>([])

  const allSections = useMemo(() => buildSections(photos, days), [photos, days])

  // Set default expansion when sections first load
  useEffect(() => {
    const defaultKey = defaultExpandedKey(allSections)
    setExpandedKeys(defaultKey ? new Set([defaultKey]) : new Set())
    sectionsRef.current = allSections
  }, [allSections.map(s => s.key).join(',')])

  const filteredPhotos = useMemo(
    () => applyFilters(photos, filterDayIds, filterLocation, filterUploaders, filterDateFrom, filterDateTo),
    [photos, filterDayIds, filterLocation, filterUploaders, filterDateFrom, filterDateTo]
  )

  const filteredSections = useMemo(() => {
    const filtered = buildSections(filteredPhotos, days)
    // Preserve all trip-day sections (even empty ones after filtering) so the structure stays stable
    return allSections.map(s => {
      const f = filtered.find(fs => fs.key === s.key)
      return f ?? { ...s, photos: [] }
    })
  }, [filteredPhotos, allSections, days])

  const handlePhotoClick = (photo: Photo) => {
    if (onPhotoClickProp) { onPhotoClickProp(photo, filteredPhotos); return }
    const idx = filteredPhotos.findIndex(p => p.id === photo.id)
    setLightboxIndex(idx >= 0 ? idx : null)
  }

  const handleDelete = async (photoId: number) => {
    await onDelete(photoId)
    if (lightboxIndex !== null) {
      const newLen = filteredPhotos.filter(p => p.id !== photoId).length
      if (newLen === 0) setLightboxIndex(null)
      else if (lightboxIndex >= newLen) setLightboxIndex(newLen - 1)
    }
  }

  const toggleSection = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const allExpanded = filteredSections.filter(s => s.photos.length > 0).every(s => expandedKeys.has(s.key))
  const toggleAll = () => {
    if (allExpanded) {
      setExpandedKeys(new Set())
    } else {
      setExpandedKeys(new Set(filteredSections.filter(s => s.photos.length > 0).map(s => s.key)))
    }
  }

  const clearFilters = () => {
    setFilterDayIds(new Set())
    setFilterLocation('')
    setFilterUploaders(new Set())
    setFilterDateFrom('')
    setFilterDateTo('')
  }

  const hasFilters = filterDayIds.size > 0 || filterLocation || filterUploaders.size > 0 || filterDateFrom || filterDateTo

  // Enumerate filter options from loaded photos
  const locationOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const p of photos) {
      const l = locationLabel(p)
      if (l) seen.add(l)
    }
    return [...seen].sort()
  }, [photos])

  const uploaderOptions = useMemo(() => {
    const seen = new Map<number, { username: string | null; avatar: string | null }>()
    for (const p of photos) {
      if (p.user_id != null && !seen.has(p.user_id)) {
        seen.set(p.user_id, { username: p.username, avatar: p.user_avatar })
      }
    }
    return [...seen.entries()].map(([id, u]) => ({ id, ...u }))
  }, [photos])

  const showUploaderFilter = uploaderOptions.length > 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ marginRight: 'auto' }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>Photos</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
            {filteredPhotos.length !== photos.length ? `${filteredPhotos.length} of ${photos.length}` : photos.length} {photos.length === 1 ? 'photo' : 'photos'}
          </p>
        </div>

        {/* View toggle */}
        <div style={{ display: 'flex', border: '1px solid var(--border-primary)', borderRadius: 8, overflow: 'hidden' }}>
          {(['grid', 'map'] as const).map(mode => (
            <button key={mode} onClick={() => setViewMode(mode)}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 500, background: viewMode === mode ? 'var(--accent)' : 'var(--bg-input)', color: viewMode === mode ? 'var(--accent-text)' : 'var(--text-muted)', transition: 'background 0.15s' }}
            >
              {mode === 'grid' ? <Grid size={14} /> : <MapIcon size={14} />}
              {mode === 'grid' ? 'Grid' : 'Map'}
            </button>
          ))}
        </div>

        {headerActions}
        {onUpload && (
          <button onClick={() => setShowUpload(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--accent)', color: 'var(--accent-text)', padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap' }}
          >
            <Upload size={14} /> {t('common.upload')}
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-faint,var(--border-primary))', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap', background: 'var(--bg-secondary)' }}>
        {/* Day filter */}
        {days.length > 0 && (
          <select
            value={filterDayIds.size === 1 ? [...filterDayIds][0] : ''}
            onChange={e => setFilterDayIds(e.target.value ? new Set([Number(e.target.value)]) : new Set())}
            style={{ border: `1px solid var(--border-primary)`, borderRadius: 8, padding: '5px 10px', fontSize: 13, background: filterDayIds.size > 0 ? 'var(--accent)' : 'var(--bg-input)', color: filterDayIds.size > 0 ? 'var(--accent-text)' : 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', outline: 'none' }}
          >
            <option value="">All days</option>
            {days.map(d => (
              <option key={d.id} value={d.id}>Day {d.day_number}{d.date ? ` · ${formatDateLabel(d.date, locale)}` : ''}</option>
            ))}
          </select>
        )}

        {/* Location filter */}
        {locationOptions.length > 0 && (
          <LocationFilter options={locationOptions} value={filterLocation} onChange={setFilterLocation} />
        )}

        {/* Uploader filter */}
        {showUploaderFilter && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {uploaderOptions.map(u => {
              const active = filterUploaders.has(u.id)
              return (
                <button key={u.id}
                  onClick={() => setFilterUploaders(prev => { const next = new Set(prev); active ? next.delete(u.id) : next.add(u.id); return next })}
                  title={u.username ?? undefined}
                  style={{ padding: 2, borderRadius: '50%', border: `2px solid ${active ? 'var(--accent)' : 'transparent'}`, background: 'none', cursor: 'pointer', display: 'flex' }}
                >
                  <Avatar username={u.username} avatar={u.avatar} size={22} />
                </button>
              )
            })}
          </div>
        )}

        {/* Date range */}
        <input type="date" value={filterDateFrom} onChange={e => setFilterDateFrom(e.target.value)}
          style={{ border: '1px solid var(--border-primary)', borderRadius: 8, padding: '5px 8px', fontSize: 12, background: filterDateFrom ? 'var(--accent)' : 'var(--bg-input)', color: filterDateFrom ? 'var(--accent-text)' : 'var(--text-muted)', fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}
          title="From date"
        />
        {(filterDateFrom || filterDateTo) && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>→</span>}
        <input type="date" value={filterDateTo} onChange={e => setFilterDateTo(e.target.value)}
          style={{ border: '1px solid var(--border-primary)', borderRadius: 8, padding: '5px 8px', fontSize: 12, background: filterDateTo ? 'var(--accent)' : 'var(--bg-input)', color: filterDateTo ? 'var(--accent-text)' : 'var(--text-muted)', fontFamily: 'inherit', outline: 'none', cursor: 'pointer' }}
          title="To date"
        />

        {/* Clear + expand/collapse all */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {hasFilters && (
            <button onClick={clearFilters}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border-primary)', borderRadius: 7, padding: '4px 9px', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <X size={12} /> Clear
            </button>
          )}
          {viewMode === 'grid' && (
            <button onClick={toggleAll}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)', background: 'none', border: '1px solid var(--border-primary)', borderRadius: 7, padding: '4px 9px', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              {allExpanded ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
      </div>

      {/* Map view */}
      {viewMode === 'map' && (
        <PhotoMapView photos={filteredPhotos} onPhotoClick={handlePhotoClick} />
      )}

      {/* Grid content — outer div scrolls, inner div lays out (prevents flex shrink on expand) */}
      {viewMode === 'grid' && <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filteredPhotos.length === 0 && !hasFilters ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-faint)' }}>
              <Camera size={40} style={{ color: 'var(--border-primary)', display: 'block', margin: '0 auto 12px' }} />
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('photos.noPhotos')}</p>
              <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: '0 0 20px' }}>{t('photos.uploadHint')}</p>
              <button onClick={() => setShowUpload(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--accent)', color: 'var(--accent-text)', padding: '10px 20px', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 600, fontFamily: 'inherit' }}
              >
                <Upload size={14} /> {t('common.upload')}
              </button>
            </div>
          ) : filteredPhotos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-faint)', fontSize: 13 }}>
              No photos match the current filters.
            </div>
          ) : (
            filteredSections.map(section => (
              <DaySection
                key={section.key}
                section={section}
                expanded={expandedKeys.has(section.key)}
                onToggle={() => toggleSection(section.key)}
                photos={section.photos}
                places={places}
                days={days}
                onPhotoClick={handlePhotoClick}
                locale={locale}
              />
            ))
          )}
        </div>
      </div>}

      {/* Lightbox — only for direct upload photos (provider photos use their own lightbox) */}
      {lightboxIndex !== null && !onPhotoClickProp && onDelete && onUpdate && (
        <PhotoLightbox
          photos={filteredPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onUpdate={onUpdate}
          onDelete={handleDelete}
          days={days}
          places={places}
          tripId={tripId}
        />
      )}

      {/* Upload modal */}
      {onUpload && (
        <Modal isOpen={showUpload} onClose={() => setShowUpload(false)} title={t('common.upload')} size="lg">
          <PhotoUpload
            tripId={tripId}
            days={days}
            places={places}
            onUpload={async fd => { await onUpload(fd); setShowUpload(false) }}
            onClose={() => setShowUpload(false)}
          />
        </Modal>
      )}
    </div>
  )
}
