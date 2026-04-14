import apiClient from './apiClient'

export const settingsApi = {
  get: () => apiClient.get('/settings').then(r => r.data),
  set: (key: string, value: unknown) => apiClient.put('/settings', { key, value }).then(r => r.data),
  setBulk: (settings: Record<string, unknown>) => apiClient.post('/settings/bulk', { settings }).then(r => r.data),
}
