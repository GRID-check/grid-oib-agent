/**
 * Gateway Server with WebSocket Proxy
 *
 * Architecture (following Nemo-Agent-Toolkit-UI pattern):
 * - Runs on port 3000 as the main entry point
 * - Proxies to Next.js server (dev on 3001, or production on same process)
 * - Proxies /websocket to backend WebSocket endpoint
 *
 * Development:
 *   npm run dev - Runs gateway + Next.js dev server concurrently
 *
 * Production:
 *   npm start - Runs Next.js in production mode with integrated proxy
 *
 * Environment:
 *   BACKEND_URL - Backend service URL (e.g., http://backend:8000)
 *   PORT - Gateway port (default: 3000)
 *   NEXT_INTERNAL_URL - Next.js server URL (default: http://localhost:3001)
 */

const http = require('http')
const httpProxy = require('http-proxy')
const { parse } = require('url')

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '3000', 10)

const getBackendUrl = () => {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

const getBackendWsUrl = () => {
  const baseUrl = getBackendUrl()
  return baseUrl.replace(/^http/, 'ws')
}

const BACKEND_HTTP_URL = getBackendUrl()
const BACKEND_WS_URL = getBackendWsUrl()
const NEXT_INTERNAL_URL = process.env.NEXT_INTERNAL_URL || 'http://localhost:3001'

// In production, we run Next.js in the same process
let nextApp = null
let nextHandle = null

if (!dev) {
  const next = require('next')
  nextApp = next({ dev: false, hostname, port: 3001 })
  nextHandle = nextApp.getRequestHandler()
}

// Create proxy for Next.js (used in dev mode)
const nextProxy = httpProxy.createProxyServer({
  target: NEXT_INTERNAL_URL,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  preserveHeaderKeyCase: true,
})

// Create proxy for backend
const backendProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  xfwd: true,
  preserveHeaderKeyCase: true,
})

// Error handling for Next.js proxy
nextProxy.on('error', (err, req, res) => {
  console.error('[Next.js Proxy Error]:', err.message)
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
  }
  if (res && !res.writableEnded) {
    res.end(JSON.stringify({ error: 'Next.js server unavailable' }))
  }
})

// Error handling for backend proxy
backendProxy.on('error', (err, req, res) => {
  console.error('[Backend Proxy Error]:', err.message)
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
  }
  if (res && !res.writableEnded) {
    res.end(JSON.stringify({ error: 'Backend unavailable' }))
  }
})

// WebSocket keep-alive for backend
backendProxy.on('open', (proxySocket) => {
  try {
    proxySocket.setKeepAlive?.(true, 15000)
    proxySocket.on('error', (e) =>
      console.error('[WebSocket] upstream socket error:', e.message)
    )
  } catch {}
})

// Forward cookies for backend WebSocket
backendProxy.on('proxyReqWs', (proxyReq, req) => {
  if (req.headers.cookie) {
    proxyReq.setHeader('Cookie', req.headers.cookie)
  }
})

const normalizeQueryParam = (value) => {
  if (Array.isArray(value)) return value[0]
  return value || undefined
}

