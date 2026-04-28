import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import apiClient, { addonsApi } from '../../api/client'
import { Camera, Plus, Share2, EyeOff, Eye, X, Check, Search, ArrowUpDown, MapPin, Filter, Link2, RefreshCw, Unlink, FolderOpen, Info, ChevronLeft, ChevronRight, CalendarRange, Timer, Settings } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { fetchImageAsBlob, clearImageQueue } from '../../api/authUrl'
import { useToast } from '../shared/Toast'
import PhotoGallery from '../Photos/PhotoGallery'
import type { Photo, Day, Place } from '../../types'

interface PhotoProvider {
  id: string
  name: string
  icon?: string
  config?: Record<string, unknown>
}

function ProviderImg({ baseUrl, provider, style, loading }: { baseUrl: string; provider: string; style?: React.CSSProperties; loading?: 'lazy' | 'eager' }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let revoke = ''
    fetchImageAsBlob('/api' + baseUrl).then(blobUrl => {
      revoke = blobUrl
      setSrc(blobUrl)
    })
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [baseUrl])
  return src ? <img src={src} alt="" loading={loading} style={style} /> : null
}


// ── Types ───────────────────────────────────────────────────────────────────

interface TripPhoto {
  asset_id: string
  provider: string
  user_id: number
  username: string
  avatar?: string | null
  shared: number
  added_at: string
  city?: string | null
  country?: string | null
  taken_at?: string | null
  latitude?: number | null
  longitude?: number | null
}

interface Asset {
  id: string
  provider: string
  takenAt: string
  city: string | null
  country: string | null
}

interface MemoriesPanelProps {
  tripId: number
  startDate: string | null
  endDate: string | null
  days?: Day[]
  places?: Place[]
}

// ── Main Component ──────────────────────────────────────────────────────────

function adaptToPhoto(p: TripPhoto, tripId: number, idx: number): Photo {
  return {
    id: -(idx + 1),
    trip_id: tripId,
    filename: p.asset_id,
    original_name: p.asset_id,
    mime_type: 'image/jpeg',
    size: 0,
    file_size: null,
    caption: null,
    place_id: null,
    day_id: null,
    taken_at: p.taken_at || null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,
    city: p.city || null,
    country: p.country || null,
    camera_make: null,
    camera_model: null,
    width: null,
    height: null,
    user_id: p.user_id,
    username: p.username,
    user_avatar: p.avatar || null,
    created_at: p.added_at,
    url: `/api/integrations/memories/${p.provider}/assets/${tripId}/${p.asset_id}/${p.user_id}/thumbnail`,
    provider: p.provider,
    asset_id: p.asset_id,
  }
}

