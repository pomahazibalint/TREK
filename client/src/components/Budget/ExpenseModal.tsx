import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactDOM from 'react-dom'
import { useTripStore } from '../../store/tripStore'
import { X, Paperclip, Upload, ArrowRightCircle } from 'lucide-react'
import { budgetApi } from '../../api/client'
import { CustomDatePicker } from '../shared/CustomDateTimePicker'
import type { BudgetItem } from '../../types'
import { currencyDecimals } from '../../utils/formatters'

interface TripMember { id: number; username: string; avatar_url?: string | null }

const CURRENCIES = [
  'EUR','USD','GBP','JPY','CHF','CZK','PLN','SEK','NOK','DKK','TRY','THB',
  'AUD','CAD','NZD','BRL','MXN','INR','IDR','MYR','PHP','SGD','KRW','CNY',
  'HKD','TWD','ZAR','AED','SAR','ILS','EGP','MAD','HUF','RON','BGN','ISK',
  'UAH','BDT','LKR','VND','CLP','COP','PEN','ARS',
]
const SYMBOLS: Record<string, string> = {
  EUR:'€',USD:'$',GBP:'£',JPY:'¥',CHF:'CHF',CZK:'Kč',PLN:'zł',SEK:'kr',NOK:'kr',
  DKK:'kr',TRY:'₺',THB:'฿',AUD:'A$',CAD:'C$',NZD:'NZ$',BRL:'R$',MXN:'MX$',
  INR:'₹',IDR:'Rp',MYR:'RM',PHP:'₱',SGD:'S$',KRW:'₩',CNY:'¥',HKD:'HK$',
  TWD:'NT$',ZAR:'R',AED:'د.إ',SAR:'﷼',ILS:'₪',EGP:'E£',MAD:'MAD',HUF:'Ft',
  RON:'lei',BGN:'лв',ISK:'kr',UAH:'₴',BDT:'৳',LKR:'Rs',VND:'₫',CLP:'CL$',
  COP:'CO$',PEN:'S/.',ARS:'AR$',
}

function evalExpr(expr: string): number | null {
  const sanitized = expr.replace(/[^0-9.+\-*/() ]/g, '').trim()
  if (!sanitized) return null
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('return (' + sanitized + ')')()
    if (typeof result !== 'number' || !isFinite(result)) return null
    return Math.round(result * 100) / 100
  } catch {
    return null
  }
}

const EXPR_TIP_KEY = 'trek_expr_tip_shown'

const fmtNum = (v: number | null | undefined, locale: string, cur: string) => {
  if (v == null || isNaN(v)) return '-'
  const d = currencyDecimals(cur)
  return Number(v).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + (SYMBOLS[cur] || cur)
}

function ExprInput({ val, onChange }: { val: number; onChange: (v: number) => void }) {
  const [expr, setExpr] = useState(() => val === 0 ? '' : String(val))
  const [showTip, setShowTip] = useState(false)
  const focusedRef = useRef(false)

  useEffect(() => {
    if (!focusedRef.current) setExpr(val === 0 ? '' : String(val))
  }, [val])

  const result = useMemo(() => evalExpr(expr), [expr])
  const hasOp = /[+\-*/]/.test(expr)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    if (/[+\-*/]/.test(v) && !localStorage.getItem(EXPR_TIP_KEY)) {
      localStorage.setItem(EXPR_TIP_KEY, '1')
      setShowTip(true)
      setTimeout(() => setShowTip(false), 3500)
    }
    setExpr(v)
    const n = evalExpr(v)
    if (n !== null) onChange(n)
    else if (v === '') onChange(0)
  }

  const cellInp = { border: '1px solid var(--border-primary)', borderRadius: 6, outline: 'none', fontFamily: 'inherit', background: 'var(--bg-input)', color: 'var(--text-primary)', textAlign: 'right' as const, padding: '4px 6px', fontSize: 13, width: '100%', minWidth: 0 }

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 5 }}>
      <input
        type="text"
        inputMode="decimal"
        value={expr}
        placeholder="0 or 10+5"
        onChange={handleChange}
        onFocus={() => { focusedRef.current = true }}
        onBlur={() => { focusedRef.current = false }}
        style={cellInp}
      />
      {hasOp && result !== null && (
        <span style={{ fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          = {result}
        </span>
      )}
      {showTip && (
        <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 5, padding: '6px 10px', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 8, fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', zIndex: 20, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', lineHeight: 1.4 }}>
          Tip: expressions like <strong>1000+250+150</strong> are evaluated automatically
        </div>
      )}
    </div>
  )
}

