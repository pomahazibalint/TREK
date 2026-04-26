import apiClient from './apiClient'

export const mapsApi = {
  autocomplete: (input: string, lang?: string, signal?: AbortSignal) =>
    apiClient.post(`/maps/autocomplete?lang=${lang || 'en'}`, { input }, { signal }).then(r => r.data),
  search: (query: string, lang?: string) => apiClient.post(`/maps/search?lang=${lang || 'en'}`, { query }).then(r => r.data),
  details: (placeId: string, lang?: string) => apiClient.get(`/maps/details/${encodeURIComponent(placeId)}`, { params: { lang } }).then(r => r.data),
  placePhoto: (placeId: string, lat?: number, lng?: number, name?: string) => apiClient.get(`/maps/place-photo/${encodeURIComponent(placeId)}`, { params: { lat, lng, name } }).then(r => r.data),
  reverse: (lat: number, lng: number, lang?: string) => apiClient.get('/maps/reverse', { params: { lat, lng, lang } }).then(r => r.data),
  resolveUrl: (url: string) => apiClient.post('/maps/resolve-url', { url }).then(r => r.data),
  elevation: (locations: { latitude: number; longitude: number }[]) => apiClient.post('/maps/elevation', { locations }).then(r => r.data),
}
