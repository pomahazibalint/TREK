import apiClient from './apiClient'

export const tripsApi = {
  list: (params?: Record<string, unknown>) => apiClient.get('/trips', { params }).then(r => r.data),
  create: (data: Record<string, unknown>) => apiClient.post('/trips', data).then(r => r.data),
  get: (id: number | string) => apiClient.get(`/trips/${id}`).then(r => r.data),
  update: (id: number | string, data: Record<string, unknown>) => apiClient.put(`/trips/${id}`, data).then(r => r.data),
  delete: (id: number | string) => apiClient.delete(`/trips/${id}`).then(r => r.data),
  uploadCover: (id: number | string, formData: FormData) => apiClient.post(`/trips/${id}/cover`, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data),
  archive: (id: number | string) => apiClient.put(`/trips/${id}`, { is_archived: true }).then(r => r.data),
  unarchive: (id: number | string) => apiClient.put(`/trips/${id}`, { is_archived: false }).then(r => r.data),
  getMembers: (id: number | string) => apiClient.get(`/trips/${id}/members`).then(r => r.data),
  addMember: (id: number | string, identifier: string) => apiClient.post(`/trips/${id}/members`, { identifier }).then(r => r.data),
  removeMember: (id: number | string, userId: number) => apiClient.delete(`/trips/${id}/members/${userId}`).then(r => r.data),
  copy: (id: number | string, data?: { title?: string }) => apiClient.post(`/trips/${id}/copy`, data || {}).then(r => r.data),
  getUserSettings: (id: number | string) => apiClient.get(`/trips/${id}/user-settings`).then(r => r.data),
  updateUserSettings: (id: number | string, data: { add_to_calendar: number }) => apiClient.put(`/trips/${id}/user-settings`, data).then(r => r.data),
  getCalendarConflicts: (id: number | string) => apiClient.get(`/trips/${id}/calendar-conflicts`).then(r => r.data),
}

export const daysApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/days`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/days`, data).then(r => r.data),
  update: (tripId: number | string, dayId: number | string, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/days/${dayId}`, data).then(r => r.data),
  delete: (tripId: number | string, dayId: number | string) => apiClient.delete(`/trips/${tripId}/days/${dayId}`).then(r => r.data),
  duplicate: (tripId: number | string, dayId: number | string) => apiClient.post(`/trips/${tripId}/days/${dayId}/duplicate`).then(r => r.data),
}
