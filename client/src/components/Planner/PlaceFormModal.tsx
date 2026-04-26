import { useState, useEffect, useRef, useMemo } from 'react'
import Modal from '../shared/Modal'
import CustomSelect from '../shared/CustomSelect'
import { mapsApi } from '../../api/client'
import { useAuthStore } from '../../store/authStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { useToast } from '../shared/Toast'
import { Search, Paperclip, X, AlertTriangle, Users } from 'lucide-react'
import { assignmentsApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import CustomTimePicker from '../shared/CustomTimePicker'
import PriceLevelBadge from '../shared/PriceLevelBadge'
import type { Place, Category, Assignment } from '../../types'

interface PlaceFormData {
  name: string
  description: string
  address: string
  lat: string | number | null
  lng: string | number | null
  category_id: string | number | null
  place_time: string
  end_time: string
  notes: string
  transport_mode: string
  website: string
  phone: string
  price: string | number | null
  currency: string
  price_level?: number | null
  duration_minutes: string | number | null
  google_place_id?: string
  osm_id?: string
  opening_hours?: string[] | null
  _pendingFiles?: File[]
}

const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CZK', 'PLN', 'SEK', 'NOK', 'DKK',
  'TRY', 'THB', 'AUD', 'CAD', 'NZD', 'BRL', 'MXN', 'INR', 'IDR', 'MYR',
  'PHP', 'SGD', 'KRW', 'CNY', 'HKD', 'TWD', 'ZAR', 'AED', 'SAR', 'ILS',
  'EGP', 'MAD', 'HUF', 'RON', 'BGN', 'ISK', 'UAH', 'BDT', 'LKR', 'VND',
  'CLP', 'COP', 'PEN', 'ARS',
]

const DEFAULT_FORM: PlaceFormData = {
  name: '',
  description: '',
  address: '',
  lat: '',
  lng: '',
  category_id: '',
  place_time: '',
  end_time: '',
  notes: '',
  transport_mode: 'walking',
  website: '',
  phone: '',
  price: '',
  currency: '',
  price_level: null,
  duration_minutes: '',
  google_place_id: '',
  osm_id: '',
}

interface TripMember { id: number; username: string; avatar_url?: string | null; avatar?: string | null }

interface PlaceFormModalProps {
  isOpen: boolean
  onClose: () => void
  onSave: (data: PlaceFormData, files?: File[]) => Promise<void> | void
  place: Place | null
  prefillCoords?: { lat: number; lng: number; name?: string; address?: string } | null
  tripId: number | string
  categories: Category[]
  onCategoryCreated: (category: Partial<Category>) => void | Category | Promise<Category | void>
  assignmentId: number | null
  dayAssignments?: Assignment[]
  tripMembers?: TripMember[]
  onSetParticipants?: (assignmentId: number, dayId: number, participantIds: number[]) => void
  focusPriceOnOpen?: boolean
}