export default function MemoriesPanel({ tripId, startDate, endDate, days = [], places = [] }: MemoriesPanelProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const currentUser = useAuthStore(s => s.user)

  const [connected, setConnected] = useState(false)
  const [enabledProviders, setEnabledProviders] = useState<PhotoProvider[]>([])
  const [availableProviders, setAvailableProviders] = useState<PhotoProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [loading, setLoading] = useState(true)

  // Trip photos (saved selections)
  const [tripPhotos, setTripPhotos] = useState<TripPhoto[]>([])

  // Photo picker
  const [showPicker, setShowPicker] = useState(false)
  const [pickerPhotos, setPickerPhotos] = useState<Asset[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Confirm share popup
  const [showConfirmShare, setShowConfirmShare] = useState(false)

  // Filters & sort
  const [sortAsc, setSortAsc] = useState(true)
  const [locationFilter, setLocationFilter] = useState('')

  const [showManage, setShowManage] = useState(false)

  // Album linking
  const [showAlbumPicker, setShowAlbumPicker] = useState(false)
  const [albums, setAlbums] = useState<{ id: string; albumName: string; assetCount: number; albumThumbnailAssetId?: string }[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(false)
  const [albumLinks, setAlbumLinks] = useState<{ id: number; provider: string; album_id: string; album_name: string; user_id: number; username: string; sync_enabled: number; auto_sync: number; sync_type: string; sync_from_date: string | null; sync_to_date: string | null; last_synced_at: string | null }[]>([])
  const [dateSyncFrom, setDateSyncFrom] = useState(startDate || '')
  const [dateSyncTo, setDateSyncTo] = useState(endDate || '')
  const [showDateRangePicker, setShowDateRangePicker] = useState(false)
  const [dateRangePreview, setDateRangePreview] = useState<Asset[]>([])
  const [dateRangePreviewLoading, setDateRangePreviewLoading] = useState(false)
  const [newLinkAutoSync, setNewLinkAutoSync] = useState(false)
  const [syncing, setSyncing] = useState<number | null>(null)

  const [localPhotos, setLocalPhotos] = useState<Photo[]>([])
  const [showSourcesPopover, setShowSourcesPopover] = useState(false)
  const [showAddSource, setShowAddSource] = useState(false)
  const sourcesPopoverRef = useRef<HTMLDivElement>(null)
  const addSourceRef = useRef<HTMLDivElement>(null)


  //helpers for building urls
  const ADDON_PREFIX = "/integrations/memories"
  
  function buildUnifiedUrl(endpoint: string, lastParam?:string,): string {
    return `${ADDON_PREFIX}/unified/trips/${tripId}/${endpoint}${lastParam ? `/${lastParam}` : ''}`;
  }

  function buildProviderUrl(provider: string, endpoint: string, item?: string): string {
    if (endpoint === 'album-link-sync') {
      endpoint = `trips/${tripId}/album-links/${item?.toString() || ''}/sync`
    }
    return `${ADDON_PREFIX}/${provider}/${endpoint}`;
  }

  function buildProviderAssetUrl(photo: TripPhoto, what: string): string {
    return `${ADDON_PREFIX}/${photo.provider}/assets/${tripId}/${photo.asset_id}/${photo.user_id}/${what}`
  }

  function buildProviderAssetUrlFromAsset(asset: Asset, what: string, userId: number): string {
    const photo: TripPhoto = {
      asset_id: asset.id,
      provider: asset.provider,
      user_id: userId,
      username: '',
      shared: 0,
      added_at: null
    }
    return buildProviderAssetUrl(photo, what)
  }


  const loadAlbumLinks = async () => {
    try {
      const res = await apiClient.get(buildUnifiedUrl('album-links'))
      setAlbumLinks(res.data.links || [])
    } catch { setAlbumLinks([]) }
  }

  const loadAlbums = async (provider: string = selectedProvider) => {
    if (!provider) return
    setAlbumsLoading(true)
    try {
      const res = await apiClient.get(buildProviderUrl(provider, 'albums'))
      setAlbums(res.data.albums || [])
    } catch {
      setAlbums([])
      toast.error(t('memories.error.loadAlbums'))
    } finally {
      setAlbumsLoading(false)
    }
  }

  const openAlbumPicker = async () => {
    setNewLinkAutoSync(false)
    setShowAlbumPicker(true)
    await loadAlbums(selectedProvider)
  }

  const openDateRangePicker = () => {
    setDateSyncFrom(startDate || '')
    setDateSyncTo(endDate || '')
    setNewLinkAutoSync(false)
    setDateRangePreview([])
    setShowDateRangePicker(true)
  }

  const loadDateRangePreview = async (from: string, to: string) => {
    if (!from || !to || !selectedProvider) return
    setDateRangePreviewLoading(true)
    try {
      const res = await apiClient.post(buildProviderUrl(selectedProvider, 'search'), { from, to })
      const assets: Asset[] = (res.data.assets || []).slice(0, 6).map((a: Asset) => ({ ...a, provider: selectedProvider }))
      setDateRangePreview(assets)
    } catch {
      setDateRangePreview([])
    } finally {
      setDateRangePreviewLoading(false)
    }
  }

  useEffect(() => {
    if (!showDateRangePicker) return
    const timer = setTimeout(() => loadDateRangePreview(dateSyncFrom, dateSyncTo), 400)
    return () => clearTimeout(timer)
  }, [showDateRangePicker, dateSyncFrom, dateSyncTo, selectedProvider])

  const linkAlbum = async (albumId: string, albumName: string) => {
    if (!selectedProvider) {
      toast.error(t('memories.error.linkAlbum'))
      return
    }

    try {
      await apiClient.post(buildUnifiedUrl('album-links'), {
        album_id: albumId,
        album_name: albumName,
        provider: selectedProvider,
      })
      setShowAlbumPicker(false)
      await loadAlbumLinks()
      // Auto-sync after linking
      const linksRes = await apiClient.get(buildUnifiedUrl('album-links'))
      const newLink = (linksRes.data.links || []).find((l: any) => l.album_id === albumId && l.provider === selectedProvider)
      if (newLink) {
        await syncAlbum(newLink.id)
        if (newLinkAutoSync) await toggleAutoSync(newLink.id, 0)
      }
    } catch { toast.error(t('memories.error.linkAlbum')) }
  }

  const unlinkAlbum = async (linkId: number) => {
    try {
      await apiClient.delete(buildUnifiedUrl('album-links', linkId.toString()))
      await loadAlbumLinks()
      await loadPhotos()
    } catch { toast.error(t('memories.error.unlinkAlbum')) }
  }

  const syncAlbum = async (linkId: number, provider?: string) => {
    const targetProvider = provider || selectedProvider
    if (!targetProvider) return
    setSyncing(linkId)
    try {
      await apiClient.post(buildProviderUrl(targetProvider, 'album-link-sync', linkId.toString()))
      await loadAlbumLinks()
      await loadPhotos()
    } catch { toast.error(t('memories.error.syncAlbum')) }
    finally { setSyncing(null) }
  }

  const toggleAutoSync = async (linkId: number, currentValue: number) => {
    try {
      await apiClient.patch(buildUnifiedUrl('album-links', linkId.toString()), { auto_sync: !currentValue })
      await loadAlbumLinks()
    } catch { toast.error(t('memories.error.syncAlbum')) }
  }

  const linkDateRange = async () => {
    if (!selectedProvider || !dateSyncFrom || !dateSyncTo) return
    const albumId = `date_range:${dateSyncFrom}:${dateSyncTo}`
    const albumName = `${dateSyncFrom} – ${dateSyncTo}`
    try {
      await apiClient.post(buildUnifiedUrl('album-links'), {
        album_id: albumId,
        album_name: albumName,
        provider: selectedProvider,
        sync_type: 'date_range',
        sync_from_date: dateSyncFrom,
        sync_to_date: dateSyncTo,
      })
      setShowDateRangePicker(false)
      await loadAlbumLinks()
      const linksRes = await apiClient.get(buildUnifiedUrl('album-links'))
      const newLink = (linksRes.data.links || []).find((l: any) => l.album_id === albumId && l.provider === selectedProvider)
      if (newLink) {
        await syncAlbum(newLink.id, selectedProvider)
        if (newLinkAutoSync) await toggleAutoSync(newLink.id, 0)
      }
    } catch { toast.error(t('memories.error.linkAlbum')) }
  }

  // Lightbox
  const [lightboxId, setLightboxId] = useState<string | null>(null)
  const [lightboxUserId, setLightboxUserId] = useState<number | null>(null)
  const [lightboxFilteredPhotos, setLightboxFilteredPhotos] = useState<Photo[]>([])
  const [lightboxInfo, setLightboxInfo] = useState<any>(null)
  const [lightboxInfoLoading, setLightboxInfoLoading] = useState(false)
  const [lightboxOriginalSrc, setLightboxOriginalSrc] = useState('')
  const [showMobileInfo, setShowMobileInfo] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitial()
  }, [tripId])

  // WebSocket: reload photos when another user adds/removes/shares
  useEffect(() => {
    const handler = () => { loadPhotos(); loadLocalPhotos() }
    window.addEventListener('memories:updated', handler)
    return () => window.removeEventListener('memories:updated', handler)
  }, [tripId])

  const loadPhotos = async () => {
    try {
      const photosRes = await apiClient.get(buildUnifiedUrl('photos'))
      setTripPhotos(photosRes.data.photos || [])
    } catch {
      setTripPhotos([])
    }
  }

  const loadLocalPhotos = async () => {
    try {
      const res = await fetch(`/api/trips/${tripId}/photos`, { credentials: 'include' })
      if (!res.ok) throw new Error()
      const data = await res.json()
      setLocalPhotos(data.photos || [])
    } catch { setLocalPhotos([]) }
  }

  const loadInitial = async () => {
    setLoading(true)
    try {
      const addonsRes = await addonsApi.enabled().catch(() => ({ addons: [] as any[] }))
      const enabledAddons = addonsRes?.addons || []
      const photoProviders = enabledAddons.filter((a: any) => a.type === 'photo_provider' && a.enabled)

      setEnabledProviders(photoProviders.map((a: any) => ({ id: a.id, name: a.name, icon: a.icon, config: a.config })))

      // Test connection status for each enabled provider
      const statusResults = await Promise.all(
        photoProviders.map(async (provider: any) => {
          const statusUrl = (provider.config as Record<string, unknown>)?.status_get as string
          if (!statusUrl) return { provider, connected: false }
          try {
            const res = await apiClient.get(statusUrl)
            return { provider, connected: !!res.data?.connected }
          } catch {
            return { provider, connected: false }
          }
        })
      )

      const connectedProviders = statusResults
        .filter(r => r.connected)
        .map(r => ({ id: r.provider.id, name: r.provider.name, icon: r.provider.icon, config: r.provider.config }))
      
      setAvailableProviders(connectedProviders)
      setConnected(connectedProviders.length > 0)
      if (connectedProviders.length > 0 && !selectedProvider) {
        setSelectedProvider(connectedProviders[0].id)
      }
    } catch {
      setAvailableProviders([])
      setConnected(false)
    }
    await Promise.all([loadPhotos(), loadLocalPhotos()])
    await loadAlbumLinks()
    setLoading(false)
  }

  // ── Photo Picker ──────────────────────────────────────────────────────────

  const [pickerDateFilter, setPickerDateFilter] = useState(true)

  const openPicker = async () => {
    setShowPicker(true)
    setPickerLoading(true)
    setSelectedIds(new Set())
    setPickerDateFilter(!!(startDate && endDate))
    await loadPickerPhotos(!!(startDate && endDate))
  }

  useEffect(() => {
    if (showPicker) {
      loadPickerPhotos(pickerDateFilter)
    }
  }, [selectedProvider])

  useEffect(() => {
    loadAlbumLinks()
  }, [tripId])

  useEffect(() => {
    if (showAlbumPicker) {
      loadAlbums(selectedProvider)
    }
  }, [showAlbumPicker, selectedProvider, tripId])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sourcesPopoverRef.current && !sourcesPopoverRef.current.contains(e.target as Node)) setShowSourcesPopover(false)
      if (addSourceRef.current && !addSourceRef.current.contains(e.target as Node)) setShowAddSource(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const loadPickerPhotos = async (useDate: boolean) => {
    setPickerLoading(true)
    try {
      const provider = availableProviders.find(p => p.id === selectedProvider)
      if (!provider) {
        setPickerPhotos([])
        return
      }
      const res = await apiClient.post(buildProviderUrl(provider.id, 'search'), {
        from: useDate && startDate ? startDate : undefined,
        to: useDate && endDate ? endDate : undefined,
      })
      setPickerPhotos((res.data.assets || []).map((asset: Asset) => ({ ...asset, provider: provider.id })))
    } catch {
      setPickerPhotos([])
      toast.error(t('memories.error.loadPhotos'))
    } finally {
      setPickerLoading(false)
    }
  }

  const togglePickerSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmSelection = () => {
    if (selectedIds.size === 0) return
    setShowConfirmShare(true)
  }

  const executeAddPhotos = async () => {
    setShowConfirmShare(false)
    try {
      const groupedByProvider = new Map<string, string[]>()
      for (const key of selectedIds) {
        const [provider, assetId] = key.split('::')
        if (!provider || !assetId) continue
        const list = groupedByProvider.get(provider) || []
        list.push(assetId)
        groupedByProvider.set(provider, list)
      }

      await apiClient.post(buildUnifiedUrl('photos'), {
        selections: [...groupedByProvider.entries()].map(([provider, asset_ids]) => ({ provider, asset_ids })),
        shared: true,
      })
      setShowPicker(false)
      clearImageQueue()
      loadInitial()
    } catch { toast.error(t('memories.error.addPhotos')) }
  }

  // ── Remove photo ──────────────────────────────────────────────────────────

  const removePhoto = async (photo: TripPhoto) => {
    try {
      await apiClient.delete(buildUnifiedUrl('photos'), {
        data: {
          asset_id: photo.asset_id,
          provider: photo.provider,
        },
      })
      setTripPhotos(prev => prev.filter(p => !(p.provider === photo.provider && p.asset_id === photo.asset_id)))
    } catch { toast.error(t('memories.error.removePhoto')) }
  }

  // ── Toggle sharing ────────────────────────────────────────────────────────

  const toggleSharing = async (photo: TripPhoto, shared: boolean) => {
    try {
      await apiClient.put(buildUnifiedUrl('photos', 'sharing'), {
        shared,
        asset_id: photo.asset_id,
        provider: photo.provider,
      })
      setTripPhotos(prev => prev.map(p =>
        p.provider === photo.provider && p.asset_id === photo.asset_id ? { ...p, shared: shared ? 1 : 0 } : p
      ))
    } catch { toast.error(t('memories.error.toggleSharing')) }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  

  const makePickerKey = (provider: string, assetId: string): string => `${provider}::${assetId}`

  const uploadLocalPhoto = async (fd: FormData) => {
    const res = await fetch(`/api/trips/${tripId}/photos`, { method: 'POST', credentials: 'include', body: fd })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await loadLocalPhotos()
  }

  const deletePhotoById = async (photoId: number) => {
    if (photoId < 0) {
      const tripPhoto = allVisible.find((_, i) => -(i + 1) === photoId)
      if (tripPhoto) await removePhoto(tripPhoto)
    } else {
      const res = await fetch(`/api/trips/${tripId}/photos/${photoId}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setLocalPhotos(prev => prev.filter(p => p.id !== photoId))
    }
  }

  const updatePhotoById = async (photoId: number, data: Partial<Photo>) => {
    if (photoId < 0) return
    const res = await fetch(`/api/trips/${tripId}/photos/${photoId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error()
    const result = await res.json()
    setLocalPhotos(prev => prev.map(p => p.id === photoId ? { ...p, ...result.photo } : p))
  }

  const handlePhotoClick = (photo: Photo, filteredPhotos: Photo[]): boolean | void => {
    if (photo.provider && photo.asset_id) {
      const providerPhotos = filteredPhotos.filter(p => p.provider && p.asset_id)
      openLightboxForPhoto(photo, providerPhotos)
      return true
    }
  }

  const ownPhotos = tripPhotos.filter(p => p.user_id === currentUser?.id)
  const othersPhotos = tripPhotos.filter(p => p.user_id !== currentUser?.id && p.shared)
  const allVisibleRaw = [...ownPhotos, ...othersPhotos]

  // Unique locations for filter
  const locations = [...new Set(allVisibleRaw.map(p => p.city).filter(Boolean) as string[])].sort()

  // Apply filter + sort
  const allVisible = allVisibleRaw
    .filter(p => !locationFilter || p.city === locationFilter)
    .sort((a, b) => {
      const da = new Date(a.added_at || 0).getTime()
      const db = new Date(b.added_at || 0).getTime()
      return sortAsc ? da - db : db - da
    })

  const font: React.CSSProperties = {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', ...font }}>
        <div className="w-8 h-8 border-2 rounded-full animate-spin"
          style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }} />
      </div>
    )
  }

  // ── Photo Picker Modal ────────────────────────────────────────────────────

  const ProviderTabs = () => {
    if (availableProviders.length < 2) return null
    return (
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        {availableProviders.map(provider => (
          <button
            key={provider.id}
            onClick={() => setSelectedProvider(provider.id)}
            style={{
              padding: '6px 12px',
              borderRadius: 99,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              border: '1px solid',
              transition: 'all 0.15s',
              background: selectedProvider === provider.id ? 'var(--text-primary)' : 'var(--bg-card)',
              borderColor: selectedProvider === provider.id ? 'var(--text-primary)' : 'var(--border-primary)',
              color: selectedProvider === provider.id ? 'var(--bg-primary)' : 'var(--text-muted)',
              textTransform: 'capitalize',
            }}
          >
            {provider.name}
          </button>
        ))}
      </div>
    )
  }

  // ── Date Range Picker Modal ─────────────────────────────────────────────

  if (showDateRangePicker) {
    const canLink = !!dateSyncFrom && !!dateSyncTo
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <CalendarRange size={15} /> {t('memories.dateSyncLabel')}
            </h3>
            <button onClick={() => setShowDateRangePicker(false)}
              style={{ padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
              {t('common.cancel')}
            </button>
          </div>
          <ProviderTabs />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>From</div>
            <input type="date" value={dateSyncFrom} onChange={e => setDateSyncFrom(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>To</div>
            <input type="date" value={dateSyncTo} onChange={e => setDateSyncTo(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </div>
          {(dateRangePreviewLoading || dateRangePreview.length > 0) && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{t('memories.preview')}</div>
              {dateRangePreviewLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 80 }}>
                  <div style={{ width: 20, height: 20, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {dateRangePreview.map(asset => (
                    <div key={asset.id} style={{ width: 72, height: 72, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0 }}>
                      <ProviderImg
                        baseUrl={`${ADDON_PREFIX}/${asset.provider}/assets/${tripId}/${asset.id}/${currentUser?.id}/thumbnail`}
                        provider={asset.provider}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        loading="lazy"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)', userSelect: 'none' }}>
            <input type="checkbox" checked={newLinkAutoSync} onChange={e => setNewLinkAutoSync(e.target.checked)} style={{ cursor: 'pointer', width: 14, height: 14 }} />
            <Timer size={13} color={newLinkAutoSync ? 'var(--text-primary)' : 'var(--text-faint)'} />
            {t('memories.enableAutoSync')}
          </label>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-secondary)', flexShrink: 0 }}>
          <button onClick={linkDateRange} disabled={!canLink}
            style={{
              width: '100%', padding: '10px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600,
              cursor: canLink ? 'pointer' : 'default', fontFamily: 'inherit',
              background: canLink ? 'var(--text-primary)' : 'var(--border-primary)',
              color: canLink ? 'var(--bg-primary)' : 'var(--text-faint)',
            }}>
            <Link2 size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 6 }} />
            {t('memories.linkDateRange')}
          </button>
        </div>
      </div>
    )
  }

  // ── Album Picker Modal ──────────────────────────────────────────────────

  if (showAlbumPicker) {
    const linkedIds = new Set(albumLinks.map(l => l.album_id))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {availableProviders.length > 1 ? t('memories.selectAlbumMultiple') : t('memories.selectAlbum', { provider_name: availableProviders.find(p => p.id === selectedProvider)?.name || 'Photo provider' })}
            </h3>
            <button onClick={() => setShowAlbumPicker(false)}
              style={{ padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
              {t('common.cancel')}
            </button>
          </div>
          <ProviderTabs />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {albumsLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ width: 24, height: 24, border: '2px solid var(--border-primary)', borderTopColor: 'var(--text-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto' }} />
            </div>
          ) : albums.length === 0 ? (
            <p style={{ textAlign: 'center', padding: 40, fontSize: 13, color: 'var(--text-faint)' }}>
              {t('memories.noAlbums')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {albums.map(album => {
                const isLinked = linkedIds.has(album.id)
                return (
                  <button key={album.id} onClick={() => !isLinked && linkAlbum(album.id, album.albumName)}
                    disabled={isLinked}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '8px 10px',
                      borderRadius: 10, border: 'none', cursor: isLinked ? 'default' : 'pointer',
                      background: isLinked ? 'var(--bg-tertiary)' : 'transparent', fontFamily: 'inherit', textAlign: 'left',
                      opacity: isLinked ? 0.5 : 1,
                    }}
                    onMouseEnter={e => { if (!isLinked) e.currentTarget.style.background = 'var(--bg-hover)' }}
                    onMouseLeave={e => { if (!isLinked) e.currentTarget.style.background = 'transparent' }}
                  >
                    <div style={{ width: 56, height: 56, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-tertiary)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {album.albumThumbnailAssetId ? (
                        <ProviderImg
                          baseUrl={`${ADDON_PREFIX}/${selectedProvider}/assets/${tripId}/${album.albumThumbnailAssetId}/${currentUser?.id}/thumbnail`}
                          provider={selectedProvider}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <FolderOpen size={22} color="var(--text-muted)" />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{album.albumName}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                        {album.assetCount} {t('memories.photos')}
                      </div>
                    </div>
                    {isLinked ? (
                      <Check size={16} color="var(--text-faint)" />
                    ) : (
                      <Link2 size={16} color="var(--text-muted)" />
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-secondary)', flexShrink: 0 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', userSelect: 'none' }}>
            <input type="checkbox" checked={newLinkAutoSync} onChange={e => setNewLinkAutoSync(e.target.checked)} style={{ cursor: 'pointer', width: 13, height: 13 }} />
            <Timer size={12} color={newLinkAutoSync ? 'var(--text-primary)' : 'var(--text-faint)'} />
            {t('memories.enableAutoSync')}
          </label>
        </div>
      </div>
    )
  }

  // ── Photo Picker Modal ────────────────────────────────────────────────────

  if (showPicker) {
    const alreadyAdded = new Set(
      tripPhotos
        .filter(p => p.user_id === currentUser?.id)
        .map(p => makePickerKey(p.provider, p.asset_id))
    )

    return (
      <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>
        {/* Picker header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
              {availableProviders.length > 1 ? t('memories.selectPhotosMultiple') : t('memories.selectPhotos', { provider_name: availableProviders.find(p => p.id === selectedProvider)?.name || 'Photo provider' })}
            </h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { clearImageQueue(); setShowPicker(false) }}
                style={{ padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={confirmSelection} disabled={selectedIds.size === 0}
                style={{
                  padding: '7px 14px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600,
                  cursor: selectedIds.size > 0 ? 'pointer' : 'default', fontFamily: 'inherit',
                  background: selectedIds.size > 0 ? 'var(--text-primary)' : 'var(--border-primary)',
                  color: selectedIds.size > 0 ? 'var(--bg-primary)' : 'var(--text-faint)',
                }}>
                {selectedIds.size > 0 ? t('memories.addSelected', { count: selectedIds.size }) : t('memories.addPhotos')}
              </button>
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <ProviderTabs />
          </div>
          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 6 }}>
            {startDate && endDate && (
              <button onClick={() => { if (!pickerDateFilter) { setPickerDateFilter(true); loadPickerPhotos(true) } }}
                style={{
                  padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  border: '1px solid', transition: 'all 0.15s',
                  background: pickerDateFilter ? 'var(--text-primary)' : 'var(--bg-card)',
                  borderColor: pickerDateFilter ? 'var(--text-primary)' : 'var(--border-primary)',
                  color: pickerDateFilter ? 'var(--bg-primary)' : 'var(--text-muted)',
                }}>
                {t('memories.tripDates')} ({startDate ? new Date(startDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''} — {endDate ? new Date(endDate + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''})
              </button>
            )}
            <button onClick={() => { if (pickerDateFilter || !startDate) { setPickerDateFilter(false); loadPickerPhotos(false) } }}
              style={{
                padding: '6px 14px', borderRadius: 99, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                border: '1px solid', transition: 'all 0.15s',
                background: !pickerDateFilter ? 'var(--text-primary)' : 'var(--bg-card)',
                borderColor: !pickerDateFilter ? 'var(--text-primary)' : 'var(--border-primary)',
                color: !pickerDateFilter ? 'var(--bg-primary)' : 'var(--text-muted)',
              }}>
              {t('memories.allPhotos')}
            </button>
          </div>
          {selectedIds.size > 0 && (
            <p style={{ margin: '8px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {selectedIds.size} {t('memories.selected')}
            </p>
          )}
        </div>

        {/* Picker grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {pickerLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
              <div className="w-7 h-7 border-2 rounded-full animate-spin"
                style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }} />
            </div>
          ) : pickerPhotos.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px' }}>
              <Camera size={36} style={{ color: 'var(--text-faint)', margin: '0 auto 10px', display: 'block' }} />
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{t('memories.noPhotos')}</p>
              {
                pickerDateFilter && (
                  <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0 0 16px' }}>
                    {t('memories.noPhotosHint', { provider_name: availableProviders.find(p => p.id === selectedProvider)?.name || 'Photo provider' })}
                  </p>
                )
              } 
            </div>
          ) : (() => {
            // Group photos by month
            const byMonth: Record<string, Asset[]> = {}
            for (const asset of pickerPhotos) {
              const d = asset.takenAt ? new Date(asset.takenAt) : null
              const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown'
              if (!byMonth[key]) byMonth[key] = []
              byMonth[key].push(asset)
            }
            const sortedMonths = Object.keys(byMonth).sort().reverse()

            return sortedMonths.map(month => (
              <div key={month} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, paddingLeft: 2 }}>
                  {month !== 'unknown'
                    ? new Date(month + '-15').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                    : '—'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: 4 }}>
                  {byMonth[month].map(asset => {
                    const pickerKey = makePickerKey(asset.provider, asset.id)
                    const isSelected = selectedIds.has(pickerKey)
                    const isAlready = alreadyAdded.has(pickerKey)
                    return (
                      <div key={pickerKey}
                        onClick={() => !isAlready && togglePickerSelect(pickerKey)}
                        style={{
                          position: 'relative', aspectRatio: '1', borderRadius: 8, overflow: 'hidden',
                          cursor: isAlready ? 'default' : 'pointer',
                          opacity: isAlready ? 0.3 : 1,
                          outline: isSelected ? '3px solid var(--text-primary)' : 'none',
                          outlineOffset: -3,
                        }}>
                        <ProviderImg baseUrl={buildProviderAssetUrlFromAsset(asset, 'thumbnail', currentUser!.id)} provider={asset.provider} loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        {isSelected && (
                          <div style={{
                            position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: '50%',
                            background: 'var(--text-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Check size={13} color="var(--bg-primary)" />
                          </div>
                        )}
                        {isAlready && (
                          <div style={{
                            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'rgba(0,0,0,0.3)', fontSize: 10, color: 'white', fontWeight: 600,
                          }}>
                            {t('memories.alreadyAdded')}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          })()}
        </div>
      </div>

      {/* Confirm share popup (inside picker) */}
      {showConfirmShare && (
        <div onClick={() => setShowConfirmShare(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 16px 48px rgba(0,0,0,0.2)', textAlign: 'center' }}>
            <Share2 size={28} style={{ color: 'var(--text-primary)', marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.confirmShareTitle')}
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {t('memories.confirmShareHint', { count: selectedIds.size })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => setShowConfirmShare(false)}
                style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={executeAddPhotos}
                style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--text-primary)', color: 'var(--bg-primary)' }}>
                {t('memories.confirmShareButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
    )
  }

  // ── Main Gallery ──────────────────────────────────────────────────────────

  const galleryPhotos = [
    ...allVisible.map((p, i) => adaptToPhoto(p, tripId, i)),
    ...localPhotos,
  ]

  const openLightboxForPhoto = (photo: Photo, filteredPhotos: Photo[]) => {
    const tripPhoto = allVisible.find(p => p.asset_id === photo.asset_id && p.provider === photo.provider)
    if (!tripPhoto) return
    setLightboxFilteredPhotos(filteredPhotos)
    setLightboxId(tripPhoto.asset_id)
    setLightboxUserId(tripPhoto.user_id)
    setLightboxInfo(null)
    if (lightboxOriginalSrc) URL.revokeObjectURL(lightboxOriginalSrc)
    setLightboxOriginalSrc('')
    fetchImageAsBlob('/api' + buildProviderAssetUrl(tripPhoto, 'original')).then(setLightboxOriginalSrc)
    setLightboxInfoLoading(true)
    apiClient.get(buildProviderAssetUrl(tripPhoto, 'info'))
      .then(r => setLightboxInfo(r.data)).catch(() => {}).finally(() => setLightboxInfoLoading(false))
  }

  const MAX_VISIBLE_PILLS = 2
  const visibleLinks = albumLinks.slice(0, MAX_VISIBLE_PILLS)
  const overflowLinks = albumLinks.slice(MAX_VISIBLE_PILLS)

  const renderPill = (link: typeof albumLinks[0]) => (
    <div key={link.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 99, border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0, maxWidth: 180 }}>
      {link.sync_type === 'date_range' ? <CalendarRange size={11} style={{ flexShrink: 0 }} /> : <FolderOpen size={11} style={{ flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>{link.album_name}</span>
      <button onClick={e => { e.stopPropagation(); syncAlbum(link.id, link.provider) }} disabled={syncing === link.id}
        title={t('memories.syncAlbum')}
        style={{ background: 'none', border: 'none', cursor: syncing === link.id ? 'default' : 'pointer', padding: 1, display: 'flex', color: 'var(--text-faint)', flexShrink: 0, lineHeight: 0 }}>
        <RefreshCw size={11} style={{ animation: syncing === link.id ? 'spin 1s linear infinite' : 'none' }} />
      </button>
      {link.user_id === currentUser?.id && (
        <button onClick={e => { e.stopPropagation(); toggleAutoSync(link.id, link.auto_sync) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'flex', color: link.auto_sync ? 'var(--text-primary)' : 'var(--text-faint)', flexShrink: 0, lineHeight: 0 }}>
          <Timer size={11} />
        </button>
      )}
      {link.user_id === currentUser?.id && (
        <button onClick={e => { e.stopPropagation(); unlinkAlbum(link.id) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 1, display: 'flex', color: 'var(--text-faint)', flexShrink: 0, lineHeight: 0 }}>
          <X size={11} />
        </button>
      )}
    </div>
  )

  const sourcesBar = connected ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
      {visibleLinks.map(renderPill)}

      {overflowLinks.length > 0 && (
        <div ref={sourcesPopoverRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={() => setShowSourcesPopover(v => !v)}
            style={{ padding: '3px 8px', borderRadius: 99, border: '1px solid var(--border-primary)', background: showSourcesPopover ? 'var(--bg-tertiary)' : 'var(--bg-secondary)', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            +{overflowLinks.length}
          </button>
          {showSourcesPopover && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 50, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
              {overflowLinks.map(renderPill)}
            </div>
          )}
        </div>
      )}

      <div ref={addSourceRef} style={{ position: 'relative', flexShrink: 0, marginLeft: 'auto' }}>
        <button onClick={() => setShowAddSource(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
          <Plus size={12} /> Add source
        </button>
        {showAddSource && (
          <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 50, minWidth: 190, overflow: 'hidden' }}>
            {availableProviders.length > 1 && (
              <div style={{ padding: '8px 10px 4px', display: 'flex', gap: 4, flexWrap: 'wrap', borderBottom: '1px solid var(--border-primary)' }}>
                {availableProviders.map(p => (
                  <button key={p.id} onClick={() => setSelectedProvider(p.id)}
                    style={{ padding: '3px 8px', borderRadius: 99, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid', background: selectedProvider === p.id ? 'var(--text-primary)' : 'var(--bg-card)', borderColor: selectedProvider === p.id ? 'var(--text-primary)' : 'var(--border-primary)', color: selectedProvider === p.id ? 'var(--bg-primary)' : 'var(--text-muted)' }}>
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => { setShowAddSource(false); openPicker() }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', textAlign: 'left' }}>
              <Search size={13} /> {t('memories.addPhotos')}
            </button>
            <button onClick={() => { setShowAddSource(false); openAlbumPicker() }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', textAlign: 'left' }}>
              <Link2 size={13} /> {t('memories.linkAlbum')}
            </button>
            <button onClick={() => { setShowAddSource(false); openDateRangePicker() }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 14px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, color: 'var(--text-primary)', textAlign: 'left' }}>
              <CalendarRange size={13} /> {t('memories.linkDateRange')}
            </button>
          </div>
        )}
      </div>
    </div>
  ) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', ...font }}>
      <PhotoGallery
        photos={galleryPhotos}
        places={places}
        days={days}
        tripId={tripId}
        onPhotoClick={handlePhotoClick}
        onUpload={uploadLocalPhoto}
        onDelete={deletePhotoById}
        onUpdate={updatePhotoById}
        sourcesBar={sourcesBar}
      />

      {/* Confirm share popup */}
      {showConfirmShare && (
        <div onClick={() => setShowConfirmShare(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg-card)', borderRadius: 16, padding: 24, maxWidth: 360, width: '100%', boxShadow: '0 16px 48px rgba(0,0,0,0.2)', textAlign: 'center' }}>
            <Share2 size={28} style={{ color: 'var(--text-primary)', marginBottom: 12 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {t('memories.confirmShareTitle')}
            </h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {t('memories.confirmShareHint', { count: selectedIds.size })}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => setShowConfirmShare(false)}
                style={{ padding: '8px 20px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={executeAddPhotos}
                style={{ padding: '8px 20px', borderRadius: 10, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', background: 'var(--text-primary)', color: 'var(--bg-primary)' }}>
                {t('memories.confirmShareButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxId && lightboxUserId && (() => {
        const closeLightbox = () => {
          if (lightboxOriginalSrc) URL.revokeObjectURL(lightboxOriginalSrc)
          setLightboxOriginalSrc('')
          setLightboxId(null)
          setLightboxUserId(null)
          setShowMobileInfo(false)
        }

        const navList = lightboxFilteredPhotos.length > 0 ? lightboxFilteredPhotos : allVisible.map((p, i) => adaptToPhoto(p, tripId, i))
        const currentIdx = navList.findIndex(p => p.asset_id === lightboxId)
        const hasPrev = currentIdx > 0
        const hasNext = currentIdx < navList.length - 1
        const navigateTo = (idx: number) => {
          const adapted = navList[idx]
          if (!adapted) return
          const photo = allVisible.find(p => p.asset_id === adapted.asset_id && p.provider === adapted.provider)
          if (!photo) return
          if (lightboxOriginalSrc) URL.revokeObjectURL(lightboxOriginalSrc)
          setLightboxOriginalSrc('')
          setLightboxId(photo.asset_id)
          setLightboxUserId(photo.user_id)
          setLightboxInfo(null)
          fetchImageAsBlob('/api' + buildProviderAssetUrl(photo, 'original')).then(setLightboxOriginalSrc)
          setLightboxInfoLoading(true)
          apiClient.get(buildProviderAssetUrl(photo, 'info'))
            .then(r => setLightboxInfo(r.data)).catch(() => {}).finally(() => setLightboxInfoLoading(false))
        }

        const exifContent = lightboxInfo ? (
          <>
            {lightboxInfo.takenAt && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>Date</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{new Date(lightboxInfo.takenAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{new Date(lightboxInfo.takenAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            )}
            {(lightboxInfo.city || lightboxInfo.country) && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>
                  <MapPin size={9} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }} />Location
                </div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {[lightboxInfo.city, lightboxInfo.state, lightboxInfo.country].filter(Boolean).join(', ')}
                </div>
              </div>
            )}
            {lightboxInfo.camera && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>Camera</div>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{lightboxInfo.camera}</div>
                {lightboxInfo.lens && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{lightboxInfo.lens}</div>}
              </div>
            )}
            {(lightboxInfo.focalLength || lightboxInfo.aperture || lightboxInfo.iso) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {lightboxInfo.focalLength && (
                  <div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Focal</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.focalLength}</div>
                  </div>
                )}
                {lightboxInfo.aperture && (
                  <div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Aperture</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.aperture}</div>
                  </div>
                )}
                {lightboxInfo.shutter && (
                  <div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Shutter</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.shutter}</div>
                  </div>
                )}
                {lightboxInfo.iso && (
                  <div>
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ISO</div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{lightboxInfo.iso}</div>
                  </div>
                )}
              </div>
            )}
            {(lightboxInfo.width || lightboxInfo.fileName) && (
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
                {lightboxInfo.width && lightboxInfo.height && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 3 }}>{lightboxInfo.width} × {lightboxInfo.height}</div>
                )}
                {lightboxInfo.fileSize && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{(lightboxInfo.fileSize / 1024 / 1024).toFixed(1)} MB</div>
                )}
              </div>
            )}
          </>
        ) : null

        return (
          <div onClick={closeLightbox}
            onKeyDown={e => { if (e.key === 'ArrowLeft' && hasPrev) navigateTo(currentIdx - 1); if (e.key === 'ArrowRight' && hasNext) navigateTo(currentIdx + 1); if (e.key === 'Escape') closeLightbox() }}
            tabIndex={0} ref={el => el?.focus()}
            onTouchStart={e => (e.currentTarget as any)._touchX = e.touches[0].clientX}
            onTouchEnd={e => { const start = (e.currentTarget as any)._touchX; if (start == null) return; const diff = e.changedTouches[0].clientX - start; if (diff > 60 && hasPrev) navigateTo(currentIdx - 1); else if (diff < -60 && hasNext) navigateTo(currentIdx + 1) }}
            style={{
              position: 'absolute', inset: 0, zIndex: 100, outline: 'none',
              background: 'rgba(0,0,0,0.92)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
            {/* Close button */}
            <button onClick={closeLightbox}
              style={{
                position: 'absolute', top: 16, right: 16, zIndex: 10, width: 40, height: 40, borderRadius: '50%',
                background: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <X size={20} color="white" />
            </button>

            {/* Counter */}
            {navList.length > 1 && (
              <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 10, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                {currentIdx + 1} / {navList.length}
              </div>
            )}

            {/* Prev/Next buttons */}
            {hasPrev && (
              <button onClick={e => { e.stopPropagation(); navigateTo(currentIdx - 1) }}
                style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', zIndex: 10, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgba(255,255,255,0.8)' }}>
                <ChevronLeft size={22} />
              </button>
            )}
            {hasNext && (
              <button onClick={e => { e.stopPropagation(); navigateTo(currentIdx + 1) }}
                style={{ position: 'absolute', right: isMobile ? 12 : 280, top: '50%', transform: 'translateY(-50%)', zIndex: 10, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'rgba(255,255,255,0.8)' }}>
                <ChevronRight size={22} />
              </button>
            )}

            {/* Mobile info toggle button */}
            {isMobile && (lightboxInfo || lightboxInfoLoading) && (
              <button onClick={e => { e.stopPropagation(); setShowMobileInfo(prev => !prev) }}
                style={{
                  position: 'absolute', top: 16, right: 68, zIndex: 10, width: 40, height: 40, borderRadius: '50%',
                  background: showMobileInfo ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)',
                  border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                <Info size={20} color="white" />
              </button>
            )}

            <div onClick={e => { if (e.target === e.currentTarget) closeLightbox() }} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', justifyContent: 'center', padding: 20, width: '100%', height: '100%' }}>
              <img
                src={lightboxOriginalSrc}
                alt=""
                onClick={e => e.stopPropagation()}
                style={{ maxWidth: (!isMobile && lightboxInfo) ? 'calc(100% - 280px)' : '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10, cursor: 'default' }}
              />

              {/* Desktop info panel — liquid glass */}
              {!isMobile && lightboxInfo && (
                <div style={{
                  width: 240, flexShrink: 0, borderRadius: 16, padding: 18,
                  background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  border: '1px solid rgba(255,255,255,0.12)', color: 'white',
                  display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '100%', overflowY: 'auto',
                }}>
                  {exifContent}
                </div>
              )}

              {!isMobile && lightboxInfoLoading && (
                <div style={{ width: 240, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                </div>
              )}
            </div>

            {/* Mobile bottom sheet */}
            {isMobile && showMobileInfo && lightboxInfo && (
              <div onClick={e => e.stopPropagation()} style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 5,
                maxHeight: '60vh', overflowY: 'auto',
                borderRadius: '16px 16px 0 0', padding: 18,
                background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid rgba(255,255,255,0.12)', borderBottom: 'none',
                color: 'white', display: 'flex', flexDirection: 'column', gap: 14,
              }}>
                {exifContent}
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
