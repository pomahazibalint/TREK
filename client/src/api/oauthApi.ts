import apiClient from './apiClient'

export interface ScopeDefinition {
  scope: string
  label: string
  group: string
}

export interface OAuthClient {
  id: string
  user_id: number | null
  name: string
  client_id: string
  redirect_uris: string[]
  allowed_scopes: string[]
  is_public: boolean
  created_via: 'settings_ui' | 'dcr'
  created_at: string
}

export interface OAuthSessionInfo {
  id: number
  client_id: string
  client_name: string
  scopes: string[]
  audience: string
  created_at: string
  access_token_expires_at: string
  refresh_token_expires_at: string
}

export interface ValidateAuthorizeResponse {
  valid: boolean
  loginRequired?: boolean
  consentRequired?: boolean
  client?: { name: string; clientId: string }
  scopes?: ScopeDefinition[]
  scopeSelectable?: boolean
  error?: string
}

export const CLIENT_SCOPE_DEFINITIONS: ScopeDefinition[] = [
  { scope: 'trips:read',          label: 'View trips & itineraries',        group: 'Trips' },
  { scope: 'trips:write',         label: 'Create & edit trips',             group: 'Trips' },
  { scope: 'trips:delete',        label: 'Delete trips',                    group: 'Trips' },
  { scope: 'trips:share',         label: 'Create share links',              group: 'Trips' },
  { scope: 'places:read',         label: 'View places',                     group: 'Places' },
  { scope: 'places:write',        label: 'Add & edit places',               group: 'Places' },
  { scope: 'atlas:read',          label: 'View atlas (visited & bucket list)', group: 'Atlas' },
  { scope: 'atlas:write',         label: 'Update atlas',                    group: 'Atlas' },
  { scope: 'packing:read',        label: 'View packing lists',              group: 'Packing' },
  { scope: 'packing:write',       label: 'Manage packing lists',            group: 'Packing' },
  { scope: 'todos:read',          label: 'View to-do lists',                group: 'Todos' },
  { scope: 'todos:write',         label: 'Manage to-do lists',              group: 'Todos' },
  { scope: 'budget:read',         label: 'View budget',                     group: 'Budget' },
  { scope: 'budget:write',        label: 'Manage budget',                   group: 'Budget' },
  { scope: 'reservations:read',   label: 'View reservations',               group: 'Reservations' },
  { scope: 'reservations:write',  label: 'Manage reservations',             group: 'Reservations' },
  { scope: 'collab:read',         label: 'View collaboration notes',        group: 'Collab' },
  { scope: 'collab:write',        label: 'Manage collaboration notes',      group: 'Collab' },
  { scope: 'notifications:read',  label: 'View notifications',              group: 'Notifications' },
  { scope: 'notifications:write', label: 'Manage notification preferences', group: 'Notifications' },
  { scope: 'vacay:read',          label: 'View vacation plans',             group: 'Vacay' },
  { scope: 'vacay:write',         label: 'Manage vacation plans',           group: 'Vacay' },
  { scope: 'geo:read',            label: 'Geocoding & search',              group: 'Geo' },
  { scope: 'weather:read',        label: 'Weather forecasts',               group: 'Weather' },
]

export const ALL_SCOPE_STRINGS = CLIENT_SCOPE_DEFINITIONS.map(s => s.scope)

export const SCOPE_PRESETS: Record<string, string[]> = {
  claude_ai:      ALL_SCOPE_STRINGS,
  claude_desktop: ALL_SCOPE_STRINGS,
  chatgpt: [
    'trips:read', 'trips:write', 'places:read', 'places:write', 'geo:read',
    'budget:read', 'budget:write', 'reservations:read', 'reservations:write',
    'packing:read', 'packing:write',
  ],
  read_only: CLIENT_SCOPE_DEFINITIONS.filter(s => s.scope.endsWith(':read')).map(s => s.scope),
}

export const oauthApi = {
  validateAuthorize: (params: URLSearchParams): Promise<ValidateAuthorizeResponse> =>
    apiClient.get(`/oauth/authorize/validate?${params}`).then(r => r.data),

  submitConsent: (body: object): Promise<{ redirect: string }> =>
    apiClient.post('/oauth/authorize', body).then(r => r.data),

  listClients: (): Promise<{ clients: OAuthClient[] }> =>
    apiClient.get('/oauth/clients').then(r => r.data),

  createClient: (data: { name: string; redirect_uris: string[]; allowed_scopes: string[]; is_public?: boolean }): Promise<{ client: OAuthClient; clientSecret: string | null }> =>
    apiClient.post('/oauth/clients', data).then(r => r.data),

  rotateClientSecret: (clientId: string): Promise<{ clientSecret: string }> =>
    apiClient.post(`/oauth/clients/${clientId}/rotate`).then(r => r.data),

  deleteClient: (clientId: string): Promise<void> =>
    apiClient.delete(`/oauth/clients/${clientId}`).then(r => r.data),

  listSessions: (): Promise<{ sessions: OAuthSessionInfo[] }> =>
    apiClient.get('/oauth/sessions').then(r => r.data),

  revokeSession: (tokenId: number): Promise<void> =>
    apiClient.delete(`/oauth/sessions/${tokenId}`).then(r => r.data),
}
