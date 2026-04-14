import apiClient from './apiClient'

export const notificationsApi = {
  getPreferences: () => apiClient.get('/notifications/preferences').then(r => r.data),
  updatePreferences: (prefs: Record<string, Record<string, boolean>>) => apiClient.put('/notifications/preferences', prefs).then(r => r.data),
  testSmtp: (email?: string) => apiClient.post('/notifications/test-smtp', { email }).then(r => r.data),
  testWebhook: (url?: string) => apiClient.post('/notifications/test-webhook', { url }).then(r => r.data),
}

export const inAppNotificationsApi = {
  list: (params?: { limit?: number; offset?: number; unread_only?: boolean }) =>
    apiClient.get('/notifications/in-app', { params }).then(r => r.data),
  unreadCount: () =>
    apiClient.get('/notifications/in-app/unread-count').then(r => r.data),
  markRead: (id: number) =>
    apiClient.put(`/notifications/in-app/${id}/read`).then(r => r.data),
  markUnread: (id: number) =>
    apiClient.put(`/notifications/in-app/${id}/unread`).then(r => r.data),
  markAllRead: () =>
    apiClient.put('/notifications/in-app/read-all').then(r => r.data),
  delete: (id: number) =>
    apiClient.delete(`/notifications/in-app/${id}`).then(r => r.data),
  deleteAll: () =>
    apiClient.delete('/notifications/in-app/all').then(r => r.data),
  respond: (id: number, response: 'positive' | 'negative') =>
    apiClient.post(`/notifications/in-app/${id}/respond`, { response }).then(r => r.data),
}
