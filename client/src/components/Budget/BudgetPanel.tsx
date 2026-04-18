import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTranslation } from '../../i18n'
import { Plus, Trash2, Calculator, Wallet, Pencil, Info, ChevronDown, ChevronRight, Download, X, RefreshCw, Paperclip, Upload, FileEdit } from 'lucide-react'
import ExpenseModal from './ExpenseModal'
import { budgetApi } from '../../api/client'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import type { BudgetItem, BudgetMember } from '../../types'
import { currencyDecimals } from '../../utils/formatters'

interface TripMember {
  id: number
  username: string
  avatar_url?: string | null
}

interface PieSegment {
  label: string
  value: number
  color: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const CURRENCIES = [
  'EUR', 'USD', 'GBP', 'JPY', 'CHF', 'CZK', 'PLN', 'SEK', 'NOK', 'DKK',
  'TRY', 'THB', 'AUD', 'CAD', 'NZD', 'BRL', 'MXN', 'INR', 'IDR', 'MYR',
  'PHP', 'SGD', 'KRW', 'CNY', 'HKD', 'TWD', 'ZAR', 'AED', 'SAR', 'ILS',
  'EGP', 'MAD', 'HUF', 'RON', 'BGN', 'ISK', 'UAH', 'BDT', 'LKR', 'VND',
  'CLP', 'COP', 'PEN', 'ARS',
]
const SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', JPY: '¥', CHF: 'CHF', CZK: 'Kč', PLN: 'zł',
  SEK: 'kr', NOK: 'kr', DKK: 'kr', TRY: '₺', THB: '฿', AUD: 'A$', CAD: 'C$',
  NZD: 'NZ$', BRL: 'R$', MXN: 'MX$', INR: '₹', IDR: 'Rp', MYR: 'RM',
  PHP: '₱', SGD: 'S$', KRW: '₩', CNY: '¥', HKD: 'HK$', TWD: 'NT$',
  ZAR: 'R', AED: 'د.إ', SAR: '﷼', ILS: '₪', EGP: 'E£', MAD: 'MAD',
  HUF: 'Ft', RON: 'lei', BGN: 'лв', ISK: 'kr', UAH: '₴', BDT: '৳',
  LKR: 'Rs', VND: '₫', CLP: 'CL$', COP: 'CO$', PEN: 'S/.', ARS: 'AR$',
}
const PIE_COLORS = ['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4','#84cc16','#a855f7']

const fmtNum = (v: number | null | undefined, locale: string, cur: string) => {
  if (v == null || isNaN(v)) return '-'
  const d = currencyDecimals(cur)
  return Number(v).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + (SYMBOLS[cur] || cur)
}

