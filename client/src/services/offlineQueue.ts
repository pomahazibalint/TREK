/**
 * Offline mutation queue using IndexedDB.
 * Stores failed API requests and replays them when connection returns.
 */

export interface QueuedMutation {
  id: string
  endpoint: string
  method: 'POST' | 'PUT' | 'DELETE'
  body?: any
  timestamp: number
  retryCount: number
  entityType?: string // 'place', 'reservation', etc. for UI purposes
  entityId?: number
}

const DB_NAME = 'trek-offline'
const STORE_NAME = 'mutations'
const MAX_RETRIES = 3

let db: IDBDatabase | null = null

/**
 * Initialize IndexedDB for offline queue.
 */
export async function initOfflineQueue(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)

    request.onerror = () => {
      console.error('[OfflineQueue] Failed to open DB:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      db = request.result
      resolve()
    }

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
  })
}

/**
 * Add a mutation to the offline queue.
 */
export async function addToQueue(mutation: Omit<QueuedMutation, 'id' | 'timestamp' | 'retryCount'>): Promise<void> {
  if (!db) {
    console.warn('[OfflineQueue] DB not initialized')
    return
  }

  const queuedMutation: QueuedMutation = {
    id: `${mutation.endpoint}-${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    retryCount: 0,
    ...mutation,
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.add(queuedMutation)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      console.log('[OfflineQueue] Added mutation:', queuedMutation.id)
      resolve()
    }
  })
}

/**
 * Get all queued mutations.
 */
export async function getAllMutations(): Promise<QueuedMutation[]> {
  if (!db) {
    console.warn('[OfflineQueue] DB not initialized')
    return []
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const mutations = request.result as QueuedMutation[]
      resolve(mutations.sort((a, b) => a.timestamp - b.timestamp)) // Replay in order
    }
  })
}

/**
 * Remove a mutation from the queue (after successful replay).
 */
export async function removeFromQueue(id: string): Promise<void> {
  if (!db) {
    console.warn('[OfflineQueue] DB not initialized')
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(id)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      console.log('[OfflineQueue] Removed mutation:', id)
      resolve()
    }
  })
}

/**
 * Increment retry count for a mutation.
 */
export async function incrementRetry(id: string): Promise<void> {
  if (!db) {
    console.warn('[OfflineQueue] DB not initialized')
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getRequest = store.get(id)

    getRequest.onerror = () => reject(getRequest.error)
    getRequest.onsuccess = () => {
      const mutation = getRequest.result as QueuedMutation | undefined
      if (mutation) {
        mutation.retryCount += 1
        const updateRequest = store.put(mutation)
        updateRequest.onerror = () => reject(updateRequest.error)
        updateRequest.onsuccess = () => resolve()
      }
    }
  })
}

/**
 * Clear all queued mutations (on user logout or explicit reset).
 */
export async function clearQueue(): Promise<void> {
  if (!db) {
    console.warn('[OfflineQueue] DB not initialized')
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.clear()

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      console.log('[OfflineQueue] Queue cleared')
      resolve()
    }
  })
}

/**
 * Replay all queued mutations.
 * Expects the fetch function to handle credentials and headers properly (e.g., axios instance).
 * Returns count of successful replays.
 */
export async function replayQueue(fetchFn?: (input: string | Request, init?: RequestInit) => Promise<Response>): Promise<{ success: number; failed: number }> {
  const mutations = await getAllMutations()
  let success = 0
  let failed = 0

  // Use global fetch if no custom fetchFn provided
  const doFetch = fetchFn || window.fetch.bind(window)

  for (const mutation of mutations) {
    // Skip if too many retries
    if (mutation.retryCount >= MAX_RETRIES) {
      console.warn('[OfflineQueue] Max retries exceeded for:', mutation.id)
      await removeFromQueue(mutation.id)
      failed += 1
      continue
    }

    try {
      // Absolute URL for fetch: prepend /api if not present
      const endpoint = mutation.endpoint.startsWith('/api') ? mutation.endpoint : `/api${mutation.endpoint}`

      const response = await doFetch(endpoint, {
        method: mutation.method,
        headers: { 'Content-Type': 'application/json' },
        body: mutation.body ? JSON.stringify(mutation.body) : undefined,
        credentials: 'include', // Important: include cookies for auth
      })

      if (response.ok) {
        await removeFromQueue(mutation.id)
        console.log('[OfflineQueue] Replayed mutation:', mutation.id)
        success += 1
      } else {
        // Server error — increment retry and keep in queue
        await incrementRetry(mutation.id)
        failed += 1
      }
    } catch (err) {
      // Network error — increment retry and keep in queue
      await incrementRetry(mutation.id)
      console.warn('[OfflineQueue] Replay failed:', mutation.id, err)
      failed += 1
    }
  }

  return { success, failed }
}