const fetchCollectionScopeHeader = (req, projectId, conversationId) => {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams()
    if (projectId) query.set('projectId', projectId)
    if (conversationId) query.set('conversationId', conversationId)

    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/auth/websocket-scope?${query.toString()}`,
        method: 'GET',
        headers: {
          ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data)
              resolve({ ok: true, status: res.statusCode, header: json.header, data: json })
            } catch (err) {
              console.warn('[WS Proxy] Failed to parse collection scope response:', err.message)
              resolve({ ok: false, status: res.statusCode, header: null, data: null })
            }
          } else {
            resolve({ ok: false, status: res.statusCode, header: null, data: null })
          }
        })
      }
    )

    request.setTimeout(5000, () => {
      request.destroy()
      reject(new Error('Collection scope request timed out'))
    })

    request.on('error', (err) => {
      console.warn('[WS Proxy] Collection scope request failed:', err.message)
      resolve({ ok: false, status: null, header: null, data: null })
    })

    request.end()
  })
}

const startServer = async () => {
  // In production, prepare Next.js
  if (!dev && nextApp) {
    await nextApp.prepare()
  }

  const server = http.createServer(async (req, res) => {
    req.socket.setKeepAlive?.(true, 15000)
    req.socket.setTimeout?.(0)

    let parsedUrl
    try {
      parsedUrl = parse(req.url, true)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad Request')
      return
    }

    if (dev) {
      // Development: proxy everything to Next.js dev server
      nextProxy.web(req, res, { target: NEXT_INTERNAL_URL })
    } else {
      // Production: handle with Next.js directly
      try {
        await nextHandle(req, res, parsedUrl)
      } catch (err) {
        console.error('Error handling request:', err)
        res.statusCode = 500
        res.end('Internal Server Error')
      }
    }
  })

  // WebSocket upgrade handler
  server.on('upgrade', async (req, socket, head) => {
    socket.setKeepAlive?.(true, 15000)
    socket.setTimeout?.(0)

    let parsedUrl
    try {
      parsedUrl = parse(req.url, true)
    } catch {
      socket.destroy()
      return
    }
    const pathname = parsedUrl.pathname || '/'

    // Proxy /websocket to backend
    if (pathname === '/websocket' || pathname.startsWith('/websocket')) {
      const projectId = normalizeQueryParam(parsedUrl.query.projectId)
      const conversationId = normalizeQueryParam(parsedUrl.query.conversationId)
      req.url = '/websocket' + (parsedUrl.search || '')

      try {
        const result = await fetchCollectionScopeHeader(req, projectId, conversationId)
        if (result.ok && result.header) {
          req.headers['x-grid-collection-scope'] = result.header

          // Forward user context so the Python backend knows who the caller is
          if (result.data?.organizationId) {
            req.headers['x-grid-organization-id'] = result.data.organizationId
            req.headers['x-grid-user-id'] = result.data.userId
          }
          if (result.data?.accessToken) {
            req.headers['authorization'] = `Bearer ${result.data.accessToken}`
          }
          if (result.data?.projectContext) {
            req.headers['x-grid-project-context'] = result.data.projectContext
          }
          // Project id + core memory digest for the agent. The id lets backend
          // tools (e.g. `remember`) write project-scoped rows; the digest is
          // merged into the injected agent context alongside project context.
          if (result.data?.projectId) {
            req.headers['x-grid-project-id'] = result.data.projectId
          }
          if (result.data?.projectMemory) {
            req.headers['x-grid-project-memory'] = result.data.projectMemory
          }
        } else if (result.status === 401 || result.status === 403) {
          const statusText = result.status === 401 ? 'Unauthorized' : 'Forbidden'
          try {
            socket.write(`HTTP/1.1 ${result.status} ${statusText}\r\n\r\n`)
          } catch {}
          socket.destroy()
          return
        }
      } catch (err) {
        console.warn('[WS Proxy] Collection scope lookup failed:', err.message)
        try {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
        } catch {}
        socket.destroy()
        return
      }

      backendProxy.ws(
        req,
        socket,
        head,
        { target: BACKEND_WS_URL, changeOrigin: true },
        (err) => {
          if (err) {
            console.error('[WS Proxy] Error:', err.message)
            try {
              socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
            } catch {}
            socket.destroy()
          }
        }
      )
      return
    }

    // All other WebSocket connections (HMR, etc.)
    if (dev) {
      // Development: proxy to Next.js dev server
      nextProxy.ws(req, socket, head, { target: NEXT_INTERNAL_URL }, (err) => {
        if (err) {
          console.error('[Next.js WS] Proxy error:', err.message)
          socket.destroy()
        }
      })
    } else {
      // Production: let Next.js handle it
      const upgradeHandler = nextApp.getUpgradeHandler()
      upgradeHandler(req, socket, head)
    }
  })

  // Server configuration for long-running connections
  server.keepAliveTimeout = 0
  server.headersTimeout = 65000
  server.requestTimeout = 0

  server.listen(port, hostname, () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Frontend: http://localhost:${port}
  Backend:  ${BACKEND_HTTP_URL}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
  })

  // Graceful shutdown
  const cleanExit = (signal) => {
    console.log(`\nShutting down (${signal})...`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000)
  }

  process.once('SIGTERM', () => cleanExit('SIGTERM'))
  process.once('SIGINT', () => cleanExit('SIGINT'))
}

startServer().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