// ── Inline Edit Cell ──────────────────────────────────────────────────────────
function InlineEditCell({ value, onSave, type = 'text', style = {}, placeholder = '', decimals = 2, locale, editTooltip, readOnly = false }: any) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value ?? '')
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select() } }, [editing])

  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), 1200)
    return () => clearTimeout(timer)
  }, [saved])

  const save = () => {
    setEditing(false)
    let v: any = editValue
    if (type === 'number') { const p = parseFloat(String(editValue).replace(',', '.')); v = isNaN(p) ? null : p }
    if (v !== value) { onSave(v); setSaved(true) }
  }

  if (editing) {
    return <input ref={inputRef} type="text" inputMode={type === 'number' ? 'decimal' : 'text'} value={editValue}
      onChange={e => setEditValue(e.target.value)} onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditValue(value ?? ''); setEditing(false) } }}
      style={{ width: '100%', border: '1px solid var(--accent)', borderRadius: 4, padding: '4px 6px', fontSize: 13, outline: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', fontFamily: 'inherit', ...style }} />
  }

  const display = type === 'number' && value != null
    ? Number(value).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : (value || '')

  return (
    <div onClick={() => { if (readOnly) return; setEditValue(value ?? ''); setEditing(true) }} title={readOnly ? undefined : editTooltip}
      style={{ cursor: readOnly ? 'default' : 'pointer', padding: '2px 4px', borderRadius: 4, minHeight: 22, display: 'flex', alignItems: 'center', transition: 'background 0.15s, box-shadow 0.15s',
        color: display ? 'var(--text-primary)' : 'var(--text-faint)', fontSize: 13, boxShadow: saved ? '0 0 0 1.5px #10b981' : 'none', ...style }}
      onMouseEnter={e => { if (!readOnly) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { if (!readOnly) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
      {display || placeholder || '-'}
    </div>
  )
}

// ── Chip with tooltip ─────────────────────────────────────────────────────────
function AvatarChip({ label, avatarUrl, size = 20 }: { label: string; avatarUrl: string | null; size?: number }) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)

  const onEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
    }
    setHover(true)
  }

  return (
    <>
      <div ref={ref} onMouseEnter={onEnter} onMouseLeave={() => setHover(false)}
        style={{ width: size, height: size, borderRadius: '50%', border: '2px solid var(--border-primary)', background: 'var(--bg-tertiary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.4, fontWeight: 700,
          color: 'var(--text-muted)', overflow: 'hidden', flexShrink: 0 }}>
        {avatarUrl ? <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : label?.[0]?.toUpperCase()}
      </div>
      {hover && ReactDOM.createPortal(
        <div style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)', pointerEvents: 'none', zIndex: 10000,
          background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint)', whiteSpace: 'nowrap' }}>
          {label}
        </div>, document.body
      )}
    </>
  )
}

// ── Pie Chart ─────────────────────────────────────────────────────────────────
function PieChart({ segments, size = 200, totalLabel }: { segments: PieSegment[]; size?: number; totalLabel: string }) {
  if (!segments.length) return null
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total === 0) return null
  let cumDeg = 0
  const stops = segments.map(seg => {
    const start = cumDeg
    const deg = (seg.value / total) * 360
    cumDeg += deg
    return `${seg.color} ${start}deg ${start + deg}deg`
  }).join(', ')
  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '0 auto' }}>
      <div style={{ width: size, height: size, borderRadius: '50%', background: `conic-gradient(${stops})`, boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }} />
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: size * 0.55, height: size * 0.55,
        borderRadius: '50%', background: 'var(--bg-card)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <Wallet size={18} color="var(--text-faint)" style={{ marginBottom: 2 }} />
        <span style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 500 }}>{totalLabel}</span>
      </div>
    </div>
  )
}


// ── Main Component ────────────────────────────────────────────────────────────
interface BudgetPanelProps {
  tripId: number
  tripMembers?: TripMember[]
}

