import React, { useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { X, CheckCircle, AlertTriangle, FileEdit, ArrowRight, Loader } from 'lucide-react'
import { budgetApi } from '../../api/client'
import { useTripStore } from '../../store/tripStore'
import { useTranslation } from '../../i18n'
import { currencyDecimals } from '../../utils/formatters'
import type { BudgetItem } from '../../types'

interface SettlementFlow {
  from: { user_id: number; username: string; avatar_url: string | null }
  to: { user_id: number; username: string; avatar_url: string | null }
  amount: number
}

interface SettlementData {
  settlement_currency: string
  balances: any[]
  flows: SettlementFlow[]
  incomplete: { id: number; name: string; reason: string }[]
}

interface SettlementModalProps {
  tripId: number
  onClose: () => void
}

function MiniAvatar({ username, avatarUrl }: { username: string; avatarUrl: string | null }) {
  return (
    <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-tertiary)', border: '2px solid var(--border-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', overflow: 'hidden', flexShrink: 0 }}>
      {avatarUrl ? <img src={avatarUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : username?.[0]?.toUpperCase()}
    </div>
  )
}

function fmtAmount(amount: number, currency: string, locale: string) {
  const d = currencyDecimals(currency)
  return amount.toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + currency
}

export default function SettlementModal({ tripId, onClose }: SettlementModalProps) {
  const { settleBudget } = useTripStore()
  const { t, locale } = useTranslation()
  const [settlement, setSettlement] = useState<SettlementData | null>(null)
  const [drafts, setDrafts] = useState<BudgetItem[]>([])
  const [loading, setLoading] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [settling, setSettling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftAction, setDraftAction] = useState<Record<number, 'converting' | 'discarding'>>({})

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [s, d] = await Promise.all([
        budgetApi.settlement(tripId),
        budgetApi.listDrafts(tripId),
      ])
      setSettlement(s)
      setDrafts(d.items || [])
    } catch {
      setError(t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [tripId])

  useEffect(() => { reload() }, [reload])

  const handleConvert = async (draft: BudgetItem) => {
    setDraftAction(prev => ({ ...prev, [draft.id]: 'converting' }))
    try {
      await budgetApi.convertDraft(tripId, draft.id)
      await reload()
    } catch {
      setError(t('common.error'))
    } finally {
      setDraftAction(prev => { const n = { ...prev }; delete n[draft.id]; return n })
    }
  }

  const handleDiscard = async (draft: BudgetItem) => {
    setDraftAction(prev => ({ ...prev, [draft.id]: 'discarding' }))
    try {
      await budgetApi.discardDraft(tripId, draft.id)
      await reload()
    } catch {
      setError(t('common.error'))
    } finally {
      setDraftAction(prev => { const n = { ...prev }; delete n[draft.id]; return n })
    }
  }

  const handleSettle = async () => {
    setSettling(true)
    setError(null)
    try {
      await settleBudget(tripId)
      onClose()
    } catch (err: any) {
      const msg = err?.response?.data?.error
      if (msg === 'has_drafts') {
        setError(t('budget.settlement.hasDrafts'))
        await reload()
      } else if (msg === 'already_settled') {
        setError(t('budget.settlement.alreadySettled'))
      } else {
        setError(t('common.error'))
      }
      setConfirming(false)
    } finally {
      setSettling(false)
    }
  }

  const canSettle = !loading && drafts.length === 0

  const content = (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 480, background: 'var(--bg-card)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.2)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>

        {/* Header */}
        <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-primary)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>{t('budget.settlement.previewTitle')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3 }}>{t('budget.settlement.previewSubtitle')}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-faint)', borderRadius: 6, display: 'flex', flexShrink: 0 }}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, color: 'var(--text-faint)', gap: 10 }}>
              <Loader size={18} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13 }}>{t('common.loading')}</span>
            </div>
          ) : (
            <>
              {/* Payments required */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>{t('budget.settlement.flows')}</div>
                {settlement && settlement.flows.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {settlement.flows.map((flow, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)' }}>
                        <MiniAvatar username={flow.from.username} avatarUrl={flow.from.avatar_url} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flow.from.username}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <ArrowRight size={14} color="var(--text-faint)" />
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#f87171' }}>{fmtAmount(flow.amount, settlement.settlement_currency, locale)}</span>
                          <ArrowRight size={14} color="var(--text-faint)" />
                        </div>
                        <MiniAvatar username={flow.to.username} avatarUrl={flow.to.avatar_url} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{flow.to.username}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.2)' }}>
                    <CheckCircle size={16} color="#4ade80" />
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{t('budget.settlement.noFlows')}</span>
                  </div>
                )}
              </div>

              {/* Unresolved drafts */}
              {drafts.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <AlertTriangle size={13} color="#f59e0b" />
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#d97706', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('budget.settlement.unresolvedDrafts')}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>{t('budget.settlement.unresolvedDraftsHint')}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {drafts.map(draft => {
                      const busy = draftAction[draft.id]
                      return (
                        <div key={draft.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
                          <FileEdit size={13} color="#d97706" style={{ flexShrink: 0 }} />
                          <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{draft.name}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', marginRight: 6 }}>
                            {draft.total_price > 0 ? `${draft.total_price.toFixed(currencyDecimals(draft.currency))} ${draft.currency}` : ''}
                          </span>
                          <button
                            onClick={() => handleConvert(draft)}
                            disabled={!!busy}
                            style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                            {busy === 'converting' ? '…' : t('budget.settlement.convertDraft')}
                          </button>
                          <button
                            onClick={() => handleDiscard(draft)}
                            disabled={!!busy}
                            style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)', color: '#ef4444', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                            {busy === 'discarding' ? '…' : t('budget.settlement.discardDraft')}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div style={{ padding: '10px 14px', borderRadius: 10, background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)', fontSize: 13, color: '#ef4444', marginBottom: 12 }}>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-primary)', flexShrink: 0 }}>
          {confirming ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>{t('budget.settlement.confirmText')}</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setConfirming(false)} disabled={settling}
                  style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'none', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: settling ? 0.5 : 1 }}>
                  {t('common.cancel')}
                </button>
                <button onClick={handleSettle} disabled={settling}
                  style={{ flex: 2, padding: '10px 0', borderRadius: 10, border: 'none', background: '#111827', color: '#fff', fontSize: 13, fontWeight: 700, cursor: settling ? 'default' : 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  {settling ? <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> {t('common.saving')}</> : t('budget.settlement.confirmBtn')}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => { if (canSettle) setConfirming(true) }}
              disabled={!canSettle}
              style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', background: canSettle ? '#111827' : 'var(--bg-tertiary)', color: canSettle ? '#fff' : 'var(--text-faint)', fontSize: 14, fontWeight: 700, cursor: canSettle ? 'pointer' : 'default', fontFamily: 'inherit', transition: 'background 0.15s' }}>
              {t('budget.settlement.settleBtn')}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return ReactDOM.createPortal(content, document.body)
}
