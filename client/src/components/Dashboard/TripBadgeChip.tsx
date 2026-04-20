import React, { useState, useRef, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Info, ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TripBadge } from '../../types'

interface TripBadgeChipProps {
  badges: TripBadge[]
}

export default function TripBadgeChip({ badges }: TripBadgeChipProps): React.ReactElement | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      if (popoverRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (badges.length === 0) return null

  const top = badges[0]
  const rest = badges.slice(1)
  const isWarning = top.priority === 'warning'

  const chipColor = isWarning ? '#f59e0b' : '#6b7280'
  const chipBg = isWarning ? 'rgba(245,158,11,0.1)' : 'var(--bg-tertiary)'
  const chipBorder = isWarning ? 'rgba(245,158,11,0.3)' : 'var(--border-primary)'

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 6, left: rect.left })
    setOpen(v => !v)
  }

  const handleAction = (e: React.MouseEvent, badge: TripBadge) => {
    e.stopPropagation()
    setOpen(false)
    if (badge.actionCallback) {
      badge.actionCallback()
    } else {
      navigate(badge.actionPath)
    }
  }

  const popover = open && ReactDOM.createPortal(
    <div ref={popoverRef} style={{
      position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999,
      minWidth: 240, maxWidth: 300,
      background: 'var(--bg-card)', border: '1px solid var(--border-primary)',
      borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
      padding: '8px 0',
    }}>
      {badges.map((badge, i) => {
        const warn = badge.priority === 'warning'
        return (
          <div key={badge.key} style={{
            padding: '8px 14px',
            borderTop: i > 0 ? '1px solid var(--border-faint)' : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              {warn
                ? <AlertTriangle size={11} color="#f59e0b" style={{ flexShrink: 0 }} />
                : <Info size={11} color="var(--text-faint)" style={{ flexShrink: 0 }} />}
              <span style={{ fontSize: 12, fontWeight: 600, color: warn ? '#d97706' : 'var(--text-secondary)' }}>
                {t(badge.labelKey, badge.labelParams as any)}
              </span>
            </div>
            <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, paddingLeft: 17 }}>
              {t(badge.detailKey)}
            </p>
            <button
              onClick={e => handleAction(e, badge)}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, marginLeft: 17,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'inherit',
              }}>
              {t(badge.actionKey)} <ChevronRight size={10} />
            </button>
          </div>
        )
      })}
    </div>,
    document.body
  )

  return (
    <>
      <div
        ref={ref}
        onClick={handleOpen}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 99,
          background: chipBg, border: `1px solid ${chipBorder}`,
          cursor: 'pointer', userSelect: 'none',
        }}
      >
        {isWarning
          ? <AlertTriangle size={10} color={chipColor} style={{ flexShrink: 0 }} />
          : <Info size={10} color={chipColor} style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: 10.5, fontWeight: 600, color: chipColor, whiteSpace: 'nowrap' }}>
          {t(top.labelKey, top.labelParams as any)}
        </span>
        {rest.length > 0 && (
          <span style={{ fontSize: 10, fontWeight: 600, color: chipColor, opacity: 0.7 }}>
            {t('tripBadge.more', { count: rest.length })}
          </span>
        )}
      </div>
      {popover}
    </>
  )
}
