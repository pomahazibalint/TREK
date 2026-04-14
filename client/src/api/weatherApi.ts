import apiClient from './apiClient'

export const weatherApi = {
  get: (lat: number, lng: number, date: string) => apiClient.get('/weather', { params: { lat, lng, date } }).then(r => r.data),
  getDetailed: (lat: number, lng: number, date: string, lang?: string) => apiClient.get('/weather/detailed', { params: { lat, lng, date, lang } }).then(r => r.data),
}
