import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useVacayStore } from '../../store/vacayStore'
import { useAuthStore } from '../../store/authStore'
import { useTranslation } from '../../i18n'
import { isWeekend } from './holidays'
import VacayMonthCard from './VacayMonthCard'
import VacayEntryPopover from './VacayEntryPopover'
import { Building2, MousePointer2 } from 'lucide-react'
import type { VacayEntry } from '../../types'

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getDatesInRange(start: string, end: string, blocked: (d: string) => boolean): string[] {
  const dates: string[] = []
  const d = new Date(start + 'T00:00:00')
  const last = new Date(end + 'T00:00:00')
  while (d <= last) {
    const s = localDateStr(d)
    if (!blocked(s)) dates.push(s)
    d.setDate(d.getDate() + 1)
  }
  return dates
}

interface PrefillData {
  eventName: string;  eventNameMixed: boolean
  location: string;   locationMixed: boolean
  note: string;       noteMixed: boolean
  showDetails: boolean; showDetailsMixed: boolean
}

interface PopoverState {
  startDate: string
  endDate: string
  existingEntry?: VacayEntry
  prefill?: PrefillData
  allExist?: boolean
  pos: { x: number; y: number }
}

export default function VacayCalendar() {
  const { t } = useTranslation()
  const store = useVacayStore()
  const { selectedYear, selectedUserId, entries, companyHolidays, toggleEntry, saveEntryDetails, removeEntries, plan, users, holidays, shareDetailsDefault } = store
  const { user: currentUser } = useAuthStore()
  const [companyMode, setCompanyMode] = useState(false)
  const [dragAnchor, setDragAnchor] = useState<string | null>(null)
  const [dragCursor, setDragCursor] = useState<string | null>(null)
  const dragCursorRef = useRef<string | null>(null)
  const [popover, setPopover] = useState<PopoverState | null>(null)

  const companyHolidaySet = useMemo(() => {
    const s = new Set<string>()
    companyHolidays.forEach(h => s.add(typeof h === 'string' ? h : (h as any).date))
    return s
  }, [companyHolidays])

  const entryMap = useMemo(() => {
    const map: Record<string, VacayEntry[]> = {}
    entries.forEach(e => {
      if (!map[e.date]) map[e.date] = []
      map[e.date].push(e)
    })
    return map
  }, [entries])

  const blockWeekends = plan?.block_weekends !== false
  const weekendDays: number[] = plan?.weekend_days ? String(plan.weekend_days).split(',').map(Number) : [0, 6]
  const companyHolidaysEnabled = plan?.company_holidays_enabled !== false

  // Stable ref for values needed in document-level event handlers
  const ctxRef = useRef({
    dragAnchor, dragCursor, dragMoved: false,
    companyMode, holidays, companyHolidaySet, blockWeekends, weekendDays,
    companyHolidaysEnabled, selectedUserId, currentUser, entryMap,
    toggleEntry, saveEntryDetails, removeEntries, shareDetailsDefault,
  })
  ctxRef.current = {
    dragAnchor, dragCursor, dragMoved: ctxRef.current.dragMoved,
    companyMode, holidays, companyHolidaySet, blockWeekends, weekendDays,
    companyHolidaysEnabled, selectedUserId, currentUser, entryMap,
    toggleEntry, saveEntryDetails, removeEntries, shareDetailsDefault,
  }

  const isBlocked = useCallback((dateStr: string) => {
    const { holidays, companyHolidaySet, blockWeekends, weekendDays, companyHolidaysEnabled } = ctxRef.current
    if (holidays[dateStr]) return true
    if (blockWeekends && isWeekend(dateStr, weekendDays)) return true
    if (companyHolidaysEnabled && companyHolidaySet.has(dateStr)) return true
    return false
  }, [])

  // Document-level mouseup to resolve drag vs click
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const ctx = ctxRef.current
      if (!ctx.dragAnchor || ctx.companyMode) return

      const anchor = ctx.dragAnchor
      const cursor = dragCursorRef.current || anchor
      const moved = ctx.dragMoved
      ctxRef.current.dragMoved = false
      dragCursorRef.current = null

      setDragAnchor(null)
      setDragCursor(null)

      const [start, end] = anchor <= cursor ? [anchor, cursor] : [cursor, anchor]

      if (!moved) {
        // Single click
        if (isBlocked(anchor)) return
        const ownEntry = ctx.entryMap[anchor]?.find(entry => entry.user_id === ctx.currentUser?.id)
        const actingAsOther = ctx.selectedUserId && ctx.selectedUserId !== ctx.currentUser?.id

        if (actingAsOther) {
          // Owner managing another user — just toggle
          ctx.toggleEntry(anchor, ctx.selectedUserId ?? undefined)
          return
        }

        if (!ownEntry) {
          // Mark immediately, open popover for optional details
          ctx.toggleEntry(anchor)
        }
        setPopover({ startDate: anchor, endDate: anchor, existingEntry: ownEntry, pos: { x: e.clientX, y: e.clientY } })
      } else {
        // Drag range — open popover for the range
        const unblocked = getDatesInRange(start, end, isBlocked)
        if (unblocked.length === 0) return
        const allExist = unblocked.every(d => ctx.entryMap[d]?.find(entry => entry.user_id === ctx.currentUser?.id))
        // Mark all unmarked days in range first
        const unmarked = unblocked.filter(d => !ctx.entryMap[d]?.find(entry => entry.user_id === ctx.currentUser?.id))
        if (unmarked.length > 0) {
          ctx.saveEntryDetails(unmarked, '', '', '', ctx.shareDetailsDefault ? 1 : 0)
        }
        // Derive pre-fill from existing entries; flag fields that differ across days
        const existing = unblocked
          .map(d => ctx.entryMap[d]?.find(entry => entry.user_id === ctx.currentUser?.id))
          .filter(Boolean) as VacayEntry[]
        const ref = existing[0]
        const prefill: PrefillData | undefined = existing.length > 0 ? {
          eventName: ref?.event_name || '',
          eventNameMixed: !existing.every(e => e.event_name === ref?.event_name),
          location:  ref?.location  || '',
          locationMixed:  !existing.every(e => e.location  === ref?.location),
          note:      ref?.note      || '',
          noteMixed:      !existing.every(e => e.note      === ref?.note),
          showDetails: ref?.show_details !== 0,
          showDetailsMixed: !existing.every(e => e.show_details === ref?.show_details),
        } : undefined
        setPopover({ startDate: start, endDate: end, prefill, allExist, pos: { x: e.clientX, y: e.clientY } })
      }
    }

    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [isBlocked])

  const handleCellClick = useCallback((dateStr: string) => {
    // Only used for company mode
    if (!companyMode || !companyHolidaysEnabled) return
    store.toggleCompanyHoliday(dateStr)
  }, [companyMode, companyHolidaysEnabled, store.toggleCompanyHoliday])

  const handleCellMouseDown = useCallback((dateStr: string) => {
    if (companyMode) return
    ctxRef.current.dragMoved = false
    dragCursorRef.current = dateStr
    setDragAnchor(dateStr)
    setDragCursor(dateStr)
  }, [companyMode])

  const handleCellMouseEnter = useCallback((dateStr: string) => {
    if (ctxRef.current.dragAnchor === null || companyMode) return
    if (dateStr !== ctxRef.current.dragAnchor) ctxRef.current.dragMoved = true
    dragCursorRef.current = dateStr
    setDragCursor(dateStr)
  }, [companyMode])

  const [selStart, selEnd] = useMemo(() => {
    if (!dragAnchor || !dragCursor) return [null, null]
    return dragAnchor <= dragCursor ? [dragAnchor, dragCursor] : [dragCursor, dragAnchor]
  }, [dragAnchor, dragCursor])

  const handlePopoverSave = useCallback(async ({ eventName, location, note, showDetails, endDate }: { eventName: string | null; location: string | null; note: string | null; showDetails: number | null; endDate: string }) => {
    if (!popover) return
    const start = popover.startDate
    const [s, e] = start <= endDate ? [start, endDate] : [endDate, start]
    const dates = getDatesInRange(s, e, isBlocked)
    if (dates.length > 0) {
      await saveEntryDetails(dates, note, eventName, location, showDetails)
    }
  }, [popover, isBlocked, saveEntryDetails])

  const handlePopoverRemove = useCallback(async () => {
    if (!popover) return
    if (popover.existingEntry) {
      await toggleEntry(popover.startDate)
    } else {
      const dates = getDatesInRange(popover.startDate, popover.endDate, () => false)
      await removeEntries(dates)
    }
  }, [popover, toggleEntry, removeEntries, isBlocked])

  const selectedUser = users.find(u => u.id === selectedUserId)

  return (
    <div onMouseLeave={() => { if (dragAnchor) { ctxRef.current.dragMoved = false; setDragAnchor(null); setDragCursor(null) } }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3" style={{ userSelect: 'none' }}>
        {Array.from({ length: 12 }, (_, i) => (
          <VacayMonthCard
            key={i}
            year={selectedYear}
            month={i}
            holidays={holidays}
            companyHolidaySet={companyHolidaySet}
            companyHolidaysEnabled={companyHolidaysEnabled}
            entryMap={entryMap}
            onCellClick={handleCellClick}
            onCellMouseDown={handleCellMouseDown}
            onCellMouseEnter={handleCellMouseEnter}
            companyMode={companyMode}
            blockWeekends={blockWeekends}
            weekendDays={weekendDays}
            selectionStart={selStart}
            selectionEnd={selEnd}
            currentUserId={currentUser?.id}
          />
        ))}
      </div>

      {/* Floating toolbar */}
      <div className="sticky bottom-3 sm:bottom-4 mt-3 sm:mt-4 flex items-center justify-center z-30 px-2">
        <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 rounded-xl border" style={{ background: 'var(--bg-card)', borderColor: 'var(--border-primary)', boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
          <button
            onClick={() => setCompanyMode(false)}
            className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all"
            style={{
              background: !companyMode ? 'var(--text-primary)' : 'transparent',
              color: !companyMode ? 'var(--bg-card)' : 'var(--text-muted)',
              border: companyMode ? '1px solid var(--border-primary)' : '1px solid transparent',
            }}>
            <MousePointer2 size={13} />
            {selectedUser && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: selectedUser.color }} />}
            {selectedUser ? selectedUser.username : t('vacay.modeVacation')}
          </button>
          {companyHolidaysEnabled && (
            <button
              onClick={() => setCompanyMode(true)}
              className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1.5 rounded-lg text-[11px] sm:text-xs font-medium transition-all"
              style={{
                background: companyMode ? '#d97706' : 'transparent',
                color: companyMode ? '#fff' : 'var(--text-muted)',
                border: !companyMode ? '1px solid var(--border-primary)' : '1px solid transparent',
              }}>
              <Building2 size={13} />
              {t('vacay.modeCompany')}
            </button>
          )}
        </div>
      </div>

      {popover && (
        <VacayEntryPopover
          startDate={popover.startDate}
          initialEndDate={popover.endDate}
          existingEntry={popover.existingEntry}
          prefill={popover.prefill}
          shareDetailsDefault={shareDetailsDefault}
          pos={popover.pos}
          onClose={() => setPopover(null)}
          onSave={handlePopoverSave}
          onRemove={(popover.existingEntry || popover.allExist) ? handlePopoverRemove : undefined}
        />
      )}
    </div>
  )
}
