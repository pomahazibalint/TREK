import type { StoreApi } from 'zustand'
import type { TripStoreState } from '../tripStore'
import type { Photo } from '../../types'

type SetState = StoreApi<TripStoreState>['setState']
type GetState = StoreApi<TripStoreState>['getState']

const photosUrl = (tripId: number | string) => `/api/trips/${tripId}/photos`

export interface PhotosSlice {
  photos: Photo[]
  loadPhotos: (tripId: number | string) => Promise<void>
  addPhoto: (tripId: number | string, formData: FormData) => Promise<void>
  deletePhoto: (tripId: number | string, photoId: number) => Promise<void>
  updatePhoto: (tripId: number | string, photoId: number, data: Partial<Photo>) => Promise<void>
}

export const createPhotosSlice = (set: SetState, _get: GetState): PhotosSlice => ({
  photos: [],

  loadPhotos: async (tripId) => {
    try {
      const res = await fetch(photosUrl(tripId), { credentials: 'include' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ photos: data.photos || [] })
    } catch (err) {
      console.error('Failed to load photos:', err)
    }
  },

  addPhoto: async (tripId, formData) => {
    const res = await fetch(photosUrl(tripId), {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    set(state => ({ photos: [...(state.photos || []), ...(data.photos || [])] }))
  },

  deletePhoto: async (tripId, photoId) => {
    const res = await fetch(`${photosUrl(tripId)}/${photoId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    set(state => ({ photos: (state.photos || []).filter(p => p.id !== photoId) }))
  },

  updatePhoto: async (tripId, photoId, data) => {
    const res = await fetch(`${photosUrl(tripId)}/${photoId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const result = await res.json()
    set(state => ({
      photos: (state.photos || []).map(p => p.id === photoId ? { ...p, ...result.photo } : p),
    }))
  },
})
