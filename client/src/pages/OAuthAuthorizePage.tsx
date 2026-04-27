import React, { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plane, ShieldCheck, Loader2 } from 'lucide-react'
import { oauthApi, type ScopeDefinition, type ValidateAuthorizeResponse } from '../api/oauthApi'
import ScopeGroupPicker from '../components/Settings/ScopeGroupPicker'

type Phase =
  | 'loading'
  | 'login_required'
  | 'consent'
  | 'auto_approving'
  | 'error'

export default function OAuthAuthorizePage(): React.ReactElement {
  const [searchParams] = useSearchParams()
  const [phase, setPhase] = useState<Phase>('loading')
  const [validateResult, setValidateResult] = useState<ValidateAuthorizeResponse | null>(null)
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  // Extract OAuth params from URL
  const clientId       = searchParams.get('client_id') ?? ''
  const redirectUri    = searchParams.get('redirect_uri') ?? ''
  const responseType   = searchParams.get('response_type') ?? 'code'
  const scope          = searchParams.get('scope') ?? ''
  const state          = searchParams.get('state') ?? ''
  const codeChallenge  = searchParams.get('code_challenge') ?? ''
  const ccMethod       = searchParams.get('code_challenge_method') ?? 'S256'
  const resource       = searchParams.get('resource') ?? ''

  useEffect(() => {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: responseType })
    if (scope)         params.set('scope', scope)
    if (state)         params.set('state', state)
    if (codeChallenge) params.set('code_challenge', codeChallenge)
    if (ccMethod)      params.set('code_challenge_method', ccMethod)
    if (resource)      params.set('resource', resource)

    oauthApi.validateAuthorize(params)
      .then(result => {
        setValidateResult(result)
        if (!result.valid) {
          setErrorMessage(`Authorization error: ${result.error ?? 'invalid_request'}`)
          setPhase('error')
          return
        }
        if (result.loginRequired) {
          setPhase('login_required')
          return
        }
        const scopes = result.scopes?.map(s => s.scope) ?? []
        setSelectedScopes(scopes)
        if (!result.consentRequired) {
          // All scopes already consented — auto-approve
          setPhase('auto_approving')
          submitConsent(scopes, false)
        } else {
          setPhase('consent')
        }
      })
      .catch(() => {
        setErrorMessage('Failed to validate authorization request.')
        setPhase('error')
      })
  }, [])

  const submitConsent = async (approvedScopes: string[], isDenied: boolean) => {
    setSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state: state || undefined,
        code_challenge: codeChallenge || undefined,
        code_challenge_method: ccMethod,
        resource: resource || undefined,
        approved_scopes: isDenied ? undefined : approvedScopes,
        approved: isDenied ? false : undefined,
      }
      const { redirect } = await oauthApi.submitConsent(body)
      window.location.href = redirect
    } catch {
      setErrorMessage('Failed to complete authorization.')
      setPhase('error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleApprove = () => submitConsent(selectedScopes, false)
  const handleDeny    = () => submitConsent([], true)

  const handleLoginRedirect = () => {
    const returnUrl = window.location.pathname + window.location.search
    window.location.href = `/login?redirect=${encodeURIComponent(returnUrl)}`
  }

  const clientName = validateResult?.client?.name ?? 'Unknown app'
  const scopes: ScopeDefinition[] = validateResult?.scopes ?? []
  const scopeSelectable = validateResult?.scopeSelectable ?? false

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'var(--bg-secondary, #f8fafc)' }}>
      <div className="w-full max-w-xl rounded-2xl shadow-lg overflow-hidden" style={{ background: 'var(--bg-card, #fff)' }}>

        {/* Header */}
        <div className="px-8 pt-8 pb-6 flex items-center gap-3 border-b" style={{ borderColor: 'var(--border-primary, #e5e7eb)' }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--accent-primary, #4f46e5)' }}>
            <Plane className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary, #111827)' }}>TREK</h1>
            <p className="text-xs" style={{ color: 'var(--text-tertiary, #9ca3af)' }}>Authorization</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-8 py-6">

          {phase === 'loading' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--text-tertiary)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>Checking authorization…</p>
            </div>
          )}

          {phase === 'auto_approving' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--accent-primary, #4f46e5)' }} />
              <p style={{ color: 'var(--text-secondary)' }}>Completing authorization…</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="py-6 text-center space-y-3">
              <p className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Authorization Error</p>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{errorMessage}</p>
            </div>
          )}

          {phase === 'login_required' && (
            <div className="py-6 space-y-5">
              <div className="text-center space-y-2">
                <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Sign in to continue</p>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <strong>{clientName}</strong> is requesting access to your TREK data. Sign in to review and approve.
                </p>
              </div>
              <button
                onClick={handleLoginRedirect}
                className="w-full py-2.5 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ background: 'var(--accent-primary, #4f46e5)' }}
              >
                Sign in to TREK
              </button>
            </div>
          )}

          {phase === 'consent' && (
            <div className="space-y-5">
              {/* Trust notice */}
              <div>
                <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <strong>{clientName}</strong> is requesting access
                </p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: 'var(--accent-primary, #4f46e5)' }} />
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    You are granting access to your TREK data
                  </p>
                </div>
              </div>

              {/* Always-included notice */}
              <div className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                <strong>Always included:</strong> list_trips, get_trip_summary, list_places, list_categories, list_reservations, list_budget_items, get_budget_settlement, list_trip_members (read-only discovery tools, cannot be removed)
              </div>

              {/* Scope picker */}
              {scopes.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {scopeSelectable ? 'Select permissions to grant' : 'Requested permissions'}
                  </p>
                  <div className="max-h-72 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border-primary)' }}>
                    <ScopeGroupPicker
                      availableScopes={scopes}
                      selectedScopes={selectedScopes}
                      onChange={setSelectedScopes}
                      readOnly={!scopeSelectable}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {phase === 'consent' && (
          <div className="px-8 pb-8 flex gap-3 justify-end border-t pt-5" style={{ borderColor: 'var(--border-primary, #e5e7eb)' }}>
            <button
              onClick={handleDeny}
              disabled={submitting}
              className="px-5 py-2.5 rounded-xl text-sm border transition-colors disabled:opacity-50"
              style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
            >
              Deny
            </button>
            <button
              onClick={handleApprove}
              disabled={submitting || (scopeSelectable && selectedScopes.length === 0)}
              className="px-5 py-2.5 rounded-xl text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--accent-primary, #4f46e5)' }}
            >
              {submitting ? 'Approving…' : scopeSelectable ? 'Approve selected' : 'Approve'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
