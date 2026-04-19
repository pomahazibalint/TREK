import apiClient from './apiClient'

export const filesApi = {
  list: (tripId: number | string, trash?: boolean) => apiClient.get(`/trips/${tripId}/files`, { params: trash ? { trash: 'true' } : {} }).then(r => r.data),
  upload: (tripId: number | string, formData: FormData) => apiClient.post(`/trips/${tripId}/files`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  }).then(r => r.data),
  update: (tripId: number | string, id: number, data: Record<string, unknown>) => apiClient.put(`/trips/${tripId}/files/${id}`, data).then(r => r.data),
  delete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}`).then(r => r.data),
  toggleStar: (tripId: number | string, id: number) => apiClient.patch(`/trips/${tripId}/files/${id}/star`).then(r => r.data),
  restore: (tripId: number | string, id: number) => apiClient.post(`/trips/${tripId}/files/${id}/restore`).then(r => r.data),
  permanentDelete: (tripId: number | string, id: number) => apiClient.delete(`/trips/${tripId}/files/${id}/permanent`).then(r => r.data),
  emptyTrash: (tripId: number | string) => apiClient.delete(`/trips/${tripId}/files/trash/empty`).then(r => r.data),
  addLink: (tripId: number | string, fileId: number, data: { reservation_id?: number; assignment_id?: number; place_id?: number }) => apiClient.post(`/trips/${tripId}/files/${fileId}/link`, data).then(r => r.data),
  removeLink: (tripId: number | string, fileId: number, linkId: number) => apiClient.delete(`/trips/${tripId}/files/${fileId}/link/${linkId}`).then(r => r.data),
  getLinks: (tripId: number | string, fileId: number) => apiClient.get(`/trips/${tripId}/files/${fileId}/links`).then(r => r.data),
}