export interface ExpenseModalProps {
  item: BudgetItem | null
  category: string
  tripId: number
  tripCurrency: string
  tripMembers: TripMember[]
  categories: string[]
  locale: string
  onSave: (itemId: number) => void
  onClose: () => void
  onConvert?: (itemId: number) => void
  isDraft?: boolean
  linkedContext?: string
  t: (k: string) => string
}

export default function ExpenseModal({
  item, category, tripId, tripCurrency, tripMembers, categories, locale,
  onSave, onClose, onConvert, isDraft = false, linkedContext, t,
}: ExpenseModalProps) {
  const { addBudgetItem, updateBudgetItem, setBudgetItemMemberOwed, setBudgetItemMemberPayments } = useTripStore()

  const [name, setName] = useState(item?.name || '')
  const [totalPrice, setTotalPrice] = useState(item?.total_price ?? 0)
  const [itemCurrency, setItemCurrency] = useState(item?.currency || tripCurrency)
  const isForeignCurrency = itemCurrency !== tripCurrency
  const [hintRate, setHintRate] = useState<number | null>(
    (item?.currency !== tripCurrency && item?.exchange_rate) ? item.exchange_rate : null
  )
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
  const [saving, setSaving] = useState(false)
  const [converting, setConverting] = useState(false)
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

  type MemberRow = { user_id: number; owed: number; paid: number }
  const initRows = useCallback((): MemberRow[] => {
    if (!item || !item.members?.length) return tripMembers.map(m => ({ user_id: m.id, owed: 0, paid: 0 }))
    const rowsByUser = new Map(item.members.map(m => [m.user_id, m]))
    return tripMembers.map(m => {
      const stored = rowsByUser.get(m.id)
      return { user_id: m.id, owed: stored?.amount_owed ?? 0, paid: stored?.amount_paid ?? 0 }
    })
  }, [item, tripMembers])

  const [rows, setRows] = useState<MemberRow[]>(initRows)

  const owedSum = rows.reduce((s, r) => s + r.owed, 0)
  const paidSum = rows.reduce((s, r) => r.paid > 0 ? s + r.paid : s, 0)
  const owedTotal = owedSum + tip
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
    setRows(prev => prev.map((r, i) => ({ ...r, owed: i === n - 1 ? Math.round((base - each * (n - 1)) * 100) / 100 : each })))
  }

  const equalSplitPaid = () => {
    const n = rows.length
    if (n === 0) return
    const each = Math.round(totalPrice / n * 100) / 100
    setRows(prev => prev.map((r, i) => ({ ...r, paid: i === n - 1 ? Math.round((totalPrice - each * (n - 1)) * 100) / 100 : each })))
  }

  useEffect(() => {
    if (!isForeignCurrency) { setHintRate(null); return }
    let cancelled = false
    fetch(`https://api.exchangerate-api.com/v4/latest/${itemCurrency}`)
      .then(r => r.json())
      .then((data: any) => { if (!cancelled) { const rate = data.rates?.[tripCurrency]; if (rate) setHintRate(rate) } })
      .catch(() => {})
    return () => { cancelled = true }
  }, [itemCurrency, isForeignCurrency, tripCurrency])

  const buildSavePayload = () => {
    const tipVal = tip || 0
    const itemData = { name: name.trim(), total_price: totalPrice, currency: itemCurrency, note: note.trim() || null, expense_date: expenseDate || null, category: selectedCategory }
    const owedMembers = rows.filter(r => r.owed > 0).map(r => ({ user_id: r.user_id, amount_owed: r.owed || 0 }))
    const payments = rows.map(r => ({ user_id: r.user_id, amount_paid: r.paid || 0 }))
    return { itemData, owedMembers, payments, tip: tipVal }
  }

  const persist = async () => {
    const { itemData, owedMembers, payments, tip } = buildSavePayload()
    let savedId: number
    if (item) { const updated = await updateBudgetItem(tripId, item.id, itemData); savedId = updated.id }
    else { const created = await addBudgetItem(tripId, itemData); savedId = created.id }
    if (owedMembers.length > 0 && owedBalanced) await setBudgetItemMemberOwed(tripId, savedId, owedMembers, tip)
    if (paidSum > 0.01 && paidBalanced) await setBudgetItemMemberPayments(tripId, savedId, payments)
    return savedId
  }

  const handleSave = async () => {
    if (!name.trim()) { setError(t('budget.table.name') + ' is required'); return }
    if (!isDraft && !owedBalanced) { setError('Owed amounts + tip must equal the total'); return }
    if (!paidBalanced) { setError('Paid amounts must equal the total or all be zero'); return }
    setSaving(true); setError('')
    try { const savedId = await persist(); onSave(savedId) }
    catch (err: any) { setError(err.message || 'Error saving expense') }
    setSaving(false)
  }

  const handleConvert = async () => {
    if (!name.trim()) { setError(t('budget.table.name') + ' is required'); return }
    if (!expenseDate) { setError('Date is required to convert to an expense'); return }
    if (!item?.id) return
    setConverting(true); setError('')
    try {
      await persist()
      await budgetApi.convertDraft(tripId, item.id)
      useTripStore.setState(state => {
        const newAssignments: typeof state.assignments = {}
        for (const [dayKey, list] of Object.entries(state.assignments)) {
          newAssignments[dayKey] = list.map(a =>
            (a as any).draft_budget_entry_id === item!.id ? { ...a, budget_entry_is_draft: 0 } : a
          )
        }
        return { assignments: newAssignments }
      })
      onConvert?.(item.id)
      onClose()
    } catch (err: any) { setError(err.message || 'Error converting expense') }
    setConverting(false)
  }

  const inp = { border: '1px solid var(--border-primary)', borderRadius: 6, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--bg-input)', color: 'var(--text-primary)', width: '100%' }
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
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
              {isDraft && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 5, background: 'rgba(245,158,11,0.12)', color: '#d97706', border: '1px solid rgba(245,158,11,0.25)' }}>Draft</span>}
              {item ? t('budget.editExpense') : t('budget.addExpense')}
            </h2>
            {linkedContext && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>{linkedContext}</div>}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#dc2626' }}>{error}</div>}
          {isDraft && <div style={{ padding: '8px 12px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, fontSize: 12, color: '#92400e' }}>This is a draft expense — it won't appear in totals or settlement until converted.</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10 }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder={t('budget.table.name')} style={inp} />
            <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)} style={{ ...inp, width: 'auto', paddingRight: 28, cursor: 'pointer' }}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <CustomDatePicker value={expenseDate} onChange={setExpenseDate} placeholder={isDraft ? 'Date (required to convert)' : '—'} compact />
          </div>

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
              <select value={itemCurrency} onChange={e => setItemCurrency(e.target.value)} style={{ ...inp, width: 'auto', paddingRight: 28, cursor: 'pointer' }}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>


          <input value={note} onChange={e => setNote(e.target.value)} placeholder={t('budget.table.note')} style={inp} />

          {tripMembers.length > 0 && (
            <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#000' }}>
                    <th style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.05em', width: isDraft ? '55%' : '40%' }}></th>
                    <th style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.05em', width: isDraft ? '45%' : '30%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                        {isDraft ? t('budget.modal.paid') : t('budget.modal.owes')} ({itemCurrency})
                        <button onClick={isDraft ? equalSplitPaid : equalSplitOwed} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>= {t('budget.modal.equalSplit')}</button>
                      </div>
                    </th>
                    {!isDraft && (
                      <th style={{ padding: '9px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.05em', width: '30%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                          {t('budget.modal.paid')} ({itemCurrency})
                          <button onClick={equalSplitPaid} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>= {t('budget.modal.equalSplit')}</button>
                        </div>
                      </th>
                    )}
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
                              {member.avatar_url ? <img src={member.avatar_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" /> : member.username[0]?.toUpperCase()}
                            </div>
                            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{member.username}</span>
                          </div>
                        </td>
                        <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                          {isDraft
                            ? <ExprInput val={row.paid} onChange={v => setRows(prev => prev.map((r, j) => j === i ? { ...r, paid: v } : r))} />
                            : <ExprInput val={row.owed} onChange={v => setRows(prev => prev.map((r, j) => j === i ? { ...r, owed: v } : r))} />
                          }
                          {isForeignCurrency && (isDraft ? row.paid : row.owed) > 0 && hintRate && <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>≈ {fmtNum((isDraft ? row.paid : row.owed) * hintRate, locale, tripCurrency)}</div>}
                        </td>
                        {!isDraft && (
                          <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                            <ExprInput val={row.paid} onChange={v => setRows(prev => prev.map((r, j) => j === i ? { ...r, paid: v } : r))} />
                            {isForeignCurrency && row.paid > 0 && hintRate && <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>≈ {fmtNum(row.paid * hintRate, locale, tripCurrency)}</div>}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                  {!isDraft && (
                    <tr style={{ borderTop: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' }}>
                      <td style={{ padding: '7px 12px', fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic' }}>{t('budget.modal.tip')}</td>
                      <td style={{ padding: '5px 12px', textAlign: 'right' }}>
                        <ExprInput val={tip} onChange={setTip} />
                        {isForeignCurrency && tip > 0 && hintRate && <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>≈ {fmtNum(tip * hintRate, locale, tripCurrency)}</div>}
                      </td>
                      <td style={{ padding: '5px 12px' }} />
                    </tr>
                  )}
                  <tr style={{ borderTop: '2px solid var(--border-primary)', background: '#000', color: '#fff' }}>
                    <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span>{fmtNum(totalPrice, locale, itemCurrency)}</span>
                        {isForeignCurrency && hintRate && <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}>{fmtNum(Math.round(totalPrice * hintRate * 100) / 100, locale, tripCurrency)}</span>}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{isDraft ? (paidSum > 0.01 ? fmtNum(paidSum, locale, itemCurrency) : '—') : fmtNum(owedTotal, locale, itemCurrency)}</span>
                        <DeltaBadge delta={isDraft ? paidDelta : owedDelta} allZero={isDraft && paidSum < 0.01} cur={itemCurrency} />
                      </div>
                    </td>
                    {!isDraft && (
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{paidSum > 0.01 ? fmtNum(paidSum, locale, itemCurrency) : '—'}</span>
                          <DeltaBadge delta={paidDelta} allZero={paidSum < 0.01} cur={itemCurrency} />
                        </div>
                      </td>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {!isDraft && item?.id && (
            <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}><Paperclip size={11} /> {t('budget.modal.receipts')}</span>
                <button onClick={() => receiptInputRef.current?.click()} disabled={uploading} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <Upload size={10} /> {uploading ? '…' : t('budget.modal.uploadReceipt')}
                </button>
                <input ref={receiptInputRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={handleReceiptUpload} />
              </div>
              {receipts.length === 0
                ? <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>{t('budget.modal.noReceipts')}</div>
                : <div style={{ padding: '6px 12px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {receipts.map((f: any) => (
                      <a key={f.id} href={f.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border-faint)', background: 'var(--bg-tertiary)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Paperclip size={9} />{f.original_name || f.filename}
                      </a>
                    ))}
                  </div>
              }
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 4 }}>
            <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>{t('common.cancel')}</button>
            {isDraft && item?.id && (
              <button onClick={handleConvert} disabled={converting || saving} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: expenseDate ? '#d97706' : 'var(--bg-tertiary)', color: expenseDate ? '#fff' : 'var(--text-faint)', cursor: expenseDate ? 'pointer' : 'default', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
                {converting && <div style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid #fff', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />}
                <ArrowRightCircle size={14} /> Convert to expense
              </button>
            )}
            <button onClick={handleSave} disabled={saving || converting || (!isDraft && !owedBalanced)}
              style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: (isDraft || owedBalanced) ? 'var(--accent)' : 'var(--bg-tertiary)', color: (isDraft || owedBalanced) ? 'var(--accent-text)' : 'var(--text-faint)', cursor: (isDraft || owedBalanced) ? 'pointer' : 'default', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
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
