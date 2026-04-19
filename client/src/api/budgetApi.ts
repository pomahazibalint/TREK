import apiClient from './apiClient'

export const budgetApi = {
  list: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget`).then(r => r.data),
  create: (tripId: number | string, data: Record<string, unknown>) => apiClient.post(`/trips/${tripId}/budget`, data).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/budget/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/budget/${id}`).then(r => r.data),
  setMemberOwed: (tripId: number | string, id: number, members: { user_id: number; amount_owed: number }[], tip: number) =>
    apiClient.put(`/trips/${tripId}/budget/${id}/members`, { members, tip }).then(r => r.data),
  setMemberPayments: (tripId: number | string, id: number, payments: { user_id: number; amount_paid: number }[]) =>
    apiClient.put(`/trips/${tripId}/budget/${id}/members/payments`, { payments }).then(r => r.data),
  settlement: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget/settlement`).then(r => r.data),
  listDrafts: (tripId: number | string) => apiClient.get(`/trips/${tripId}/budget/drafts`).then(r => r.data),
  convertDraft: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/budget/${id}/convert`).then(r => r.data),
  listFiles: (tripId: number | string, itemId: number) => apiClient.get(`/trips/${tripId}/budget/${itemId}/files`).then(r => r.data),
  uploadReceipt: (tripId: number | string, itemId: number, file: File) => {
    const fd = new FormData(); fd.append('file', file)
    return apiClient.post(`/trips/${tripId}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then(r => r.data)
      .then(async (created) => {
        await apiClient.post(`/trips/${tripId}/files/${created.file.id}/link`, { budget_item_id: itemId })
        return created
      })
  },
}
