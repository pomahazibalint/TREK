import React, { useMemo } from 'react'

interface ElevationChartProps {
  profile: number[]
  distance: number // total route distance in meters
}

export default function ElevationChart({ profile, distance }: ElevationChartProps) {
  const { points, minEl, maxEl } = useMemo(() => {
    if (!profile || profile.length < 2) return { points: '', minEl: 0, maxEl: 0 }
    const minEl = Math.min(...profile)
    const maxEl = Math.max(...profile)
    const range = maxEl - minEl || 1
    const W = 300
    const H = 60
    const pts = profile.map((el, i) => {
      const x = (i / (profile.length - 1)) * W
      const y = H - ((el - minEl) / range) * H
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    const area = [`0,${H}`, ...pts, `${W},${H}`].join(' ')
    return { points: area, minEl, maxEl }
  }, [profile])

  if (!profile || profile.length < 2) return null

  const distKm = (distance / 1000).toFixed(1)

  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 500,
      background: 'var(--bg-card, rgba(255,255,255,0.95))',
      backdropFilter: 'blur(8px)',
      borderTop: '1px solid var(--border-faint)',
      padding: '6px 12px 8px',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Elevation</span>
        <div style={{ display: 'flex', gap: 10 }}>
          <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>↑ {Math.round(maxEl)}m</span>
          <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>↓ {Math.round(minEl)}m</span>
          <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>{distKm} km</span>
        </div>
      </div>
      <svg width="100%" viewBox="0 0 300 60" preserveAspectRatio="none" style={{ display: 'block', height: 50 }}>
        <defs>
          <linearGradient id="elev-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent, #6366f1)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="var(--accent, #6366f1)" stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <polygon points={points} fill="url(#elev-grad)" />
        <polyline
          points={profile.map((el, i) => {
            const minEl = Math.min(...profile)
            const maxEl = Math.max(...profile)
            const range = maxEl - minEl || 1
            const x = (i / (profile.length - 1)) * 300
            const y = 60 - ((el - minEl) / range) * 60
            return `${x.toFixed(1)},${y.toFixed(1)}`
          }).join(' ')}
          fill="none"
          stroke="var(--accent, #6366f1)"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  )
}
