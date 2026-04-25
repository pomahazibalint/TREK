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
let dbInitPromise: Promise<void> | null = null

/**
 * Initialize IndexedDB for offline queue.
 */
export async function initOfflineQueue(): Promise<void> {
  if (dbInitPromise) return dbInitPromise

  dbInitPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)

    request.onerror = () => {
      console.error('[OfflineQueue] Failed to open DB:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      db = request.result
      console.log('[OfflineQueue] Database initialized')
      resolve()
    }

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
  })

  return dbInitPromise
}

/**
 * Ensure database is initialized before proceeding.
 */
async function ensureDbReady(): Promise<void> {
  if (db) return
  if (dbInitPromise) return dbInitPromise
  await initOfflineQueue()
}

/**
 * Add a mutation to the offline queue.
 */
export async function addToQueue(mutation: Omit<QueuedMutation, 'id' | 'timestamp' | 'retryCount'>): Promise<void> {
  // Ensure DB is ready before queueing
  await ensureDbReady()

  if (!db) {
    console.warn('[OfflineQueue] DB failed to initialize')
    return
  }

  const queuedMutation: QueuedMutation = {
    id: `${mutation.endpoint}-${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    retryCount: 0,
    ...mutation,
  }

  console.log('[OfflineQueue] Adding mutation to queue:', {
    id: queuedMutation.id,
    method: queuedMutation.method,
    endpoint: queuedMutation.endpoint,
    entityType: queuedMutation.entityType,
  })

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.add(queuedMutation)

    request.onerror = () => {
      console.error('[OfflineQueue] Error adding mutation:', request.error)
      reject(request.error)
    }
    request.onsuccess = () => {
      console.log('[OfflineQueue] Successfully added mutation:', queuedMutation.id)
      resolve()
    }
  })
}

/**
 * Get all queued mutations.
 */
export async function getAllMutations(): Promise<QueuedMutation[]> {
  await ensureDbReady()

  if (!db) {
    console.warn('[OfflineQueue] DB failed to initialize')
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
  await ensureDbReady()

  if (!db) {
    console.warn('[OfflineQueue] DB failed to initialize')
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(id)

    request.onerror = () => {
      console.error('[OfflineQueue] Error removing mutation:', id, request.error)
      reject(request.error)
    }
    request.onsuccess = () => {
      console.log('[OfflineQueue] Successfully removed mutation from queue:', id)
      resolve()
    }
  })
}

/**
 * Increment retry count for a mutation.
 */
export async function incrementRetry(id: string): Promise<void> {
  await ensureDbReady()

  if (!db) {
    console.warn('[OfflineQueue] DB failed to initialize')
    return
  }

  return new Promise((resolve, reject) => {
    const tx = db!.transaction([STORE_NAME], 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const getRequest = store.get(id)

    getRequest.onerror = () => {
      console.error('[OfflineQueue] Error getting mutation for retry:', id, getRequest.error)
      reject(getRequest.error)
    }
    getRequest.onsuccess = () => {
      const mutation = getRequest.result as QueuedMutation | undefined
      if (mutation) {
        mutation.retryCount += 1
        console.log(`[OfflineQueue] Incremented retry count for ${id} to ${mutation.retryCount}`)
        const updateRequest = store.put(mutation)
        updateRequest.onerror = () => {
          console.error('[OfflineQueue] Error updating retry count:', id, updateRequest.error)
          reject(updateRequest.error)
        }
        updateRequest.onsuccess = () => {
          console.log('[OfflineQueue] Successfully updated retry count:', id)
          resolve()
        }
      } else {
        console.warn('[OfflineQueue] Mutation not found for retry increment:', id)
        resolve()
      }
    }
  })
}

/**
 * Clear all queued mutations (on user logout or explicit reset).
 */
export async function clearQueue(): Promise<void> {
  await ensureDbReady()

  if (!db) {
    console.warn('[OfflineQueue] DB failed to initialize')
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

  console.log('[OfflineQueue] Starting replay with', mutations.length, 'mutations')

  // Always use window.fetch bound to window context
  const doFetch = window.fetch.bind(window)

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
      const requestBody = mutation.body ? JSON.stringify(mutation.body) : undefined

      console.log(`[OfflineQueue] Replaying ${mutation.method} ${endpoint}`, {
        retryCount: `${mutation.retryCount}/${MAX_RETRIES}`,
        body: requestBody ? requestBody.substring(0, 100) : 'empty',
      })

      const response = await doFetch(endpoint, {
        method: mutation.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Idempotency-Key': mutation.id,
        },
        body: requestBody,
        credentials: 'include', // Important: include cookies for auth
      })

      console.log(`[OfflineQueue] Response for ${mutation.id}: ${response.status} ${response.statusText}`)

      if (response.ok) {
        await removeFromQueue(mutation.id)
        console.log('[OfflineQueue] Successfully removed from queue:', mutation.id)
        success += 1
      } else {
        // Server error — increment retry and keep in queue
        const errorText = await response.text().catch(() => 'unable to read body')
        console.warn(`[OfflineQueue] Server error (${response.status}) for ${mutation.id}: ${errorText}`)
        await incrementRetry(mutation.id)
        failed += 1
      }
    } catch (err) {
      // Network error — increment retry and keep in queue
      console.warn('[OfflineQueue] Replay failed with error:', mutation.id, err instanceof Error ? err.message : err)
      await incrementRetry(mutation.id)
      failed += 1
    }
  }

  console.log('[OfflineQueue] Replay complete:', { success, failed, total: mutations.length })
  return { success, failed }
}
