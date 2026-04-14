import apiClient from './apiClient'

export const tagsApi = {
  list: () => apiClient.get('/tags').then(r => r.data),
  create: (data: Record<string, unknown>) => apiClient.post('/tags', data).then(r => r.data),
  update: (id: number, data: Record<string, unknown>) => apiClient.put(`/tags/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/tags/${id}`).then(r => r.data),
}

export const categoriesApi = {
  list: () => apiClient.get('/categories').then(r => r.data),
  create: (data: Record<string, unknown>) => apiClient.post('/categories', data).then(r => r.data),
  update: (id: number, data: Record<string, unknown>) => apiClient.put(`/categories/${id}`, data).then(r => r.data),
  delete: (id: number) => apiClient.delete(`/categories/${id}`).then(r => r.data),
}
