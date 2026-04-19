import { useState, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { VacayEntry } from '../../types'

export interface PopoverSaveData {
  eventName: string | null
  location: string | null
  note: string | null
  showDetails: number | null
  endDate: string
}

interface PrefillData {
  eventName: string;  eventNameMixed: boolean
  location: string;   locationMixed: boolean
  note: string;       noteMixed: boolean
  showDetails: boolean; showDetailsMixed: boolean
}

interface VacayEntryPopoverProps {
  startDate: string
  initialEndDate: string
  existingEntry?: VacayEntry
  prefill?: PrefillData
  shareDetailsDefault: boolean
  pos: { x: number; y: number }
  onClose: () => void
  onSave: (data: PopoverSaveData) => Promise<void>
  onRemove?: () => Promise<void>
}

const POPOVER_WIDTH = 292

export default function VacayEntryPopover({
  startDate, initialEndDate, existingEntry, prefill, shareDetailsDefault, pos, onClose, onSave, onRemove,
}: VacayEntryPopoverProps) {
  const { t, locale } = useTranslation()

  // Resolve initial values and mixed flags
  const initEventName   = existingEntry?.event_name ?? prefill?.eventName ?? ''
  const initLocation    = existingEntry?.location   ?? prefill?.location  ?? ''
  const initNote        = existingEntry?.note        ?? prefill?.note      ?? ''
  const mixedEventName  = !existingEntry && !!prefill?.eventNameMixed
  const mixedLocation   = !existingEntry && !!prefill?.locationMixed
  const mixedNote       = !existingEntry && !!prefill?.noteMixed
  const mixedShowDetails = !existingEntry && !!prefill?.showDetailsMixed

  const initShowDetails: boolean | null = mixedShowDetails
    ? null
    : existingEntry
      ? existingEntry.show_details !== 0
      : prefill?.showDetails ?? shareDetailsDefault

  const [eventName,      setEventName]      = useState(mixedEventName  ? '' : (initEventName  || ''))
  const [location,       setLocation]       = useState(mixedLocation   ? '' : (initLocation   || ''))
  const [note,           setNote]           = useState(mixedNote       ? '' : (initNote       || ''))
  const [showDetails,    setShowDetails]    = useState<boolean | null>(initShowDetails)
  const [eventNameDirty, setEventNameDirty] = useState(false)
  const [locationDirty,  setLocationDirty]  = useState(false)
  const [noteDirty,      setNoteDirty]      = useState(false)
  const [endDate,        setEndDate]        = useState(initialEndDate)
  const [saving,         setSaving]         = useState(false)
  const [removing,       setRemoving]       = useState(false)

  const fmt = (d: string) =>
    new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d + 'T00:00:00'))

  const x = Math.min(Math.max(pos.x - POPOVER_WIDTH / 2, 12), window.innerWidth - POPOVER_WIDTH - 12)
  const rawY = pos.y + 12
  const y = rawY + 460 > window.innerHeight ? pos.y - 470 : rawY

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({
        eventName:  (mixedEventName  && !eventNameDirty) ? null : eventName.trim(),
        location:   (mixedLocation   && !locationDirty)  ? null : location.trim(),
        note:       (mixedNote       && !noteDirty)       ? null : note.trim(),
        showDetails: showDetails === null ? null : (showDetails ? 1 : 0),
        endDate,
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    if (!onRemove) return
    setRemoving(true)
    try { await onRemove(); onClose() }
    finally { setRemoving(false) }
  }

  const isRange = endDate !== startDate
  const headerText = isRange ? `${fmt(startDate)} – ${fmt(endDate)}` : fmt(startDate)

  const inputStyle: React.CSSProperties = {
    width: '100%', fontSize: 13, padding: '5px 8px', borderRadius: 6,
    background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
    color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
  }

  const mixedPlaceholder = t('vacay.mixedValues')

  return ReactDOM.createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 99970 }} onClick={onClose} />
      <div
        className="fixed rounded-xl shadow-2xl flex flex-col"
        style={{
          zIndex: 99971, left: x, top: y, width: POPOVER_WIDTH,
          background: 'var(--bg-card)', border: '1px solid var(--border-primary)',
          animation: 'modalIn 0.15s ease-out',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{headerText}</span>
          <button onClick={onClose} className="p-1 rounded" style={{ color: 'var(--text-faint)' }}>
            <X size={14} />
          </button>
        </div>

        {/* Fields */}
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
              {t('vacay.eventName')}
            </label>
            <input
              type="text"
              value={eventName}
              onChange={e => { setEventName(e.target.value); setEventNameDirty(true) }}
              placeholder={mixedEventName && !eventNameDirty ? mixedPlaceholder : t('vacay.optional')}
              autoFocus
              style={{
                ...inputStyle,
                fontStyle: mixedEventName && !eventNameDirty ? 'italic' : 'normal',
              }}
            />
          </div>

          <div>
            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
              {t('vacay.location')}
            </label>
            <input
              type="text"
              value={location}
              onChange={e => { setLocation(e.target.value); setLocationDirty(true) }}
              placeholder={mixedLocation && !locationDirty ? mixedPlaceholder : t('vacay.optional')}
              style={{
                ...inputStyle,
                fontStyle: mixedLocation && !locationDirty ? 'italic' : 'normal',
              }}
            />
          </div>

          <div>
            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
              {t('vacay.note')}
            </label>
            <textarea
              value={note}
              onChange={e => { setNote(e.target.value); setNoteDirty(true) }}
              placeholder={mixedNote && !noteDirty ? mixedPlaceholder : t('vacay.optional')}
              rows={2}
              style={{
                ...inputStyle,
                resize: 'none',
                fontStyle: mixedNote && !noteDirty ? 'italic' : 'normal',
              }}
            />
          </div>

          {/* Mark through — range extension */}
          <div>
            <label className="text-[11px] font-medium block mb-1" style={{ color: 'var(--text-muted)' }}>
              {t('vacay.markThrough')}
            </label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={e => setEndDate(e.target.value || startDate)}
              style={{ ...inputStyle, width: 'auto' }}
            />
          </div>

          {/* Share details toggle — supports null/indeterminate for mixed state */}
          <button
            type="button"
            onClick={() => setShowDetails(v => v === null ? true : !v)}
            className="flex items-center gap-2.5 w-full text-left py-0.5"
          >
            <div
              className="shrink-0 w-7 h-4 rounded-full transition-colors flex items-center px-0.5"
              style={{
                background: showDetails === null
                  ? 'var(--border-primary)'
                  : showDetails ? 'var(--text-primary)' : 'var(--border-primary)',
              }}
            >
              {showDetails === null ? (
                <div className="w-full flex items-center justify-center">
                  <div className="w-2 h-0.5 rounded-full" style={{ background: 'var(--text-muted)' }} />
                </div>
              ) : (
                <div
                  className="w-3 h-3 rounded-full bg-white transition-transform"
                  style={{ transform: showDetails ? 'translateX(12px)' : 'translateX(0)' }}
                />
              )}
            </div>
            <div>
              <span className="text-[11px] font-medium block" style={{ color: 'var(--text-muted)' }}>
                {t('vacay.shareDetails')}
              </span>
              <span className="text-[10px] leading-tight block" style={{ color: 'var(--text-faint)' }}>
                {t('vacay.shareDetailsHint')}
              </span>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div
          className="px-4 py-3 flex items-center justify-between gap-2"
          style={{ borderTop: '1px solid var(--border-secondary)' }}
        >
          <div>
            {onRemove && (
              <button
                onClick={handleRemove}
                disabled={removing}
                className="px-3 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-40"
                style={{ color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
              >
                {t('vacay.removeEntry')}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border-primary)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 text-xs rounded-lg disabled:opacity-40"
              style={{ background: 'var(--text-primary)', color: 'var(--bg-card)' }}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}