export default function PlaceFormModal({
  isOpen, onClose, onSave, place, prefillCoords, tripId, categories,
  onCategoryCreated, assignmentId, dayAssignments = [],
  tripMembers = [], onSetParticipants, focusPriceOnOpen = false,
}: PlaceFormModalProps) {
  const [form, setForm] = useState(DEFAULT_FORM)
  const [mapsSearch, setMapsSearch] = useState('')
  const [mapsResults, setMapsResults] = useState([])
  const [isSearchingMaps, setIsSearchingMaps] = useState(false)
  const acAbortRef = useRef<AbortController | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [showNewCategory, setShowNewCategory] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [pendingFiles, setPendingFiles] = useState([])
  const [participantIds, setParticipantIds] = useState<number[]>([])
  const [draftEntryId, setDraftEntryId] = useState<number | null>(null)
  const [draftEntryIsConverted, setDraftEntryIsConverted] = useState(false)
  const fileRef = useRef(null)
  const priceRef = useRef<HTMLInputElement>(null)
  const [priceHighlighted, setPriceHighlighted] = useState(false)
  const toast = useToast()
  const { t, language } = useTranslation()
  const { hasMapsKey } = useAuthStore()
  const can = useCanDo()
  const tripObj = useTripStore((s) => s.trip)
  const canUploadFiles = can('file_upload', tripObj)

  useEffect(() => {
    if (place) {
      setForm({
        name: place.name || '',
        description: place.description || '',
        address: place.address || '',
        lat: place.lat != null ? String(place.lat) : '',
        lng: place.lng != null ? String(place.lng) : '',
        category_id: place.category_id != null ? String(place.category_id) : '',
        place_time: place.place_time || '',
        end_time: place.end_time || '',
        notes: place.notes || '',
        transport_mode: place.transport_mode || 'walking',
        website: place.website || '',
        phone: place.phone || '',
        price: place.price != null ? String(place.price) : '',
        currency: place.currency || '',
        price_level: place.price_level ?? null,
        duration_minutes: place.duration_minutes != null ? String(place.duration_minutes) : '',
      })
    } else if (prefillCoords) {
      setForm({
        ...DEFAULT_FORM,
        lat: String(prefillCoords.lat),
        lng: String(prefillCoords.lng),
        name: prefillCoords.name || '',
        address: prefillCoords.address || '',
      })
    } else {
      setForm(DEFAULT_FORM)
    }
    setPendingFiles([])
    const curAssignment = assignmentId ? dayAssignments.find(a => a.id === assignmentId) : null
    setParticipantIds((curAssignment as any)?.participants?.map((p: any) => p.user_id) || [])

    // In assignment context: load draft entry price instead of place.price
    const draftId = (curAssignment as any)?.draft_budget_entry_id ?? null
    setDraftEntryId(draftId)
    setDraftEntryIsConverted((curAssignment as any)?.budget_entry_is_draft === 0)
    if (assignmentId && draftId) {
      const draftPrice = (curAssignment as any)?.budget_entry_price
      const draftCurrency = (curAssignment as any)?.budget_entry_currency
      if (draftPrice != null) setForm(f => ({ ...f, price: String(draftPrice), currency: draftCurrency || f.currency }))
    } else if (assignmentId && !draftId) {
      // No draft yet — clear price field so user starts fresh per-visit
      setForm(f => ({ ...f, price: '' }))
    }
  }, [place, prefillCoords, isOpen])

  useEffect(() => {
    if (!focusPriceOnOpen || !isOpen) return
    const scrollId = setTimeout(() => {
      priceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      priceRef.current?.focus()
      priceRef.current?.select()
      setPriceHighlighted(true)
    }, 250)
    const clearId = setTimeout(() => setPriceHighlighted(false), 2500)
    return () => { clearTimeout(scrollId); clearTimeout(clearId) }
  }, [focusPriceOnOpen, isOpen])

  useEffect(() => {
    const trimmed = mapsSearch.trim()
    if (!trimmed || trimmed.length < 2) {
      setMapsResults([])
      return
    }
    const id = setTimeout(async () => {
      acAbortRef.current?.abort()
      const controller = new AbortController()
      acAbortRef.current = controller
      setIsSearchingMaps(true)
      try {
        const result = await mapsApi.autocomplete(trimmed, language, controller.signal)
        setMapsResults(result.places || [])
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'CanceledError' && (err as { name?: string }).name !== 'AbortError') {
          setMapsResults([])
        }
      } finally {
        setIsSearchingMaps(false)
      }
    }, 300)
    return () => clearTimeout(id)
  }, [mapsSearch, language])

  const handleChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const handleMapsSearch = async () => {
    if (!mapsSearch.trim()) return
    setIsSearchingMaps(true)
    try {
      // Detect Google Maps URLs and resolve them directly
      const trimmed = mapsSearch.trim()
      if (trimmed.match(/^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl)/i)) {
        const resolved = await mapsApi.resolveUrl(trimmed)
        if (resolved.lat && resolved.lng) {
          setForm(prev => ({
            ...prev,
            name: resolved.name || prev.name,
            address: resolved.address || prev.address,
            lat: String(resolved.lat),
            lng: String(resolved.lng),
          }))
          setMapsResults([])
          setMapsSearch('')
          toast.success(t('places.urlResolved'))
          return
        }
      }
      const result = await mapsApi.search(mapsSearch, language)
      setMapsResults(result.places || [])
    } catch (err: unknown) {
      toast.error(t('places.mapsSearchError'))
    } finally {
      setIsSearchingMaps(false)
    }
  }

  const handleSelectMapsResult = async (result) => {
    acAbortRef.current?.abort()
    setMapsResults([])
    setMapsSearch('')

    // Google autocomplete predictions have no lat/lng — resolve via details
    if (result.google_place_id && !result.lat) {
      setIsSearchingMaps(true)
      try {
        const { place } = await mapsApi.details(result.google_place_id, language)
        setForm(prev => ({
          ...prev,
          name: place.name || result.name || prev.name,
          address: place.address || result.address || prev.address,
          lat: place.lat || prev.lat,
          lng: place.lng || prev.lng,
          google_place_id: result.google_place_id,
          website: place.website || prev.website,
          phone: place.phone || prev.phone,
          price_level: place.price_level ?? prev.price_level,
          opening_hours: place.opening_hours || null,
        }))
      } catch {
        toast.error(t('places.mapsSearchError'))
      } finally {
        setIsSearchingMaps(false)
      }
      return
    }

    setForm(prev => ({
      ...prev,
      name: result.name || prev.name,
      address: result.address || prev.address,
      lat: result.lat || prev.lat,
      lng: result.lng || prev.lng,
      google_place_id: result.google_place_id || prev.google_place_id,
      osm_id: result.osm_id || prev.osm_id,
      website: result.website || prev.website,
      phone: result.phone || prev.phone,
      price_level: result.price_level ?? prev.price_level,
      opening_hours: result.opening_hours || null,
    }))
  }

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return
    try {
      const cat = await onCategoryCreated?.({ name: newCategoryName, color: '#6366f1', icon: 'MapPin' })
      if (cat) setForm(prev => ({ ...prev, category_id: cat.id }))
      setNewCategoryName('')
      setShowNewCategory(false)
    } catch (err: unknown) {
      toast.error(t('places.categoryCreateError'))
    }
  }

  const handleFileAdd = (e) => {
    const files = Array.from((e.target as HTMLInputElement).files || [])
    setPendingFiles(prev => [...prev, ...files])
    e.target.value = ''
  }

  const handleRemoveFile = (idx) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx))
  }

  // Paste support for files/images
  const handlePaste = (e) => {
    if (!canUploadFiles) return
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of Array.from(items) as DataTransferItem[]) {
      if (item.type.startsWith('image/') || item.type === 'application/pdf') {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) setPendingFiles(prev => [...prev, file])
        return
      }
    }
  }

  const handleToggleParticipant = (userId: number) => {
    if (!onSetParticipants || !assignmentId) return
    const curAssignment = dayAssignments.find(a => a.id === assignmentId)
    if (!curAssignment) return
    const isAllGoing = participantIds.length === 0
    let newIds: number[]
    if (isAllGoing) {
      newIds = tripMembers.filter(m => m.id !== userId).map(m => m.id)
    } else if (participantIds.includes(userId)) {
      newIds = participantIds.filter(id => id !== userId)
      if (newIds.length === 0) return // keep at least one
    } else {
      newIds = [...participantIds, userId]
      if (newIds.length >= tripMembers.length) newIds = []
    }
    setParticipantIds(newIds)
    onSetParticipants(assignmentId, curAssignment.day_id, newIds)
  }

  const hasTimeError = place && form.place_time && form.end_time && form.place_time.length >= 5 && form.end_time.length >= 5 && form.end_time <= form.place_time

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      toast.error(t('places.nameRequired'))
      return
    }
    setIsSaving(true)
    try {
      const priceVal = form.price !== '' && form.price != null ? parseFloat(String(form.price)) : null

      // In assignment context: route price to draft entry, not place
      if (assignmentId && !draftEntryIsConverted) {
        const draftResult = await assignmentsApi.setDraftPrice(tripId, assignmentId, priceVal, form.currency || null)
        // Patch the assignment in the store immediately without waiting for WebSocket
        useTripStore.setState(state => {
          const newAssignments: typeof state.assignments = {}
          for (const [dayKey, list] of Object.entries(state.assignments)) {
            newAssignments[dayKey] = list.map(a => a.id === assignmentId ? { ...a, ...draftResult } : a)
          }
          return { assignments: newAssignments }
        })
        setDraftEntryId(draftResult.draft_budget_entry_id)
        setDraftEntryIsConverted(draftResult.budget_entry_is_draft === 0)
      }

      await onSave({
        ...form,
        lat: form.lat !== '' && form.lat != null ? parseFloat(String(form.lat)) : null,
        lng: form.lng !== '' && form.lng != null ? parseFloat(String(form.lng)) : null,
        category_id: form.category_id || null,
        // Don't write price to place when in assignment context
        price: assignmentId ? null : priceVal,
        duration_minutes: form.duration_minutes !== '' && form.duration_minutes != null ? parseInt(String(form.duration_minutes), 10) : null,
        _pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
      })
      onClose()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('places.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={place ? t('places.editPlace') : t('places.addPlace')}
      size="lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4" onPaste={handlePaste}>
        {/* Place Search */}
        <div className="bg-slate-50 rounded-xl p-3 border border-slate-200">
          {!hasMapsKey && (
            <p className="mb-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              {t('places.osmActive')}
            </p>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={mapsSearch}
              onChange={e => setMapsSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleMapsSearch())}
              placeholder={t('places.mapsSearchPlaceholder')}
              className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 bg-white"
            />
            <button
              type="button"
              onClick={handleMapsSearch}
              disabled={isSearchingMaps}
              className="bg-slate-900 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-slate-700 disabled:opacity-60"
            >
              {isSearchingMaps ? '...' : <Search className="w-4 h-4" />}
            </button>
          </div>
          {mapsResults.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 overflow-hidden max-h-40 overflow-y-auto mt-2">
              {mapsResults.map((result, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSelectMapsResult(result)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-0"
                >
                  <div className="font-medium text-sm">{result.name}</div>
                  <div className="text-xs text-slate-500 truncate">{result.address}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formName')} *</label>
          <input
            type="text"
            value={form.name}
            onChange={e => handleChange('name', e.target.value)}
            required
            placeholder={t('places.formNamePlaceholder')}
            className="form-input"
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formDescription')}</label>
          <textarea
            value={form.description}
            onChange={e => handleChange('description', e.target.value)}
            rows={2}
            placeholder={t('places.formDescriptionPlaceholder')}
            className="form-input" style={{ resize: 'none' }}
          />
        </div>

        {/* Address + Coordinates */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formAddress')}</label>
          <input
            type="text"
            value={form.address}
            onChange={e => handleChange('address', e.target.value)}
            placeholder={t('places.formAddressPlaceholder')}
            className="form-input"
          />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <input
              type="number"
              step="any"
              value={form.lat}
              onChange={e => handleChange('lat', e.target.value)}
              onPaste={e => {
                const text = e.clipboardData.getData('text').trim()
                const match = text.match(/^(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)$/)
                if (match) {
                  e.preventDefault()
                  handleChange('lat', match[1])
                  handleChange('lng', match[2])
                }
              }}
              placeholder={t('places.formLat')}
              className="form-input"
            />
            <input
              type="number"
              step="any"
              value={form.lng}
              onChange={e => handleChange('lng', e.target.value)}
              placeholder={t('places.formLng')}
              className="form-input"
            />
          </div>
        </div>

        {/* Category */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formCategory')}</label>
          {!showNewCategory ? (
            <div className="flex gap-2">
              <CustomSelect
                value={form.category_id != null ? String(form.category_id) : ''}
                onChange={value => handleChange('category_id', value)}
                placeholder={t('places.noCategory')}
                options={[
                  { value: '', label: t('places.noCategory') },
                  ...(categories || []).map(c => ({
                    value: String(c.id),
                    label: c.name,
                  })),
                ]}
                style={{ flex: 1 }}
                size="sm"
              />
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={newCategoryName}
                onChange={e => setNewCategoryName(e.target.value)}
                placeholder={t('places.categoryNamePlaceholder')}
                className="form-input" style={{ flex: 1 }}
              />
              <button type="button" onClick={handleCreateCategory} className="bg-slate-900 text-white px-3 rounded-lg hover:bg-slate-700 text-sm">
                OK
              </button>
              <button type="button" onClick={() => setShowNewCategory(false)} className="text-gray-500 px-2 text-sm">
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>

        {/* Time — only shown when editing, not when creating */}
        {place && (
          <TimeSection
            form={form}
            handleChange={handleChange}
            assignmentId={assignmentId}
            dayAssignments={dayAssignments}
            hasTimeError={hasTimeError}
            t={t}
          />
        )}

        {/* Website */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formWebsite')}</label>
          <input
            type="url"
            value={form.website}
            onChange={e => handleChange('website', e.target.value)}
            placeholder="https://..."
            className="form-input"
          />
        </div>

        {/* Phone */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formPhone') || 'Phone'}</label>
          <input
            type="tel"
            value={form.phone}
            onChange={e => handleChange('phone', e.target.value)}
            placeholder="+1 234 567 8900"
            className="form-input"
          />
        </div>

        {/* Price + Currency */}
        <div style={{ borderRadius: 6, boxShadow: priceHighlighted ? '0 0 0 2px rgba(217,119,6,0.45)' : '0 0 0 0 transparent', transition: 'box-shadow 0.6s ease' }}>
          <label className="block text-sm font-medium mb-1" style={{ color: priceHighlighted ? '#d97706' : undefined, transition: 'color 0.4s', marginTop: 0 }}>
            {assignmentId ? (t('places.formPriceVisit') || 'Price (this visit)') : (t('places.formPrice') || 'Price')}
          </label>
          <div className="grid grid-cols-3 gap-2 items-center">
            <input
              ref={priceRef}
              type="number"
              min="0"
              step="any"
              value={form.price}
              onChange={e => handleChange('price', e.target.value)}
              placeholder="0.00"
              className="form-input col-span-2"
            />
            <select
              value={form.currency || tripObj?.currency || 'EUR'}
              onChange={e => handleChange('currency', e.target.value)}
              className="form-input"
            >
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            {form.price_level != null && (
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Google price level:</span>
                <PriceLevelBadge level={form.price_level} variant="chip" />
              </div>
            )}
          </div>
        </div>

        {/* Duration */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formDuration') || 'Estimated visit duration (min)'}</label>
          <input
            type="number"
            min="0"
            step="1"
            value={form.duration_minutes}
            onChange={e => handleChange('duration_minutes', e.target.value)}
            placeholder="60"
            className="form-input"
          />
        </div>

        {/* Transport Mode */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.formTransportMode') || 'Getting here by'}</label>
          <div className="flex gap-2">
            {[
              { value: 'walking', label: t('places.transportWalking') || 'Walking' },
              { value: 'cycling', label: t('places.transportCycling') || 'Cycling' },
              { value: 'driving', label: t('places.transportDriving') || 'Driving' },
            ].map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleChange('transport_mode', opt.value)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${form.transport_mode === opt.value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Participants */}
        {assignmentId && tripMembers.length > 1 && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Users size={14} /> {t('places.whoIsGoing') || "Who's going?"}
            </label>
            <div className="flex flex-wrap gap-2">
              {tripMembers.map(member => {
                const active = participantIds.length === 0 || participantIds.includes(member.id)
                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => handleToggleParticipant(member.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all"
                    style={{
                      background: active ? 'var(--bg-hover)' : 'transparent',
                      borderColor: active ? 'var(--accent)' : 'var(--border-primary)',
                      color: active ? 'var(--text-primary)' : 'var(--text-faint)',
                      opacity: active ? 1 : 0.5,
                    }}
                  >
                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 700, color: 'var(--text-muted)', overflow: 'hidden', flexShrink: 0 }}>
                      {(member.avatar_url || member.avatar)
                        ? <img src={member.avatar_url || `/uploads/avatars/${member.avatar}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                        : member.username?.[0]?.toUpperCase()}
                    </div>
                    {member.username}
                  </button>
                )
              })}
            </div>
            {participantIds.length === 0 && (
              <p className="text-xs mt-1.5" style={{ color: 'var(--text-faint)' }}>{t('places.everyoneGoing') || 'Everyone is going — tap to exclude someone'}</p>
            )}
          </div>
        )}

        {/* File Attachments */}
        {canUploadFiles && (
          <div className="border border-gray-200 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">{t('files.title')}</label>
              <button type="button" onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 transition-colors">
                <Paperclip size={12} /> {t('files.attach')}
              </button>
            </div>
            <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileAdd} />
            {pendingFiles.length > 0 && (
              <div className="space-y-1">
                {pendingFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50 text-xs">
                    <Paperclip size={10} className="text-slate-400 shrink-0" />
                    <span className="truncate flex-1 text-slate-600">{file.name}</span>
                    <button type="button" onClick={() => handleRemoveFile(idx)} className="text-slate-400 hover:text-red-500 shrink-0">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {pendingFiles.length === 0 && (
              <p className="text-xs text-slate-400">{t('files.pasteHint')}</p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={isSaving || hasTimeError}
            className="px-6 py-2 bg-slate-900 text-white text-sm rounded-lg hover:bg-slate-700 disabled:opacity-60 font-medium"
          >
            {isSaving ? t('common.saving') : place ? t('common.update') : t('common.add')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface TimeSectionProps {
  form: PlaceFormData
  handleChange: (field: string, value: string) => void
  assignmentId: number | null
  dayAssignments: Assignment[]
  hasTimeError: boolean
  t: (key: string, params?: Record<string, string | number>) => string
}

function TimeSection({ form, handleChange, assignmentId, dayAssignments, hasTimeError, t }: TimeSectionProps) {

  const collisions = useMemo(() => {
    if (!assignmentId || !form.place_time || form.place_time.length < 5) return []
    // Find the day_id for the current assignment
    const current = dayAssignments.find(a => a.id === assignmentId)
    if (!current) return []
    const myStart = form.place_time
    const myEnd = form.end_time && form.end_time.length >= 5 ? form.end_time : null
    return dayAssignments.filter(a => {
      if (a.id === assignmentId) return false
      if (a.day_id !== current.day_id) return false
      const aStart = a.place?.place_time
      const aEnd = a.place?.end_time
      if (!aStart) return false
      // Check overlap: two intervals overlap if start < otherEnd AND otherStart < end
      const s1 = myStart, e1 = myEnd || myStart
      const s2 = aStart, e2 = aEnd || aStart
      return s1 < (e2 || '23:59') && s2 < (e1 || '23:59') && s1 !== e2 && s2 !== e1
    })
  }, [assignmentId, dayAssignments, form.place_time, form.end_time])

  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.startTime')}</label>
          <CustomTimePicker
            value={form.place_time}
            onChange={v => handleChange('place_time', v)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('places.endTime')}</label>
          <CustomTimePicker
            value={form.end_time}
            onChange={v => handleChange('end_time', v)}
          />
        </div>
      </div>
      {hasTimeError && (
        <div className="flex items-center gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-warning, #fef3c7)', color: 'var(--text-warning, #92400e)' }}>
          <AlertTriangle size={13} className="shrink-0" />
          {t('places.endTimeBeforeStart')}
        </div>
      )}
      {collisions.length > 0 && (
        <div className="flex items-start gap-1.5 mt-2 px-2.5 py-1.5 rounded-lg text-xs" style={{ background: 'var(--bg-warning, #fef3c7)', color: 'var(--text-warning, #92400e)' }}>
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>
            {t('places.timeCollision')}{' '}
            {collisions.map(a => a.place?.name).filter(Boolean).join(', ')}
          </span>
        </div>
      )}
    </div>
  )
}
