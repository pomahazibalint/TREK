import React from 'react'

interface PriceLevelBadgeProps {
  level: number | null | undefined
  variant?: 'chip' | 'text'
}

export default function PriceLevelBadge({ level, variant = 'text' }: PriceLevelBadgeProps): React.ReactElement | null {
  if (level == null) return null

  const pct = (level / 4) * 100

  if (variant === 'chip') {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 99, fontSize: 12, background: '#ecfdf5', color: '#059669' }}>
        <span style={{ position: 'relative', display: 'inline-flex', fontSize: 12, lineHeight: 1, letterSpacing: 0 }}>
          <span style={{ color: '#059669', opacity: 0.25 }}>$$$$</span>
          <span style={{ position: 'absolute', left: 0, top: 0, overflow: 'hidden', width: `${pct}%`, color: '#059669' }}>$$$$</span>
        </span>
      </div>
    )
  }

  return (
    <span style={{ position: 'relative', display: 'inline-flex', fontSize: 11, lineHeight: 1, letterSpacing: 0, color: '#059669' }}>
      <span style={{ color: '#059669', opacity: 0.25 }}>$$$$</span>
      <span style={{ position: 'absolute', left: 0, top: 0, overflow: 'hidden', width: `${pct}%`, color: '#059669' }}>$$$$</span>
    </span>
  )
}
