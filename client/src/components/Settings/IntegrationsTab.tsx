import Section from './Section'
import React, { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useToast } from '../shared/Toast'
import { Trash2, Copy, Terminal, Plus, Check, RefreshCw, RotateCcw } from 'lucide-react'
import { authApi } from '../../api/client'
import { oauthApi, type OAuthClient, type OAuthSessionInfo, CLIENT_SCOPE_DEFINITIONS, SCOPE_PRESETS } from '../../api/oauthApi'
import { useAddonStore } from '../../store/addonStore'
import PhotoProvidersSection from './PhotoProvidersSection'
import ScopeGroupPicker from './ScopeGroupPicker'

// ── Legacy token types ────────────────────────────────────────────────────────

interface McpToken {
  id: number
  name: string
  token_prefix: string
  created_at: string
  last_used_at: string | null
}

// ── Main component ────────────────────────────────────────────────────────────

export default function IntegrationsTab(): React.ReactElement {
  const { t, locale } = useTranslation()
  const toast = useToast()
  const { isEnabled: addonEnabled, loadAddons } = useAddonStore()
  const mcpEnabled = addonEnabled('mcp')

  useEffect(() => { loadAddons() }, [loadAddons])

  const [mcpSubTab, setMcpSubTab] = useState<'apps' | 'legacy' | 'sessions'>('apps')

  // ── Legacy token state ────────────────────────────────────────────────────

  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([])
  const [mcpModalOpen, setMcpModalOpen] = useState(false)
  const [mcpNewName, setMcpNewName] = useState('')
  const [mcpCreatedToken, setMcpCreatedToken] = useState<string | null>(null)
  const [mcpCreating, setMcpCreating] = useState(false)
  const [mcpDeleteId, setMcpDeleteId] = useState<number | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const mcpEndpoint = `${window.location.origin}/mcp`

  useEffect(() => {
    if (mcpEnabled) {
      authApi.mcpTokens.list().then(d => setMcpTokens(d.tokens || [])).catch(() => {})
    }
  }, [mcpEnabled])

  const handleCreateMcpToken = async () => {
    if (!mcpNewName.trim()) return
    setMcpCreating(true)
    try {
      const d = await authApi.mcpTokens.create(mcpNewName.trim())
      setMcpCreatedToken(d.token.raw_token)
      setMcpNewName('')
      setMcpTokens(prev => [{ id: d.token.id, name: d.token.name, token_prefix: d.token.token_prefix, created_at: d.token.created_at, last_used_at: null }, ...prev])
    } catch {
      toast.error(t('settings.mcp.toast.createError'))
    } finally {
      setMcpCreating(false)
    }
  }

  const handleDeleteMcpToken = async (id: number) => {
    try {
      await authApi.mcpTokens.delete(id)
      setMcpTokens(prev => prev.filter(tk => tk.id !== id))
      setMcpDeleteId(null)
      toast.success(t('settings.mcp.toast.deleted'))
    } catch {
      toast.error(t('settings.mcp.toast.deleteError'))
    }
  }

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    })
  }

  // ── OAuth apps state ──────────────────────────────────────────────────────

  const [oauthClients, setOauthClients] = useState<OAuthClient[]>([])
  const [oauthLoading, setOauthLoading] = useState(false)
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [newAppName, setNewAppName] = useState('')
  const [newAppRedirects, setNewAppRedirects] = useState('')
  const [newAppScopes, setNewAppScopes] = useState<string[]>(SCOPE_PRESETS.claude_ai)
  const [newAppPublic, setNewAppPublic] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createdClient, setCreatedClient] = useState<{ client_id: string; clientSecret: string | null } | null>(null)
  const [deleteClientId, setDeleteClientId] = useState<string | null>(null)
  const [rotatedSecrets, setRotatedSecrets] = useState<Record<string, string>>({})
  const [expandedScopes, setExpandedScopes] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (mcpEnabled && mcpSubTab === 'apps') {
      setOauthLoading(true)
      oauthApi.listClients().then(d => setOauthClients(d.clients)).catch(() => {}).finally(() => setOauthLoading(false))
    }
  }, [mcpEnabled, mcpSubTab])

  const handleCreateApp = async () => {
    if (!newAppName.trim()) return
    const redirectUris = newAppRedirects.split('\n').map(s => s.trim()).filter(Boolean)
    if (!redirectUris.length) { toast.error('At least one redirect URI required'); return }
    setCreating(true)
    try {
      const { client, clientSecret } = await oauthApi.createClient({
        name: newAppName.trim(),
        redirect_uris: redirectUris,
        allowed_scopes: newAppScopes,
        is_public: newAppPublic,
      })
      setOauthClients(prev => [client, ...prev])
      setCreatedClient({ client_id: client.client_id, clientSecret })
      setNewAppName('')
      setNewAppRedirects('')
      setNewAppScopes(SCOPE_PRESETS.claude_ai)
      setNewAppPublic(true)
      toast.success(t('settings.mcp.apps.created'))
    } catch {
      toast.error(t('settings.mcp.apps.createError'))
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteApp = async (clientId: string) => {
    try {
      await oauthApi.deleteClient(clientId)
      setOauthClients(prev => prev.filter(c => c.client_id !== clientId))
      setDeleteClientId(null)
      toast.success(t('settings.mcp.apps.deleted'))
    } catch {
      toast.error(t('settings.mcp.apps.deleteError'))
    }
  }

  const handleRotateSecret = async (clientId: string) => {
    try {
      const { clientSecret } = await oauthApi.rotateClientSecret(clientId)
      setRotatedSecrets(prev => ({ ...prev, [clientId]: clientSecret }))
      toast.success(t('settings.mcp.apps.rotated'))
    } catch {
      toast.error(t('settings.mcp.apps.rotateError'))
    }
  }

  // ── Sessions state ────────────────────────────────────────────────────────

  const [sessions, setSessions] = useState<OAuthSessionInfo[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  useEffect(() => {
    if (mcpEnabled && mcpSubTab === 'sessions') {
      setSessionsLoading(true)
      oauthApi.listSessions().then(d => setSessions(d.sessions)).catch(() => {}).finally(() => setSessionsLoading(false))
    }
  }, [mcpEnabled, mcpSubTab])

  const handleRevokeSession = async (tokenId: number) => {
    try {
      await oauthApi.revokeSession(tokenId)
      setSessions(prev => prev.filter(s => s.id !== tokenId))
      toast.success(t('settings.mcp.sessions.revoked'))
    } catch {
      toast.error(t('settings.mcp.sessions.revokeError'))
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <PhotoProvidersSection />

      {mcpEnabled && (
        <Section title={t('settings.mcp.title')} icon={Terminal}>
          {/* Endpoint */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.endpoint')}</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono border" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                {mcpEndpoint}
              </code>
              <button onClick={() => handleCopy(mcpEndpoint, 'endpoint')}
                className="p-2 rounded-lg border transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                style={{ borderColor: 'var(--border-primary)' }} title={t('settings.mcp.copy')}>
                {copiedKey === 'endpoint' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />}
              </button>
            </div>
          </div>

          {/* Sub-tabs */}
          <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-secondary)' }}>
            {(['apps', 'legacy', 'sessions'] as const).map(tab => (
              <button key={tab} onClick={() => setMcpSubTab(tab)}
                className="flex-1 py-1.5 text-sm rounded-md transition-colors font-medium"
                style={{
                  background: mcpSubTab === tab ? 'var(--bg-card)' : 'transparent',
                  color: mcpSubTab === tab ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  boxShadow: mcpSubTab === tab ? '0 1px 3px rgba(0,0,0,0.08)' : undefined,
                }}>
                {tab === 'apps' ? t('settings.mcp.tabs.apps')
                  : tab === 'legacy' ? t('settings.mcp.tabs.legacyTokens')
                  : t('settings.mcp.tabs.sessions')}
              </button>
            ))}
          </div>

          {/* ── Tab: OAuth 2.1 Apps ── */}
          {mcpSubTab === 'apps' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  {t('settings.mcp.tabs.apps')}
                </label>
                <button onClick={() => { setCreateModalOpen(true); setCreatedClient(null) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors text-white"
                  style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                  <Plus className="w-3.5 h-3.5" /> {t('settings.mcp.apps.create')}
                </button>
              </div>

              {oauthLoading ? (
                <p className="text-sm py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
              ) : oauthClients.length === 0 ? (
                <p className="text-sm py-3 text-center rounded-lg border" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                  {t('settings.mcp.apps.empty')}
                </p>
              ) : (
                <div className="rounded-lg border overflow-hidden divide-y" style={{ borderColor: 'var(--border-primary)' }}>
                  {oauthClients.map(client => {
                    const expanded = expandedScopes[client.client_id]
                    const visibleScopes = expanded ? client.allowed_scopes : client.allowed_scopes.slice(0, 3)
                    const rotatedSecret = rotatedSecrets[client.client_id]
                    return (
                      <div key={client.client_id} className="px-4 py-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{client.name}</p>
                              <span className="text-xs px-1.5 py-0.5 rounded font-mono"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                                {client.is_public ? t('settings.mcp.apps.publicBadge') : t('settings.mcp.apps.confidentialBadge')}
                              </span>
                            </div>
                            <p className="text-xs font-mono mt-0.5 truncate" style={{ color: 'var(--text-tertiary)' }}>
                              {client.client_id}
                              <span className="ml-2 font-sans">{new Date(client.created_at).toLocaleDateString(locale)}</span>
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {!client.is_public && (
                              <button onClick={() => handleRotateSecret(client.client_id)}
                                className="p-1.5 rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                                style={{ color: 'var(--text-tertiary)' }} title={t('settings.mcp.apps.rotate')}>
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => setDeleteClientId(client.client_id)}
                              className="p-1.5 rounded-lg transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                              style={{ color: 'var(--text-tertiary)' }} title={t('settings.mcp.apps.delete')}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Scopes */}
                        <div className="flex flex-wrap gap-1">
                          {visibleScopes.map(s => (
                            <span key={s} className="text-xs px-1.5 py-0.5 rounded font-mono"
                              style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>{s}</span>
                          ))}
                          {client.allowed_scopes.length > 3 && (
                            <button onClick={() => setExpandedScopes(prev => ({ ...prev, [client.client_id]: !expanded }))}
                              className="text-xs px-1.5 py-0.5 rounded"
                              style={{ color: 'var(--accent-primary, #4f46e5)', background: 'transparent' }}>
                              {expanded ? 'less' : `+${client.allowed_scopes.length - 3} more`}
                            </button>
                          )}
                        </div>

                        {/* Rotated secret reveal */}
                        {rotatedSecret && (
                          <div className="flex items-center gap-2 p-2 rounded-lg" style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)' }}>
                            <p className="text-xs flex-1 font-mono break-all" style={{ color: 'var(--text-secondary)' }}>{rotatedSecret}</p>
                            <button onClick={() => handleCopy(rotatedSecret, `secret-${client.client_id}`)}
                              className="shrink-0" style={{ color: 'var(--text-tertiary)' }}>
                              {copiedKey === `secret-${client.client_id}` ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Legacy Tokens ── */}
          {mcpSubTab === 'legacy' && (
            <div className="space-y-3">
              {/* Deprecation notice */}
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg"
                style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)' }}>
                <span className="text-amber-500 text-xs mt-0.5">⚠</span>
                <div>
                  <span className="text-xs font-semibold mr-2"
                    style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.legacyDeprecated')}</span>
                  <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('settings.mcp.apps.legacyNotice')}</span>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apiTokens')}</label>
                <button onClick={() => { setMcpModalOpen(true); setMcpCreatedToken(null); setMcpNewName('') }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors text-white"
                  style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                  <Plus className="w-3.5 h-3.5" /> {t('settings.mcp.createToken')}
                </button>
              </div>

              {mcpTokens.length === 0 ? (
                <p className="text-sm py-3 text-center rounded-lg border" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                  {t('settings.mcp.noTokens')}
                </p>
              ) : (
                <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-primary)' }}>
                  {mcpTokens.map((token, i) => (
                    <div key={token.id} className="flex items-center gap-3 px-4 py-3"
                      style={{ borderBottom: i < mcpTokens.length - 1 ? '1px solid var(--border-primary)' : undefined }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{token.name}</p>
                        <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {token.token_prefix}...
                          <span className="ml-3 font-sans">{t('settings.mcp.tokenCreatedAt')} {new Date(token.created_at).toLocaleDateString(locale)}</span>
                          {token.last_used_at && <span className="ml-2">· {t('settings.mcp.tokenUsedAt')} {new Date(token.last_used_at).toLocaleDateString(locale)}</span>}
                        </p>
                      </div>
                      <button onClick={() => setMcpDeleteId(token.id)}
                        className="p-1.5 rounded-lg transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                        style={{ color: 'var(--text-tertiary)' }} title={t('settings.mcp.deleteTokenTitle')}>
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Tab: Active Sessions ── */}
          {mcpSubTab === 'sessions' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.tabs.sessions')}</label>
                <button onClick={() => {
                  setSessionsLoading(true)
                  oauthApi.listSessions().then(d => setSessions(d.sessions)).catch(() => {}).finally(() => setSessionsLoading(false))
                }} className="p-1.5 rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                  style={{ color: 'var(--text-tertiary)' }} title="Refresh">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>

              {sessionsLoading ? (
                <p className="text-sm py-4 text-center" style={{ color: 'var(--text-tertiary)' }}>Loading…</p>
              ) : sessions.length === 0 ? (
                <p className="text-sm py-3 text-center rounded-lg border" style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-primary)' }}>
                  {t('settings.mcp.sessions.empty')}
                </p>
              ) : (
                <div className="rounded-lg border overflow-hidden divide-y" style={{ borderColor: 'var(--border-primary)' }}>
                  {sessions.map(s => (
                    <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{s.client_name}</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                          {t('settings.mcp.sessions.expires')}: {new Date(s.refresh_token_expires_at).toLocaleDateString(locale)}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {s.scopes.slice(0, 4).map(sc => (
                            <span key={sc} className="text-xs px-1.5 py-0.5 rounded font-mono"
                              style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>{sc}</span>
                          ))}
                          {s.scopes.length > 4 && (
                            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>+{s.scopes.length - 4} more</span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => handleRevokeSession(s.id)}
                        className="px-2.5 py-1 rounded text-xs border transition-colors hover:bg-red-50 hover:border-red-300 hover:text-red-600 dark:hover:bg-red-900/20"
                        style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                        {t('settings.mcp.sessions.revoke')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {/* ── Create OAuth App modal ── */}
      {createModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget && !createdClient) setCreateModalOpen(false) }}>
          <div className="rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" style={{ background: 'var(--bg-card)' }}>
            {!createdClient ? (
              <>
                <div className="px-6 pt-6 pb-4 border-b" style={{ borderColor: 'var(--border-primary)' }}>
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.apps.modal.createTitle')}</h3>
                </div>

                <div className="overflow-y-auto px-6 py-4 space-y-4 flex-1">
                  {/* Name */}
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.name')}</label>
                    <input type="text" value={newAppName} onChange={e => setNewAppName(e.target.value)}
                      placeholder={t('settings.mcp.apps.namePlaceholder')}
                      className="w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                      autoFocus />
                  </div>

                  {/* Redirect URIs */}
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.redirectUris')}</label>
                    <textarea value={newAppRedirects} onChange={e => setNewAppRedirects(e.target.value)}
                      rows={3} placeholder="https://example.com/callback"
                      className="w-full px-3 py-2.5 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('settings.mcp.apps.redirectUrisHint')}</p>
                  </div>

                  {/* Public client toggle */}
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="app-public" checked={newAppPublic} onChange={e => setNewAppPublic(e.target.checked)}
                      className="w-4 h-4 accent-indigo-600" />
                    <label htmlFor="app-public" className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.isPublic')}</label>
                  </div>

                  {/* Scope presets */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.preset')}</label>
                      {([['claude_ai', t('settings.mcp.apps.preset.claude')], ['claude_desktop', t('settings.mcp.apps.preset.claudeDesktop')], ['chatgpt', t('settings.mcp.apps.preset.chatgpt')], ['read_only', t('settings.mcp.apps.preset.readOnly')]] as [string, string][]).map(([key, label]) => (
                        <button key={key} type="button" onClick={() => setNewAppScopes(SCOPE_PRESETS[key])}
                          className="px-2 py-0.5 rounded text-xs border transition-colors"
                          style={{ borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)' }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.scopes')}</p>
                    <ScopeGroupPicker
                      availableScopes={CLIENT_SCOPE_DEFINITIONS}
                      selectedScopes={newAppScopes}
                      onChange={setNewAppScopes}
                    />
                  </div>
                </div>

                <div className="px-6 py-4 border-t flex gap-2 justify-end" style={{ borderColor: 'var(--border-primary)' }}>
                  <button onClick={() => setCreateModalOpen(false)}
                    className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={handleCreateApp} disabled={!newAppName.trim() || creating || newAppScopes.length === 0}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                    {creating ? t('settings.mcp.apps.modal.creating') : t('settings.mcp.apps.create')}
                  </button>
                </div>
              </>
            ) : (
              <div className="p-6 space-y-4">
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.apps.modal.createTitle')}</h3>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Client ID</label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 rounded-lg text-xs font-mono border break-all"
                      style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                      {createdClient.client_id}
                    </code>
                    <button onClick={() => handleCopy(createdClient.client_id, 'new-client-id')}
                      style={{ color: 'var(--text-tertiary)' }}>
                      {copiedKey === 'new-client-id' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                {createdClient.clientSecret && (
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.secretOnce')}</label>
                    <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200" style={{ background: 'rgba(251,191,36,0.1)' }}>
                      <span className="text-amber-500 mt-0.5 shrink-0">⚠</span>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.secretWarning')}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <code className="flex-1 px-3 py-2 rounded-lg text-xs font-mono border break-all"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                        {createdClient.clientSecret}
                      </code>
                      <button onClick={() => handleCopy(createdClient.clientSecret!, 'new-secret')}
                        style={{ color: 'var(--text-tertiary)' }}>
                        {copiedKey === 'new-secret' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex justify-end">
                  <button onClick={() => { setCreateModalOpen(false); setCreatedClient(null) }}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                    style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                    {t('settings.mcp.apps.modal.done')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Delete OAuth App confirm ── */}
      {deleteClientId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteClientId(null) }}>
          <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.apps.modal.deleteTitle')}</h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.modal.deleteMessage')}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteClientId(null)}
                className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={() => handleDeleteApp(deleteClientId)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700">
                {t('settings.mcp.apps.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Legacy Token modal ── */}
      {mcpModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget && !mcpCreatedToken) setMcpModalOpen(false) }}>
          <div className="rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
            {!mcpCreatedToken ? (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.modal.createTitle')}</h3>
                <div>
                  <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.modal.tokenName')}</label>
                  <input type="text" value={mcpNewName} onChange={e => setMcpNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreateMcpToken()}
                    placeholder={t('settings.mcp.modal.tokenNamePlaceholder')}
                    className="w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                    autoFocus />
                </div>
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={() => setMcpModalOpen(false)}
                    className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={handleCreateMcpToken} disabled={!mcpNewName.trim() || mcpCreating}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                    {mcpCreating ? t('settings.mcp.modal.creating') : t('settings.mcp.modal.create')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.modal.createdTitle')}</h3>
                <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200" style={{ background: 'rgba(251,191,36,0.1)' }}>
                  <span className="text-amber-500 mt-0.5">⚠</span>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.modal.createdWarning')}</p>
                </div>
                <div className="relative">
                  <pre className="p-3 pr-10 rounded-lg text-xs font-mono break-all border whitespace-pre-wrap" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                    {mcpCreatedToken}
                  </pre>
                  <button onClick={() => handleCopy(mcpCreatedToken, 'new-token')}
                    className="absolute top-2 right-2 p-1.5 rounded transition-colors hover:bg-slate-200 dark:hover:bg-slate-600"
                    style={{ color: 'var(--text-secondary)' }} title={t('settings.mcp.copy')}>
                    {copiedKey === 'new-token' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex justify-end">
                  <button onClick={() => { setMcpModalOpen(false); setMcpCreatedToken(null) }}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white"
                    style={{ background: 'var(--accent-primary, #4f46e5)' }}>
                    {t('settings.mcp.modal.done')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Delete Legacy Token confirm ── */}
      {mcpDeleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget) setMcpDeleteId(null) }}>
          <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.deleteTokenTitle')}</h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.deleteTokenMessage')}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setMcpDeleteId(null)}
                className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={() => handleDeleteMcpToken(mcpDeleteId)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700">
                {t('settings.mcp.deleteTokenTitle')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
