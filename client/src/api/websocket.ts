// Singleton WebSocket manager for real-time collaboration

import { replayQueue, getAllMutations } from '../services/offlineQueue.js'

type WebSocketListener = (event: Record<string, unknown>) => void
type RefetchCallback = (tripId: string) => void
type OnQueueReplayedCallback = (result: { success: number; failed: number }) => void

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
const listeners = new Set<WebSocketListener>()
const activeTrips = new Set<string>()
let shouldReconnect = false
let refetchCallback: RefetchCallback | null = null
let mySocketId: string | null = null
let connecting = false
let onlineListenersAttached = false
let onQueueReplayedCallback: OnQueueReplayedCallback | null = null

export function getSocketId(): string | null {
  return mySocketId
}

export function setRefetchCallback(fn: RefetchCallback | null): void {
  refetchCallback = fn
}

export function setOnQueueReplayedCallback(fn: OnQueueReplayedCallback | null): void {
  onQueueReplayedCallback = fn
}

function getWsUrl(wsToken: string): string {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${location.host}/ws?token=${wsToken}`
}

async function fetchWsToken(): Promise<string | null> {
  try {
    const resp = await fetch('/api/auth/ws-token', {
      method: 'POST',
      credentials: 'include',
    })
    if (resp.status === 401) {
      // Session expired — stop reconnecting
      shouldReconnect = false
      return null
    }
    if (!resp.ok) return null
    const { token } = await resp.json()
    return token as string
  } catch {
    return null
  }
}

function handleMessage(event: MessageEvent): void {
  try {
    const parsed = JSON.parse(event.data)
    if (parsed.type === 'welcome') {
      mySocketId = parsed.socketId
      return
    }
    listeners.forEach(fn => {
      try { fn(parsed) } catch (err: unknown) { console.error('WebSocket listener error:', err) }
    })
  } catch (err: unknown) {
    console.error('WebSocket message parse error:', err)
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (shouldReconnect) {
      connectInternal(true)
    }
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

async function connectInternal(_isReconnect = false): Promise<void> {
  console.log('[WebSocket] connectInternal called, isReconnect =', _isReconnect, 'connecting =', connecting)
  if (connecting) {
    console.log('[WebSocket] Already connecting, returning')
    return
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log('[WebSocket] Socket already open or connecting, returning')
    return
  }

  connecting = true
  console.log('[WebSocket] Fetching WS token...')
  const wsToken = await fetchWsToken()
  connecting = false

  if (!wsToken) {
    console.warn('[WebSocket] Failed to get WS token')
    if (shouldReconnect) scheduleReconnect()
    return
  }

  const url = getWsUrl(wsToken)
  console.log('[WebSocket] Creating WebSocket connection to', url)
  socket = new WebSocket(url)

  socket.onopen = async () => {
    console.log('[WebSocket] Connection opened, replaying offline queue...')
    reconnectDelay = 1000

    // Replay queued mutations first
    try {
      const pending = await getAllMutations()
      console.log('[WebSocket] Found', pending.length, 'pending mutations')
      if (pending.length > 0) {
        console.log(`[WebSocket] Starting replay of ${pending.length} queued mutations...`)
        const result = await replayQueue()
        console.log('[WebSocket] Queue replay complete:', result)
        if (onQueueReplayedCallback) {
          console.log('[WebSocket] Calling onQueueReplayedCallback with result:', result)
          onQueueReplayedCallback(result)
        }
      } else {
        console.log('[WebSocket] No pending mutations to replay')
      }
    } catch (err) {
      console.error('[WebSocket] Failed to replay queue:', err)
    }

    if (activeTrips.size > 0) {
      console.log('[WebSocket] Re-joining', activeTrips.size, 'active trips')
      activeTrips.forEach(tripId => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'join', tripId }))
        }
      })
      if (refetchCallback) {
        console.log('[WebSocket] Refetching trip data for', activeTrips.size, 'trips')
        activeTrips.forEach(tripId => {
          try { refetchCallback!(tripId) } catch (err: unknown) {
            console.error('Failed to refetch trip data on reconnect:', err)
          }
        })
      }
    }
  }

  socket.onmessage = handleMessage

  socket.onclose = () => {
    console.log('[WebSocket] Connection closed')
    socket = null
    if (shouldReconnect) {
      console.log('[WebSocket] Scheduling reconnect with delay:', reconnectDelay)
      scheduleReconnect()
    }
  }

  socket.onerror = (event) => {
    console.error('[WebSocket] Socket error:', event)
    // onclose will fire after onerror, reconnect handled there
  }
}

export function connect(): void {
  console.log('[WebSocket] Initiating connection')
  shouldReconnect = true
  reconnectDelay = 1000
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  // Attach online/offline event listeners once
  if (!onlineListenersAttached) {
    onlineListenersAttached = true
    window.addEventListener('online', () => {
      console.log('[WebSocket] Online event detected, attempting reconnect')
      // Close stale socket if it exists
      if (socket) {
        console.log('[WebSocket] Closing stale socket before reconnect')
        socket.onclose = null  // Prevent reconnect scheduling
        socket.close()
        socket = null
      }
      reconnectDelay = 1000
      connectInternal(false)
    })
    window.addEventListener('offline', () => {
      console.log('[WebSocket] Offline event detected, closing WebSocket')
      // Force close socket when going offline — it won't close naturally when network is down
      if (socket) {
        socket.onclose = null  // Prevent reconnect scheduling
        socket.close()
        socket = null
      }
    })
  }

  connectInternal(false)
}

export function disconnect(): void {
  shouldReconnect = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  activeTrips.clear()
  if (socket) {
    socket.onclose = null
    socket.close()
    socket = null
  }
}

export function joinTrip(tripId: number | string): void {
  activeTrips.add(String(tripId))
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'join', tripId: String(tripId) }))
  }
}

export function leaveTrip(tripId: number | string): void {
  activeTrips.delete(String(tripId))
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'leave', tripId: String(tripId) }))
  }
}

export function addListener(fn: WebSocketListener): void {
  listeners.add(fn)
}

export function removeListener(fn: WebSocketListener): void {
  listeners.delete(fn)
}
