import ReactDOM from 'react-dom'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useTripStore } from '../../store/tripStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTranslation } from '../../i18n'
import { Plus, Trash2, Calculator, Wallet, Pencil, Info, ChevronDown, ChevronRight, Download, X, RefreshCw, Paperclip, Upload } from 'lucide-react'
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

// ── Expense Modal ─────────────────────────────────────────────────────────────
interface ExpenseModalProps {
  item: BudgetItem | null        // null = new item
  category: string
  tripId: number
  tripCurrency: string
  tripMembers: TripMember[]
  categories: string[]
  locale: string
  onSave: (itemId: number) => void
  onClose: () => void
  t: (k: string) => string
}

function ExpenseModal({ item, category, tripId, tripCurrency, tripMembers, categories, locale, onSave, onClose, t }: ExpenseModalProps) {
  const { addBudgetItem, updateBudgetItem, setBudgetItemMemberOwed, setBudgetItemMemberPayments } = useTripStore()

  const [name, setName] = useState(item?.name || '')
  const [totalPrice, setTotalPrice] = useState(item?.total_price ?? 0)
  const [itemCurrency, setItemCurrency] = useState(item?.currency || tripCurrency)
  const isForeignCurrency = itemCurrency !== tripCurrency
  const [totalPriceRef, setTotalPriceRef] = useState<number>(
    item?.total_price_ref ?? (item?.total_price || 0)
  )
  const [exchangeRate, setExchangeRate] = useState<number | null>(item?.exchange_rate ?? null)
  const [note, setNote] = useState(item?.note || '')
  const [expenseDate, setExpenseDate] = useState(item?.expense_date || '')
  const [selectedCategory, setSelectedCategory] = useState(item?.category || category)

  const [tip, setTip] = useState(() => {
    if (!item) return 0
    const tipRef = item.tip_ref || 0
    const isForeign = item.currency !== tripCurrency
    const rate = (isForeign && item.exchange_rate) ? item.exchange_rate : 1
    return isForeign ? Math.round(tipRef / rate * 100) / 100 : tipRef
  })

  const [fetchingRate, setFetchingRate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [receipts, setReceipts] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const receiptInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!item?.id) return
    budgetApi.listFiles(tripId, item.id).then((d: any) => setReceipts(d.files || [])).catch(() => {})
  }, [item?.id, tripId])

  const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !item?.id) return
    e.target.value = ''
    setUploading(true)
    try {
      await budgetApi.uploadReceipt(tripId, item.id, file)
      const d: any = await budgetApi.listFiles(tripId, item.id)
      setReceipts(d.files || [])
    } catch {} finally { setUploading(false) }
  }

  // Per-member rows: { user_id, owed, paid }
  type MemberRow = { user_id: number; owed: number; paid: number }
  const initRows = useCallback((): MemberRow[] => {
    const rate = (item?.currency !== tripCurrency && item?.exchange_rate) ? item.exchange_rate : 1
    const storedIsForeign = item?.currency !== tripCurrency

    if (!item || !item.members?.length) {
      return tripMembers.map(m => ({ user_id: m.id, owed: 0, paid: 0 }))
    }
    const rowsByUser = new Map(item.members.map(m => [m.user_id, m]))
    // Show all trip members; pre-fill from stored values (convert to original currency if needed)
    return tripMembers.map(m => {
      const stored = rowsByUser.get(m.id)
      const o = stored?.amount_owed_ref || 0
      const p = stored?.amount_paid_ref || 0
      return {
        user_id: m.id,
        owed: storedIsForeign ? Math.round(o / rate * 100) / 100 : o,
        paid: storedIsForeign ? Math.round(p / rate * 100) / 100 : p
      }
    })
  }, [item, tripMembers, tripCurrency])

  const [rows, setRows] = useState<MemberRow[]>(initRows)

  const owedSum = rows.reduce((s, r) => s + r.owed, 0)
  const paidSum = rows.reduce((s, r) => r.paid > 0 ? s + r.paid : s, 0)
  const owedTotal = owedSum + tip
  // Balance against original amount (totalPrice) instead of reference amount
  const target = totalPrice
  const owedDelta = Math.abs(owedTotal - target)
  const paidDelta = paidSum > 0.01 ? Math.abs(paidSum - target) : 0
  const owedBalanced = owedDelta < 0.01
  const paidBalanced = paidSum < 0.01 || Math.abs(paidSum - target) < 0.01

  const equalSplitOwed = () => {
    const base = totalPrice - tip
    const n = rows.length
    if (n === 0) return
    const each = Math.round(base / n * 100) / 100
    const shares = rows.map((_, i) =>
      i === n - 1 ? Math.round((base - each * (n - 1)) * 100) / 100 : each
    )
    setRows(prev => prev.map((r, i) => ({ ...r, owed: shares[i] })))
  }

  const equalSplitPaid = () => {
    const n = rows.length
    if (n === 0) return
    const each = Math.round(totalPrice / n * 100) / 100
    const shares = rows.map((_, i) =>
      i === n - 1 ? Math.round((totalPrice - each * (n - 1)) * 100) / 100 : each
    )
    setRows(prev => prev.map((r, i) => ({ ...r, paid: shares[i] })))
  }

  const fetchRate = async () => {
    if (!isForeignCurrency) return
    setFetchingRate(true)
    try {
      const resp = await fetch(`https://api.exchangerate-api.com/v4/latest/${itemCurrency}`)
      const data = await resp.json()
      const rate = data.rates?.[tripCurrency]
      if (rate) {
        setExchangeRate(rate)
        const converted = Math.round(totalPrice * rate * 100) / 100
        setTotalPriceRef(converted)
      }
    } catch {}
    setFetchingRate(false)
  }

  // When totalPrice changes for same currency, sync ref
  useEffect(() => {
    if (!isForeignCurrency) setTotalPriceRef(totalPrice)
  }, [totalPrice, isForeignCurrency])

  // When exchange rate changes, recalculate ref
  useEffect(() => {
    if (isForeignCurrency && exchangeRate) {
      setTotalPriceRef(Math.round(totalPrice * exchangeRate * 100) / 100)
    }
  }, [exchangeRate, totalPrice, isForeignCurrency])

  const handleSave = async () => {
    if (!name.trim()) { setError(t('budget.table.name') + ' is required'); return }
    if (!owedBalanced) { setError('Owed amounts + tip must equal the total'); return }
    if (!paidBalanced) { setError('Paid amounts must equal the total or all be zero'); return }
    setSaving(true)
    setError('')
    try {
      const effectiveRate = (isForeignCurrency && totalPrice > 0) ? (totalPriceRef / totalPrice) : 1
      const tipVal = tip || 0
      const tip_ref = isForeignCurrency ? Math.round(tipVal * effectiveRate * 100) / 100 : tipVal

      const itemData = {
        name: name.trim(),
        total_price: totalPrice,
        currency: itemCurrency,
        total_price_ref: isForeignCurrency ? totalPriceRef : null,
        exchange_rate: isForeignCurrency ? (exchangeRate || effectiveRate) : null,
        tip_ref: tip_ref,
        note: note.trim() || null,
        expense_date: expenseDate || null,
        category: selectedCategory,
      }

      let savedId: number
      if (item) {
        const updated = await updateBudgetItem(tripId, item.id, itemData)
        savedId = updated.id
      } else {
        const created = await addBudgetItem(tripId, itemData)
        savedId = created.id
      }

      // Only send members who participate (non-zero owed) for the owes side
      const owedMembers = rows
        .filter(r => r.owed > 0)
        .map(r => ({ user_id: r.user_id, amount_owed_ref: Math.round((r.owed || 0) * effectiveRate * 100) / 100 }))

      // Adjust rounding discrepancy for owed to match totalPriceRef
      if (isForeignCurrency && owedBalanced && owedMembers.length > 0) {
        const sum = owedMembers.reduce((s, m) => s + m.amount_owed_ref, 0) + tip_ref
        const diff = totalPriceRef - sum
        if (Math.abs(diff) < 0.1) {
          owedMembers[0].amount_owed_ref = Math.round((owedMembers[0].amount_owed_ref + diff) * 100) / 100
        }
      }

      if (owedMembers.length > 0 && (owedBalanced || !isForeignCurrency)) {
        await setBudgetItemMemberOwed(tripId, savedId, owedMembers, tip_ref)
      }

      const payments = rows.map(r => ({
        user_id: r.user_id,
        amount_paid_ref: Math.round((r.paid || 0) * effectiveRate * 100) / 100
      }))

      // Adjust rounding discrepancy for payments to match totalPriceRef
      if (isForeignCurrency && paidBalanced && paidSum > 0.01) {
        const sum = payments.reduce((s, p) => s + p.amount_paid_ref, 0)
        const diff = totalPriceRef - sum
        if (Math.abs(diff) < 0.1) {
          const firstPaid = payments.find(p => p.amount_paid_ref > 0)
          if (firstPaid) firstPaid.amount_paid_ref = Math.round((firstPaid.amount_paid_ref + diff) * 100) / 100
        }
      }

      if (paidSum > 0.01 && (paidBalanced || !isForeignCurrency)) {
        await setBudgetItemMemberPayments(tripId, savedId, payments)
      }

      onSave(savedId)
    } catch (err: any) {
      setError(err.message || 'Error saving expense')
    }
    setSaving(false)
  }

  const inp = { border: '1px solid var(--border-primary)', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--bg-input)', color: 'var(--text-primary)', width: '100%' }
  const numInp = (val: number, onChange: (v: number) => void) => (
    <input type="text" inputMode="decimal" value={val === 0 ? '' : String(val)}
      onChange={e => { const n = parseFloat(e.target.value.replace(',', '.')); onChange(isNaN(n) ? 0 : n) }}
      style={{ ...inp, textAlign: 'right', padding: '4px 6px', fontSize: 13, width: '100%', minWidth: 0 }} />
  )

  const DeltaBadge = ({ delta, allZero, cur = tripCurrency }: { delta: number; allZero?: boolean; cur?: string }) => {
    if (allZero) return <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontStyle: 'italic' }}>{t('budget.modal.notReconciled')}</span>
    if (delta < 0.01) return <span style={{ fontSize: 12, fontWeight: 700, color: '#4ade80' }}>{t('budget.modal.balanced')} ✓</span>
    return <span style={{ fontSize: 12, fontWeight: 600, color: '#fb923c' }}>{fmtNum(delta, locale, cur)} {t('budget.modal.remaining')}</span>
  }

  return ReactDOM.createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-card)', borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.25)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 0' }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>
            {item ? t('budget.editExpense') : t('budget.addExpense')}
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#dc2626' }}>{error}</div>}

          {/* Expense details row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10 }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('budget.table.name')} style={inp} />
            <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
              style={{ ...inp, width: 'auto', paddingRight: 28, cursor: 'pointer' }}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <CustomDatePicker value={expenseDate} onChange={setExpenseDate} placeholder="—" compact />
          </div>

          {/* Amount + currency row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>
                {t('budget.modal.originalAmount')} ({itemCurrency})
              </label>
              <input type="text" inputMode="decimal" value={totalPrice === 0 ? '' : String(totalPrice)}
                onChange={e => { const n = parseFloat(e.target.value.replace(',', '.')); setTotalPrice(isNaN(n) ? 0 : n) }}
                style={{ ...inp }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>
                {t('budget.modal.currency')}
              </label>
              <select value={itemCurrency} onChange={e => setItemCurrency(e.target.value)}
                style={{ ...inp, width: 'auto', paddingRight: 28, cursor: 'pointer' }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Reference amount (only for foreign currencies) */}
          {isForeignCurrency && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, padding: '12px', background: 'var(--bg-secondary)', borderRadius: 10 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>
                  {t('budget.modal.referenceAmount')} ({tripCurrency})
                </label>
                <input type="text" inputMode="decimal" value={totalPriceRef === 0 ? '' : String(totalPriceRef)}
                  onChange={e => { const n = parseFloat(e.target.value.replace(',', '.')); setTotalPriceRef(isNaN(n) ? 0 : n) }}
                  style={{ ...inp }} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 4 }}>
                  {t('budget.modal.exchangeRate')}
                </label>
                <input type="text" inputMode="decimal" value={exchangeRate ?? ''}
                  onChange={e => { const n = parseFloat(e.target.value.replace(',', '.')); setExchangeRate(isNaN(n) ? null : n) }}
                  style={{ ...inp }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button onClick={fetchRate} disabled={fetchingRate}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                  <RefreshCw size={12} style={{ animation: fetchingRate ? 'spin 1s linear infinite' : 'none' }} />
                  {t('budget.modal.fetchRate')}
                </button>
              </div>
            </div>
          )}

          {/* Note */}
          <input value={note} onChange={e => setNote(e.target.value)} placeholder={t('budget.table.note')} style={inp} />

          {/* Split table — only show if there are trip members */}
          {tripMembers.length > 0 && (
            <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#000' }}>
                    <th style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.05em', width: '40%' }}></th>
                    <th style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.05em', width: '30%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        {t('budget.modal.owes')} ({itemCurrency})
                        <button onClick={equalSplitOwed} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                          = {t('budget.modal.equalSplit')}
                        </button>
                      </div>
                    </th>
                    <th style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.05em', width: '30%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        {t('budget.modal.paid')} ({itemCurrency})
                        <button onClick={equalSplitPaid} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                          = {t('budget.modal.equalSplit')}
                        </button>
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const member = tripMembers.find(m => m.id === row.user_id)
                    if (!member) return null
                    return (
                      <tr key={row.user_id} style={{ borderTop: '1px solid var(--border-secondary)', background: i % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-secondary)' }}>
                        <td style={{ padding: '7px 12px', fontSize: 13 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--bg-tertiary)', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)' }}>
                              {member.avatar_url ? <img src={member.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : member.username[0]?.toUpperCase()}
                            </div>
                            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{member.username}</span>
                          </div>
                        </td>
                        <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                          {numInp(row.owed, v => setRows(prev => prev.map((r, j) => j === i ? { ...r, owed: v } : r)))}
                          {isForeignCurrency && row.owed > 0 && (
                            <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
                              ≈ {fmtNum(row.owed * (totalPriceRef / (totalPrice || 1)), locale, tripCurrency)}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                          {numInp(row.paid, v => setRows(prev => prev.map((r, j) => j === i ? { ...r, paid: v } : r)))}
                          {isForeignCurrency && row.paid > 0 && (
                            <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
                              ≈ {fmtNum(row.paid * (totalPriceRef / (totalPrice || 1)), locale, tripCurrency)}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}

                  {/* Tip row — owes column only */}
                  <tr style={{ borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                    <td style={{ padding: '7px 12px', fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      {t('budget.modal.tip')}
                    </td>
                    <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                      {numInp(tip, setTip)}
                      {isForeignCurrency && tip > 0 && (
                        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
                          ≈ {fmtNum(tip * (totalPriceRef / (totalPrice || 1)), locale, tripCurrency)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '5px 12px' }} />
                  </tr>

                  {/* Totals row */}
                  <tr style={{ borderTop: '2px solid var(--border-primary)', background: '#000', color: '#fff' }}>
                    <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span>{fmtNum(totalPrice, locale, itemCurrency)}</span>
                        {isForeignCurrency && (
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}>{fmtNum(totalPriceRef, locale, tripCurrency)}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{fmtNum(owedTotal, locale, itemCurrency)}</span>
                        <DeltaBadge delta={owedDelta} cur={itemCurrency} />
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{paidSum > 0.01 ? fmtNum(paidSum, locale, itemCurrency) : '—'}</span>
                        <DeltaBadge delta={paidDelta} allZero={paidSum < 0.01} cur={itemCurrency} />
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* Receipts — only shown when editing an existing item */}
          {item?.id && (
            <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <Paperclip size={11} /> {t('budget.modal.receipts')}
                </span>
                <button
                  onClick={() => receiptInputRef.current?.click()}
                  disabled={uploading}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <Upload size={10} /> {uploading ? '…' : t('budget.modal.uploadReceipt')}
                </button>
                <input ref={receiptInputRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={handleReceiptUpload} />
              </div>
              {receipts.length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>{t('budget.modal.noReceipts')}</div>
              ) : (
                <div style={{ padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {receipts.map((f: any) => (
                    <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border-faint)', background: 'var(--bg-tertiary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Paperclip size={9} />{f.original_name || f.filename}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              {t('common.cancel')}
            </button>
            <button onClick={handleSave} disabled={saving || !owedBalanced}
              style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: owedBalanced ? 'var(--accent)' : 'var(--bg-tertiary)', color: owedBalanced ? 'var(--accent-text)' : 'var(--text-faint)', cursor: owedBalanced ? 'pointer' : 'default', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
              {saving && <div style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid #fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />}
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
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
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
  const currency = trip?.currency || 'EUR'
  const canEdit = can('budget_edit', trip)

  const fmt = (v: number | null | undefined, cur?: string) => fmtNum(v, locale, cur || currency)
  const hasMultipleMembers = tripMembers.length > 1

  useEffect(() => {
    if (!hasMultipleMembers) return
    budgetApi.settlement(tripId).then(setSettlement).catch(() => {})
  }, [tripId, budgetItems, hasMultipleMembers])

  useEffect(() => { if (tripId) loadBudgetItems(tripId) }, [tripId])

  const grouped = useMemo(() => (budgetItems || []).reduce<Record<string, BudgetItem[]>>((acc, item) => {
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
      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>

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
                          <tr key={item.id} style={{ transition: 'background 0.1s' }}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}>
                            <td style={td}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                                <div style={{ flex: 1 }}>
                                  <InlineEditCell value={item.name} onSave={(v: string) => handleUpdateField(item.id, 'name', v)} placeholder={t('budget.table.name')} locale={locale} editTooltip={item.reservation_id ? t('budget.linkedToReservation') : t('budget.editTooltip')} readOnly={!canEdit || !!item.reservation_id} />
                                </div>
                                <button onClick={() => setExpandedRows(prev => new Set(prev.has(item.id) ? [...prev].filter(id => id !== item.id) : [...prev, item.id]))} className="sm:hidden" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                  {expandedRows.has(item.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
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
                          {expandedRows.has(item.id) && (
                            <tr className="sm:hidden" style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-secondary)' }}>
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
    </div>
  )
}
