/**
 * API Configuration
 *
 * Server-side: Reads BACKEND_URL (the backend's api role: every HTTP call) and
 * BACKEND_CHAT_URL (its chat role: the WebSocket only) at runtime (no rebuild needed)
 * Client-side: Uses same-origin URLs (proxied through UI server)
 */

interface ApiConfig {
  baseUrl: string
  healthUrl: string
  timeout: number
  documentsBaseUrl: string
  collectionsUrl: string
}

const isServer = typeof window === 'undefined'

const getBaseUrl = (): string => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

/**
 * Get WebSocket URL.
 * - Server-side: Returns the chat role's WebSocket URL directly. The chat socket
 *   is the one thing BACKEND_URL (the api role) does not serve, so there is no
 *   fallback to it.
 * - Client-side: Returns same-origin URL (proxied through UI server)
 */
export const getWebSocketUrl = async (): Promise<string> => {
  if (isServer) {
    const chatUrl = (process.env.BACKEND_CHAT_URL ?? '').trim().replace(/\/$/, '')
    if (!chatUrl) throw new Error('BACKEND_CHAT_URL is required to open the chat socket from the server')
    return `${chatUrl.replace(/^http/, 'ws')}/websocket`
  }

  // Browser: connect to same origin, UI server proxies to backend
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/websocket`
}

export const apiConfig: ApiConfig = {
  baseUrl: getBaseUrl(),
  healthUrl: `${getBaseUrl()}/health`,
  timeout: 30000,
  documentsBaseUrl: `${getBaseUrl()}/v1`,
  collectionsUrl: `${getBaseUrl()}/v1/collections`,
}

export const checkBackendHealth = async (): Promise<boolean> => {
  try {
    // Client-side: use same-origin proxy route (backend may not be publicly exposed)
    // Server-side: hit backend directly
    const url = isServer ? apiConfig.healthUrl : '/api/health'
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}