export default function BudgetPanel({ tripId, tripMembers = [] }: BudgetPanelProps) {
  const { trip, budgetItems, addBudgetItem, updateBudgetItem, deleteBudgetItem, loadBudgetItems } = useTripStore()
  const can = useCanDo()
  const { t, locale } = useTranslation()
  const [newCategoryName, setNewCategoryName] = useState('')
  const [editingCat, setEditingCat] = useState<{ name: string; value: string } | null>(null)
  const [settlement, setSettlement] = useState<{ settlement_currency: string; balances: any[]; flows: any[] } | null>(null)
  const [settlementOpen, setSettlementOpen] = useState(false)
  const [modal, setModal] = useState<{ item: BudgetItem | null; category: string } | null>(null)
  const [draftModal, setDraftModal] = useState<BudgetItem | null>(null)
  const [drafts, setDrafts] = useState<BudgetItem[]>([])
  const [expandedRows, setExpandedRows] = useState<number[]>([])
  const currency = trip?.currency || 'EUR'
  const canEdit = can('budget_edit', trip)

  const fmt = (v: number | null | undefined, cur?: string) => fmtNum(v, locale, cur || currency)
  const hasMultipleMembers = tripMembers.length > 1

  useEffect(() => {
    if (!hasMultipleMembers) return
    budgetApi.settlement(tripId).then(setSettlement).catch(() => {})
  }, [tripId, budgetItems, hasMultipleMembers])

  useEffect(() => { if (tripId) loadBudgetItems(tripId) }, [tripId])
  useEffect(() => { budgetApi.listDrafts(tripId).then((d: any) => setDrafts(d.items || [])).catch(() => {}) }, [tripId, budgetItems])

  const grouped = useMemo(() => (budgetItems || []).filter(i => !(i as any).is_draft).reduce<Record<string, BudgetItem[]>>((acc, item) => {
    const cat = item.category || 'Other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(item)
    return acc
  }, {}), [budgetItems])

  const categoryNames = Object.keys(grouped)
  const grandTotal = (budgetItems || []).reduce((s, i) => s + (i.total_price_ref ?? i.total_price ?? 0), 0)

  const pieSegments = useMemo(() =>
    categoryNames.map((cat, i) => ({
      label: cat,
      value: grouped[cat].reduce((s, x) => s + (x.total_price_ref ?? x.total_price ?? 0), 0),
      color: PIE_COLORS[i % PIE_COLORS.length],
    })).filter(s => s.value > 0),
    [grouped, categoryNames]
  )

  const handleUpdateField = async (id: number, field: string, value: any) => { try { await updateBudgetItem(tripId, id, { [field]: value }) } catch {} }
  const handleDeleteItem = async (id: number) => { try { await deleteBudgetItem(tripId, id) } catch {} }
  const handleDeleteCategory = async (cat: string) => {
    for (const item of grouped[cat] || []) await deleteBudgetItem(tripId, item.id)
  }
  const handleRenameCategory = async (oldName: string, newName: string) => {
    if (!newName.trim() || newName.trim() === oldName) return
    for (const item of grouped[oldName] || []) await updateBudgetItem(tripId, item.id, { category: newName.trim() })
  }
  const handleAddCategory = () => {
    if (!newCategoryName.trim()) return
    addBudgetItem(tripId, { name: t('budget.defaultEntry'), category: newCategoryName.trim(), total_price: 0 })
    setNewCategoryName('')
  }

  const handleExportCsv = () => {
    const sep = ';'
    const esc = (v: any) => { const s = String(v ?? ''); return s.includes(sep) || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s }
    const fmtDate = (iso: string) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) }
    const fmtPrice = (v: number | null | undefined, cur: string) => { if (v == null) return ''; const d = currencyDecimals(cur); return v.toFixed(d) }

    const refCur = settlement?.settlement_currency || currency
    const header = ['Category', 'Name', 'Date', 'Currency', 'Original Total', 'Exchange Rate', `Total (${refCur})`, `Tip (${refCur})`, 'Note']
    const rows = [header.join(sep)]

    for (const cat of categoryNames) {
      for (const item of (grouped[cat] || [])) {
        const isForeign = item.currency !== refCur
        rows.push([
          esc(item.category),
          esc(item.name),
          esc(fmtDate(item.expense_date || '')),
          item.currency,
          isForeign ? fmtPrice(item.total_price, item.currency) : '',
          isForeign && item.exchange_rate ? item.exchange_rate : '',
          fmtPrice(item.total_price_ref ?? item.total_price, refCur),
          item.tip_ref > 0 ? fmtPrice(item.tip_ref, refCur) : '',
          esc(item.note || ''),
        ].join(sep))
      }
    }

    const bom = '\uFEFF'
    const blob = new Blob([bom + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const safeName = (trip?.title || 'trip').replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, '').trim()
    a.download = `budget-${safeName}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const th: any = { padding: '5px 8px', textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-primary)', whiteSpace: 'nowrap', background: 'var(--bg-secondary)' }
  const td: any = { padding: '4px 6px', borderBottom: '1px solid var(--border-secondary)', fontSize: 13, verticalAlign: 'middle', color: 'var(--text-primary)' }

  if (!budgetItems || budgetItems.length === 0) {
    return (
      <div style={{ padding: 24, maxWidth: 600, margin: '60px auto', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
          <Calculator size={28} color="#6b7280" />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' }}>{t('budget.emptyTitle')}</h2>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 24px', lineHeight: 1.5 }}>{t('budget.emptyText')}</p>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'stretch', maxWidth: 320, margin: '0 auto' }}>
            <input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddCategory()}
              placeholder={t('budget.emptyPlaceholder')}
              style={{ flex: 1, padding: '9px 14px', borderRadius: 10, border: '1px solid var(--border-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', minWidth: 0 }} />
            <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
              style={{ background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 10, padding: '0 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', opacity: newCategoryName.trim() ? 1 : 0.5, flexShrink: 0 }}>
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ fontFamily: "'Poppins', -apple-system, BlinkMacSystemFont, system-ui, sans-serif" }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
.budget-expand-btn, .budget-detail-row { display: table-row; }
@media (min-width: 640px) { .budget-expand-btn, .budget-detail-row { display: none !important; } }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 16px 12px', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Calculator size={20} color="var(--text-primary)" />
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{t('budget.title')}</h2>
        </div>
        <button onClick={handleExportCsv} title={t('budget.exportCsv')}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-muted)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
          <Download size={13} /> CSV
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20, padding: '0 16px 40px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {categoryNames.map((cat, ci) => {
            const items = grouped[cat]
            const subtotal = items.reduce((s, x) => s + (x.total_price_ref ?? x.total_price ?? 0), 0)
            const color = PIE_COLORS[ci % PIE_COLORS.length]
            return (
              <div key={cat} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#000', color: '#fff', borderRadius: '10px 10px 0 0', padding: '9px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: color, flexShrink: 0 }} />
                    {canEdit && editingCat?.name === cat ? (
                      <input autoFocus value={editingCat.value}
                        onChange={e => setEditingCat({ ...editingCat, value: e.target.value })}
                        onBlur={() => { handleRenameCategory(cat, editingCat.value); setEditingCat(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') { handleRenameCategory(cat, editingCat.value); setEditingCat(null) } if (e.key === 'Escape') setEditingCat(null) }}
                        style={{ fontWeight: 600, fontSize: 13, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', padding: '1px 6px', outline: 'none', fontFamily: 'inherit', width: '100%' }} />
                    ) : (
                      <>
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{cat}</span>
                        {canEdit && (
                          <button onClick={() => setEditingCat({ name: cat, value: cat })}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', display: 'flex', padding: 1 }}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = '#fff'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.4)'}>
                            <Pencil size={10} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.9 }}>{fmt(subtotal)}</span>
                    {canEdit && (
                      <>
                        <button onClick={() => setModal({ item: null, category: cat })} title={t('budget.addExpense')}
                          style={{ background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: '3px 7px', display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.25)'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.15)'}>
                          <Plus size={11} />
                        </button>
                        <button onClick={() => handleDeleteCategory(cat)} title={t('budget.deleteCategory')}
                          style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center', opacity: 0.6 }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity = '1'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity = '0.6'}>
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div style={{ overflowX: 'auto', border: '1px solid var(--border-primary)', borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{ ...th, textAlign: 'left', minWidth: 120 }}>{t('budget.table.name')}</th>
                        <th style={{ ...th, minWidth: 90 }}>{t('budget.table.total')}</th>
                        {hasMultipleMembers && <th className="hidden sm:table-cell" style={{ ...th, minWidth: 80 }}>{t('budget.table.members')}</th>}
                        <th className="hidden sm:table-cell" style={{ ...th, width: 90, maxWidth: 90 }}>{t('budget.table.date')}</th>
                        <th className="hidden sm:table-cell" style={{ ...th, minWidth: 140 }}>{t('budget.table.note')}</th>
                        <th style={{ ...th, width: canEdit ? 64 : 0 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map(item => {
                        const isForeign = item.currency !== currency
                        const displayRef = item.total_price_ref ?? item.total_price
                        return (
                          <React.Fragment key={item.id}>
                            <tr style={{ transition: 'background 0.1s' }}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}>
                            <td style={td}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                                <div style={{ flex: 1 }}>
                                  <InlineEditCell value={item.name} onSave={(v: string) => handleUpdateField(item.id, 'name', v)} placeholder={t('budget.table.name')} locale={locale} editTooltip={item.reservation_id ? t('budget.linkedToReservation') : t('budget.editTooltip')} readOnly={!canEdit || !!item.reservation_id} />
                                </div>
                                <button onClick={() => setExpandedRows(prev => prev.includes(item.id) ? prev.filter(id => id !== item.id) : [...prev, item.id])} className="budget-expand-btn" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)', alignItems: 'center', flexShrink: 0 }}>
                                  {expandedRows.includes(item.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                </button>
                              </div>
                            </td>
                            <td style={{ ...td, textAlign: 'center' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                                <InlineEditCell value={item.total_price} type="number" decimals={currencyDecimals(item.currency)} onSave={(v: number) => handleUpdateField(item.id, 'total_price', v)} style={{ textAlign: 'center' }} locale={locale} editTooltip={t('budget.editTooltip')} readOnly={!canEdit} />
                                {isForeign && (
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px', borderRadius: 12, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                    <span style={{ fontWeight: 500 }}>{item.currency}</span>
                                    <span style={{ color: 'var(--text-faint)' }}>→</span>
                                    <span style={{ fontWeight: 600 }}>{fmtNum(displayRef, locale, currency)}</span>
                                  </div>
                                )}
                              </div>
                            </td>
                            {hasMultipleMembers && (
                              <td className="hidden sm:table-cell" style={{ ...td, textAlign: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexWrap: 'wrap' }}>
                                  {(() => {
                                    const activeMembers = (item.members || []).filter(m => m.amount_owed_ref > 0)
                                    const shown = activeMembers.slice(0, 5)
                                    const overflow = activeMembers.length - shown.length
                                    return (
                                      <>
                                        {shown.map(m => (
                                          <AvatarChip key={m.user_id} label={m.username || ''} avatarUrl={m.avatar_url || null} size={20} />
                                        ))}
                                        {overflow > 0 && (
                                          <div title={`${overflow} more member(s)`} style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'var(--text-faint)', border: '1px solid var(--border-secondary)' }}>
                                            +{overflow}
                                          </div>
                                        )}
                                        {activeMembers.length === 0 && (
                                          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>—</span>
                                        )}
                                      </>
                                    )
                                  })()}
                                </div>
                              </td>
                            )}
                            <td className="hidden sm:table-cell" style={{ ...td, padding: '2px 6px', width: 90, maxWidth: 90, textAlign: 'center' }}>
                              {canEdit ? (
                                <div style={{ maxWidth: 90, margin: '0 auto' }}>
                                  <CustomDatePicker value={item.expense_date || ''} onChange={v => handleUpdateField(item.id, 'expense_date', v || null)} placeholder="—" compact borderless />
                                </div>
                              ) : (
                                <span style={{ fontSize: 11, color: item.expense_date ? 'var(--text-secondary)' : 'var(--text-faint)' }}>{item.expense_date || '—'}</span>
                              )}
                            </td>
                            <td className="hidden sm:table-cell" style={td}>
                              <InlineEditCell value={item.note} onSave={(v: string) => handleUpdateField(item.id, 'note', v)} placeholder={t('budget.table.note')} locale={locale} editTooltip={t('budget.editTooltip')} readOnly={!canEdit} />
                            </td>
                            <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>
                              {canEdit && (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                  <button onClick={() => setModal({ item, category: cat })} title={t('budget.editExpense')}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-faint)', borderRadius: 4, display: 'inline-flex', transition: 'color 0.15s' }}
                                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-faint)'}>
                                    <Pencil size={13} />
                                  </button>
                                  <button onClick={() => handleDeleteItem(item.id)} title={t('common.delete')}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-faint)', borderRadius: 4, display: 'inline-flex', transition: 'color 0.15s' }}
                                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = '#ef4444'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = '#d1d5db'}>
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                          {expandedRows.includes(item.id) && (
                            <tr className="budget-detail-row" style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-secondary)' }}>
                              <td colSpan={6} style={{ padding: '8px 12px', fontSize: 12 }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {item.expense_date && (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t('budget.table.date')}</span>
                                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{item.expense_date}</span>
                                    </div>
                                  )}
                                  {item.note && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t('budget.table.note')}</span>
                                      <span style={{ color: 'var(--text-secondary)' }}>{item.note}</span>
                                    </div>
                                  )}
                                  {!item.expense_date && !item.note && (
                                    <span style={{ color: 'var(--text-faint)', fontSize: 11, fontStyle: 'italic' }}>—</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>

        {/* Sidebar */}
        <div className="w-full md:w-[240px]" style={{ flexShrink: 0, position: 'sticky', top: 16, alignSelf: 'flex-start' }}>
          {canEdit && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddCategory() }}
                placeholder={t('budget.categoryName')}
                style={{ flex: 1, border: '1px solid var(--border-primary)', borderRadius: 10, padding: '9px 14px', fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
              <button onClick={handleAddCategory} disabled={!newCategoryName.trim()}
                style={{ background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 10, padding: '9px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', opacity: newCategoryName.trim() ? 1 : 0.4, flexShrink: 0 }}>
                <Plus size={16} />
              </button>
            </div>
          )}

          {/* Total card */}
          <div style={{ background: 'linear-gradient(135deg, #000 0%, #18181b 100%)', borderRadius: 16, padding: '24px 20px', color: '#fff', marginBottom: 16, boxShadow: '0 8px 32px rgba(15,23,42,0.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Wallet size={18} color="rgba(255,255,255,0.8)" />
              </div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: 500, letterSpacing: 0.5 }}>{t('budget.totalBudget')}</div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, marginBottom: 4 }}>
              {Number(grandTotal).toLocaleString(locale, { minimumFractionDigits: currencyDecimals(currency), maximumFractionDigits: currencyDecimals(currency) })}
            </div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>{SYMBOLS[currency] || currency} {currency}</div>

            {/* Per-person balances from settlement */}
            {hasMultipleMembers && settlement && settlement.balances.length > 0 && (
              <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {settlement.balances.map(b => (
                  <div key={b.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', flexShrink: 0 }}>
                      {b.avatar_url ? <img src={b.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : b.username?.[0]?.toUpperCase()}
                    </div>
                    <span style={{ flex: 1, fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.65)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.username}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: b.balance > 0 ? '#4ade80' : b.balance < 0 ? '#f87171' : 'rgba(255,255,255,0.4)' }}>
                      {b.balance > 0 ? '+' : ''}{fmtNum(b.balance, locale, settlement.settlement_currency)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Settlement flows */}
            {hasMultipleMembers && settlement && settlement.flows.length > 0 && (
              <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 12 }}>
                <button onClick={() => setSettlementOpen(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit', color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: 600, letterSpacing: 0.5 }}>
                  {settlementOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {t('budget.settlement')}
                  <span style={{ position: 'relative', display: 'inline-flex', marginLeft: 2 }}>
                    <span style={{ display: 'flex', cursor: 'help' }}
                      onMouseEnter={e => { const tip = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement; if (tip) tip.style.display = 'block' }}
                      onMouseLeave={e => { const tip = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement; if (tip) tip.style.display = 'none' }}
                      onClick={e => e.stopPropagation()}>
                      <Info size={11} strokeWidth={2} />
                    </span>
                    <div style={{ display: 'none', position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 6, width: 220, padding: '10px 12px', borderRadius: 10, zIndex: 100, background: 'var(--bg-card)', border: '1px solid var(--border-faint)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)', fontSize: 11, fontWeight: 400, color: 'var(--text-secondary)', lineHeight: 1.5, textAlign: 'left' }}>
                      {t('budget.settlementInfo')}
                    </div>
                  </span>
                </button>
                {settlementOpen && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {settlement.flows.map((flow, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '7px 10px', borderRadius: 10, background: 'rgba(255,255,255,0.06)' }}>
                        <AvatarChip label={flow.from.username} avatarUrl={flow.from.avatar_url} size={26} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>→</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171', whiteSpace: 'nowrap' }}>
                            {fmtNum(flow.amount, locale, settlement.settlement_currency)}
                          </span>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>→</span>
                        </div>
                        <AvatarChip label={flow.to.username} avatarUrl={flow.to.avatar_url} size={26} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Draft entries — excluded from totals */}
          {drafts.length > 0 && (
            <div style={{ background: 'var(--bg-card)', borderRadius: 16, border: '1px solid rgba(245,158,11,0.3)', marginBottom: 16, overflow: 'hidden' }}>
              <div style={{ padding: '10px 16px', background: 'rgba(245,158,11,0.06)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileEdit size={13} style={{ color: '#d97706' }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Planned / Draft ({drafts.length})</span>
                <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 4 }}>— not included in totals or settlement</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {drafts.map(draft => (
                      <tr key={draft.id} style={{ borderTop: '1px solid var(--border-faint)', cursor: 'pointer', transition: 'background 0.1s' }}
                        onClick={() => setDraftModal(draft)}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}>
                        <td style={{ padding: '8px 16px', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{draft.name}</td>
                        <td style={{ padding: '8px 16px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtNum(draft.total_price, locale, draft.currency)}</td>
                        <td style={{ padding: '8px 16px', fontSize: 11, color: 'var(--text-faint)', textAlign: 'right', whiteSpace: 'nowrap' }}>{draft.expense_date || '—'}</td>
                        <td style={{ padding: '8px 16px', textAlign: 'right' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 4, background: 'rgba(245,158,11,0.1)', color: '#d97706', border: '1px solid rgba(245,158,11,0.2)' }}>DRAFT</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Pie chart */}
          {pieSegments.length > 0 && (
            <div style={{ background: 'var(--bg-card)', borderRadius: 16, padding: '20px 16px', border: '1px solid var(--border-primary)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 16, textAlign: 'center' }}>{t('budget.byCategory')}</div>
              <PieChart segments={pieSegments} size={180} totalLabel={t('budget.total')} />
              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pieSegments.map((seg, i) => {
                  const pct = grandTotal > 0 ? ((seg.value / grandTotal) * 100).toFixed(1) : '0.0'
                  return (
                    <div key={seg.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 3, background: PIE_COLORS[i % PIE_COLORS.length], flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>{seg.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-faint)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(seg.value)}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', minWidth: 38, textAlign: 'right' }}>{pct}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {modal && (
        <ExpenseModal
          item={modal.item}
          category={modal.category}
          tripId={tripId}
          tripCurrency={currency}
          tripMembers={tripMembers}
          categories={categoryNames}
          locale={locale}
          t={t}
          onSave={() => setModal(null)}
          onClose={() => setModal(null)}
        />
      )}

      {draftModal && (
        <ExpenseModal
          item={draftModal}
          category={draftModal.category || 'Activities'}
          tripId={tripId}
          tripCurrency={currency}
          tripMembers={tripMembers}
          categories={categoryNames}
          locale={locale}
          t={t}
          isDraft
          onSave={() => { setDraftModal(null); budgetApi.listDrafts(tripId).then((d: any) => setDrafts(d.items || [])).catch(() => {}) }}
          onClose={() => setDraftModal(null)}
          onConvert={() => { setDraftModal(null); budgetApi.listDrafts(tripId).then((d: any) => setDrafts(d.items || [])).catch(() => {}); loadBudgetItems(tripId) }}
        />
      )}
    </div>
  )
}
