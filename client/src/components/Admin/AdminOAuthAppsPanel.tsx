import React, { useEffect, useState } from 'react'
import { Trash2, Copy, Plus, Check, RotateCcw } from 'lucide-react'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import {
  oauthApi,
  type OAuthClient,
  CLIENT_SCOPE_DEFINITIONS,
  SCOPE_PRESETS,
} from '../../api/oauthApi'
import ScopeGroupPicker from '../Settings/ScopeGroupPicker'

export default function AdminOAuthAppsPanel(): React.ReactElement {
  const toast = useToast()
  const { t, locale } = useTranslation()

  const [clients, setClients] = useState<OAuthClient[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [createdResult, setCreatedResult] = useState<{ client_id: string; clientSecret: string | null } | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [expandedScopes, setExpandedScopes] = useState<Record<string, boolean>>({})
  const [rotatedSecrets, setRotatedSecrets] = useState<Record<string, string>>({})

  // Create form state
  const [name, setName] = useState('')
  const [redirectsRaw, setRedirectsRaw] = useState('')
  const [scopes, setScopes] = useState<string[]>(SCOPE_PRESETS.claude_ai)
  const [isPublic, setIsPublic] = useState(true)
  const [creating, setCreating] = useState(false)

  const mcpEndpoint = `${window.location.origin}/mcp`

  useEffect(() => {
    oauthApi.listClients()
      .then(d => setClients(d.clients))
      .catch(() => toast.error(t('settings.mcp.apps.createError')))
      .finally(() => setLoading(false))
  }, [])

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 2000)
    })
  }

  const handleCreate = async () => {
    if (!name.trim()) return
    const redirectUris = redirectsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    if (!redirectUris.length) { toast.error('At least one redirect URI required'); return }
    setCreating(true)
    try {
      const { client, clientSecret } = await oauthApi.createClient({
        name: name.trim(), redirect_uris: redirectUris, allowed_scopes: scopes, is_public: isPublic,
      })
      setClients(prev => [client, ...prev])
      setCreatedResult({ client_id: client.client_id, clientSecret })
      setName(''); setRedirectsRaw(''); setScopes(SCOPE_PRESETS.claude_ai); setIsPublic(true)
      toast.success(t('settings.mcp.apps.created'))
    } catch {
      toast.error(t('settings.mcp.apps.createError'))
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (clientId: string) => {
    try {
      await oauthApi.deleteClient(clientId)
      setClients(prev => prev.filter(c => c.client_id !== clientId))
      setDeleteId(null)
      toast.success(t('settings.mcp.apps.deleted'))
    } catch {
      toast.error(t('settings.mcp.apps.deleteError'))
    }
  }

  const handleRotate = async (clientId: string) => {
    try {
      const { clientSecret } = await oauthApi.rotateClientSecret(clientId)
      setRotatedSecrets(prev => ({ ...prev, [clientId]: clientSecret }))
      toast.success(t('settings.mcp.apps.rotated'))
    } catch {
      toast.error(t('settings.mcp.apps.rotateError'))
    }
  }

  const PRESET_BTNS: [string, string][] = [
    ['claude_ai', t('settings.mcp.apps.preset.claude')],
    ['claude_desktop', t('settings.mcp.apps.preset.claudeDesktop')],
    ['chatgpt', t('settings.mcp.apps.preset.chatgpt')],
    ['read_only', t('settings.mcp.apps.preset.readOnly')],
  ]

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('admin.oauthApps.title')}</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{t('admin.oauthApps.subtitle')}</p>
      </div>

      {/* MCP endpoint */}
      <div>
        <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.endpoint')}</label>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono border"
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
            {mcpEndpoint}
          </code>
          <button onClick={() => handleCopy(mcpEndpoint, 'endpoint')}
            className="p-2 rounded-lg border transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
            style={{ borderColor: 'var(--border-primary)' }}>
            {copiedKey === 'endpoint' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />}
          </button>
        </div>
      </div>

      {/* App list */}
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-card)' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)' }}>
          <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('admin.oauthApps.registered')}</span>
          <button onClick={() => { setCreateOpen(true); setCreatedResult(null) }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white"
            style={{ background: 'var(--accent-primary, #4f46e5)' }}>
            <Plus className="w-3.5 h-3.5" /> {t('settings.mcp.apps.create')}
          </button>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>Loading…</div>
        ) : clients.length === 0 ? (
          <div className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('settings.mcp.apps.empty')}</div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border-primary)' }}>
            {clients.map(client => {
              const expanded = expandedScopes[client.client_id]
              const visible = expanded ? client.allowed_scopes : client.allowed_scopes.slice(0, 4)
              const rotated = rotatedSecrets[client.client_id]
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
                      <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {client.client_id}
                        <span className="ml-2 font-sans">{new Date(client.created_at).toLocaleDateString(locale)}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!client.is_public && (
                        <button onClick={() => handleRotate(client.client_id)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                          style={{ color: 'var(--text-tertiary)' }} title={t('settings.mcp.apps.rotate')}>
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => setDeleteId(client.client_id)}
                        className="p-1.5 rounded-lg transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                        style={{ color: 'var(--text-tertiary)' }}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {visible.map(s => (
                      <span key={s} className="text-xs px-1.5 py-0.5 rounded font-mono"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>{s}</span>
                    ))}
                    {client.allowed_scopes.length > 4 && (
                      <button onClick={() => setExpandedScopes(p => ({ ...p, [client.client_id]: !expanded }))}
                        className="text-xs px-1.5 py-0.5" style={{ color: 'var(--accent-primary, #4f46e5)' }}>
                        {expanded ? 'less' : `+${client.allowed_scopes.length - 4} more`}
                      </button>
                    )}
                  </div>
                  {rotated && (
                    <div className="flex items-center gap-2 p-2 rounded-lg border border-amber-200" style={{ background: 'rgba(251,191,36,0.1)' }}>
                      <p className="text-xs flex-1 font-mono break-all" style={{ color: 'var(--text-secondary)' }}>{rotated}</p>
                      <button onClick={() => handleCopy(rotated, `r-${client.client_id}`)} style={{ color: 'var(--text-tertiary)' }}>
                        {copiedKey === `r-${client.client_id}` ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Create modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget && !createdResult) setCreateOpen(false) }}>
          <div className="rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" style={{ background: 'var(--bg-card)' }}>
            {!createdResult ? (
              <>
                <div className="px-6 pt-6 pb-4 border-b" style={{ borderColor: 'var(--border-primary)' }}>
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.apps.modal.createTitle')}</h3>
                </div>
                <div className="overflow-y-auto px-6 py-4 space-y-4 flex-1">
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.name')}</label>
                    <input type="text" value={name} onChange={e => setName(e.target.value)}
                      placeholder={t('settings.mcp.apps.namePlaceholder')} autoFocus
                      className="w-full px-3 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.redirectUris')}</label>
                    <textarea value={redirectsRaw} onChange={e => setRedirectsRaw(e.target.value)}
                      rows={3} placeholder="https://example.com/callback"
                      className="w-full px-3 py-2.5 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                      style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('settings.mcp.apps.redirectUrisHint')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="admin-app-public" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} className="w-4 h-4 accent-indigo-600" />
                    <label htmlFor="admin-app-public" className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.isPublic')}</label>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.preset')}</span>
                      {PRESET_BTNS.map(([key, label]) => (
                        <button key={key} type="button" onClick={() => setScopes(SCOPE_PRESETS[key])}
                          className="px-2 py-0.5 rounded text-xs border transition-colors"
                          style={{ borderColor: 'var(--border-primary)', color: 'var(--text-tertiary)', background: 'var(--bg-secondary)' }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.scopes')}</p>
                    <ScopeGroupPicker availableScopes={CLIENT_SCOPE_DEFINITIONS} selectedScopes={scopes} onChange={setScopes} />
                  </div>
                </div>
                <div className="px-6 py-4 border-t flex gap-2 justify-end" style={{ borderColor: 'var(--border-primary)' }}>
                  <button onClick={() => setCreateOpen(false)}
                    className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                    {t('common.cancel')}
                  </button>
                  <button onClick={handleCreate} disabled={!name.trim() || creating || scopes.length === 0}
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
                      {createdResult.client_id}
                    </code>
                    <button onClick={() => handleCopy(createdResult.client_id, 'new-cid')} style={{ color: 'var(--text-tertiary)' }}>
                      {copiedKey === 'new-cid' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                {createdResult.clientSecret && (
                  <div>
                    <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.secretOnce')}</label>
                    <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-200 mb-2" style={{ background: 'rgba(251,191,36,0.1)' }}>
                      <span className="text-amber-500 shrink-0">⚠</span>
                      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.secretWarning')}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 rounded-lg text-xs font-mono border break-all"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
                        {createdResult.clientSecret}
                      </code>
                      <button onClick={() => handleCopy(createdResult.clientSecret!, 'new-sec')} style={{ color: 'var(--text-tertiary)' }}>
                        {copiedKey === 'new-sec' ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex justify-end">
                  <button onClick={() => { setCreateOpen(false); setCreatedResult(null) }}
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

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}
          onClick={e => { if (e.target === e.currentTarget) setDeleteId(null) }}>
          <div className="rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4" style={{ background: 'var(--bg-card)' }}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.mcp.apps.modal.deleteTitle')}</h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('settings.mcp.apps.modal.deleteMessage')}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteId(null)}
                className="px-4 py-2 rounded-lg text-sm border" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}>
                {t('common.cancel')}
              </button>
              <button onClick={() => handleDelete(deleteId)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700">
                {t('settings.mcp.apps.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
