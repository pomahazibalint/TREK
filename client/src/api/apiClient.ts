import axios, { AxiosInstance, AxiosError } from 'axios'
import { getSocketId } from './websocket'
import { addToQueue } from '../services/offlineQueue'

const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor - add socket ID
apiClient.interceptors.request.use(
  (config) => {
    const sid = getSocketId()
    if (sid) {
      config.headers['X-Socket-Id'] = sid
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor - handle 401, queue offline mutations
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    // Check for auth/MFA errors
    if (error.response?.status === 401 && (error.response?.data as { code?: string } | undefined)?.code === 'AUTH_REQUIRED') {
      if (!window.location.pathname.includes('/login') && !window.location.pathname.includes('/register') && !window.location.pathname.startsWith('/shared/')) {
        const currentPath = window.location.pathname + window.location.search
        window.location.href = '/login?redirect=' + encodeURIComponent(currentPath)
      }
    }
    if (
      error.response?.status === 403 &&
      (error.response?.data as { code?: string } | undefined)?.code === 'MFA_REQUIRED' &&
      !window.location.pathname.startsWith('/settings')
    ) {
      window.location.href = '/settings?mfa=required'
    }

    // Queue mutation to offline queue if:
    // 1. Network error (no response) — connection lost
    // 2. It's a mutation (POST/PUT/DELETE)
    // 3. It's to a trip endpoint (not auth/admin)
    const isNetworkError = !error.response
    const isMutation = ['POST', 'PUT', 'DELETE'].includes(error.config?.method?.toUpperCase() || '')
    const isTripEndpoint = error.config?.url?.includes('/trips/') && !error.config?.url?.includes('/auth')

    if (isNetworkError && isMutation && isTripEndpoint) {
      const endpoint = error.config!.url || ''
      const method = (error.config?.method?.toUpperCase() || 'POST') as 'POST' | 'PUT' | 'DELETE'
      const body = error.config?.data ? JSON.parse(error.config.data) : undefined

      // Extract entity type and ID from endpoint for UI purposes
      const tripIdMatch = endpoint.match(/\/trips\/(\d+)/)
      const typeMatch = endpoint.match(/\/trips\/\d+\/(\w+)/) // places, reservations, etc.
      const idMatch = endpoint.match(/\/(\d+)(?:\/|$)/)

      try {
        await addToQueue({
          endpoint,
          method,
          body,
          entityType: typeMatch ? typeMatch[1] : undefined,
          entityId: idMatch ? parseInt(idMatch[1], 10) : undefined,
        })
        console.log('[OfflineQueue] Added failed mutation to queue:', endpoint)
      } catch (err) {
        console.error('[OfflineQueue] Failed to queue mutation:', err)
      }
    }

    return Promise.reject(error)
  }
)

export default apiClient
