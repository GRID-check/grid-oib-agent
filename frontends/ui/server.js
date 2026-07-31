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
const crypto = require('crypto')

// ── Signed context envelope (backlog T3-9 follow-up, 2026-07-16, user-mandated) ──
// One consolidated, signed `X-Grid-Request-Context` header (+ integrity
// signature `X-Grid-Request-Context-Sig`) carrying every x-grid-* field this
// file already forwards individually below. Minted in ONE canonical place on
// the TS side: `buildGridRequestContextEnvelope` /
// `buildGridRequestContextEnvelopePayload` in
// `frontends/ui/src/lib/request-context.ts`. server.js is plain CommonJS
// (see the `require(...)` calls above — no ESM/TS imports anywhere in this
// file) and cannot import that module, so the payload shape + signing logic
// is DUPLICATED here. If the TS builder's field list, omission rules, or key
// order ever change, this function must change identically — the
// cross-language contract fixture (`tests/fixtures/grid_request_context.json`
// `envelopeCases`) pins both sides' *output* so drift fails a test instead of
// degrading silently in prod, but it cannot catch drift in this file's
// *source* automatically since server.js has no test harness in this repo.
// DUAL-WRITE: called alongside (not instead of) the individual x-grid-*
// header assignments below — this is the transition-safety design agreed
// with the user; removing the individual headers is a later cleanup.
function buildGridRequestContextEnvelopeHeaders(input) {
  const payload = {}
  if (input.organizationId) payload.organizationId = input.organizationId
  if (input.userId) payload.userId = input.userId
  if (input.projectId) payload.projectId = input.projectId
  if (input.collectionScope && input.collectionScope.length > 0) payload.collectionScope = input.collectionScope
  if (input.projectContext) payload.projectContext = input.projectContext
  if (input.projectMemory) payload.projectMemory = input.projectMemory
  if (input.modelOverrides && Object.keys(input.modelOverrides).length > 0) {
    payload.modelOverrides = input.modelOverrides
  }
  if (input.budget) payload.budget = input.budget
  if (input.disabledSources && input.disabledSources.length > 0) payload.disabledSources = input.disabledSources
  if (input.memoryReflectionEnabled !== undefined) payload.memoryReflectionEnabled = input.memoryReflectionEnabled
  // `bundesland` (backlog T3-9 follow-up, 2026-07-16, user-mandated):
  // envelope-only structured jurisdiction field, appended LAST in key order
  // to keep every pre-existing signed payload byte-identical — see
  // `buildGridRequestContextEnvelopePayload`'s docstring in request-context.ts
  // (the canonical definition this function is pinned to).
  if (input.bundesland) payload.bundesland = input.bundesland

  const json = JSON.stringify(payload)
  const headers = {
    'x-grid-request-context': Buffer.from(json, 'utf8').toString('base64url'),
  }
  // Fail-open note (dev): when GRID_INTERNAL_API_TOKEN is unset, the envelope
  // is still minted and forwarded (unsigned) — the backend's enforcement
  // middleware mirrors this: signature verification is skipped when it also
  // has no token configured, but envelope PRESENCE is still required for
  // authenticated requests either way.
  const secret = process.env.GRID_INTERNAL_API_TOKEN
  if (secret) {
    headers['x-grid-request-context-sig'] = crypto.createHmac('sha256', secret).update(json, 'utf8').digest('hex')
  }
  return headers
}

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

// ── Conversation affinity (horizontal aiq-agent scaling) ──
// The backend keeps per-conversation WebSocket delivery, human-in-the-loop
// futures, and the running LangGraph task IN PROCESS, so a given conversation
// must always reach the SAME backend replica for reconnect + HITL to work. When
// aiq-agent runs >1 replica (a StatefulSet), pin each conversation to a specific
// pod via a stable hash of conversationId -> that pod's stable DNS name. Falls
// back to the load-balanced Service when there's 1 replica, no pod template, or
// no conversationId — so single-replica behavior is unchanged.
const BACKEND_REPLICAS = Math.max(1, parseInt(process.env.BACKEND_REPLICAS || '1', 10) || 1)
// Per-pod WS DNS template with a literal `{i}`, e.g.
// an in-cluster headless-service pod address like
// aiq-agent-{i}.aiq-agent-headless:8000 (ws, in-cluster only) supplied via env.
// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
const BACKEND_POD_WS_TEMPLATE = process.env.BACKEND_POD_WS_TEMPLATE || ''

// How many frontend replicas this deployment runs (Pulumi passes the min count).
// Used only to loudly flag a multi-replica deploy that is missing the shared
// cache (REDIS_URL) — where the read-through caches and the WS rate limiter
// would silently diverge per pod. Defaults to 1 (single-node / dev).
const FRONTEND_REPLICAS = Math.max(1, parseInt(process.env.FRONTEND_REPLICAS || '1', 10) || 1)

// ── Graceful shutdown / rolling-update drain ──
// How long this process keeps serving after SIGTERM before forcing exit. Chat
// WebSockets are long-lived (a streaming answer can run for minutes), so the
// 2s local default would drop every in-flight response on every rollout. In
// Kubernetes the deployment sets this to the tier's drain budget and sizes
// terminationGracePeriodSeconds above it (deploy/pulumi/src/platform/rollout.ts).
const SHUTDOWN_DRAIN_MS = Math.max(
  0,
  parseInt(process.env.GRID_SHUTDOWN_DRAIN_MS || '', 10) || 2000
)
// Set once SIGTERM/SIGINT arrives: readiness starts failing and new WebSocket
// upgrades are refused, while everything already in flight runs to completion.
let draining = false

// FNV-1a: stable, dependency-free, well-distributed for short ids.
function hashToIndex(str, mod) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % mod
}

function pickBackendWsTarget(conversationId) {
  if (BACKEND_REPLICAS <= 1 || !BACKEND_POD_WS_TEMPLATE || !conversationId) {
    return BACKEND_WS_URL
  }
  return BACKEND_POD_WS_TEMPLATE.replace('{i}', String(hashToIndex(String(conversationId), BACKEND_REPLICAS)))
}

// ── WS-upgrade rate limiter (ADR-0020) ──
// Every upgrade triggers session resolution, FGA checks, and budget reads in
// the BFF, so a reconnect storm amplifies straight into WorkOS and Postgres.
// Fixed window per client IP; counters live in the shared cache (Dragonfly)
// so the limit holds across replicas, with a per-process fallback. Fails
// open — a cache outage must never take chat down. 0 disables.
const WS_RATE_LIMIT = parseInt(process.env.GRID_WS_UPGRADE_RATE_LIMIT || '30', 10)
const WS_RATE_WINDOW_SECONDS = 60

let rateLimitRedis = null
if (process.env.REDIS_URL && WS_RATE_LIMIT > 0) {
  try {
    const IORedis = require('ioredis')
    rateLimitRedis = new IORedis(process.env.REDIS_URL, {
      connectTimeout: 1000,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    rateLimitRedis.on('error', (error) => {
      console.warn('[Gateway] rate-limit cache error:', error.message)
    })
  } catch (error) {
    console.warn('[Gateway] shared rate limiter unavailable, using per-process fallback:', error.message)
  }
}

const localRateWindows = new Map()

const getClientKey = (req) => {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

async function wsUpgradeAllowed(clientKey) {
  if (WS_RATE_LIMIT <= 0) return true
  const windowId = Math.floor(Date.now() / (WS_RATE_WINDOW_SECONDS * 1000))
  const key = `ratelimit:ws:${clientKey}:${windowId}`
  if (rateLimitRedis) {
    try {
      const results = await rateLimitRedis
        .multi()
        .incr(key)
        .expire(key, WS_RATE_WINDOW_SECONDS, 'NX')
        .exec()
      const count = Number(results?.[0]?.[1] ?? 0)
      return count <= WS_RATE_LIMIT
    } catch {
      return true // fail open
    }
  }
  // Per-process fallback (only sees this process's traffic).
  if (localRateWindows.size > 10000) localRateWindows.clear()
  const entry = localRateWindows.get(clientKey)
  if (!entry || entry.windowId !== windowId) {
    localRateWindows.set(clientKey, { windowId, count: 1 })
    return true
  }
  entry.count += 1
  return entry.count <= WS_RATE_LIMIT
}

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

// ── WS-upgrade admission + scope memoisation ──
// The per-IP limiter above throttles ONE abusive client. It does nothing about
// the herd this deployment creates for itself: a rolling update severs every
// socket on a pod at once, and those clients come back from thousands of
// DISTINCT IPs, so every one of them passes the per-IP check and triggers a
// fresh `/api/auth/websocket-scope` render (session resolution + FGA + budget
// reads — ADR-0020). Two bounds on that amplification:
//
//   1. SINGLE-FLIGHT + short-TTL memo per (session, project, conversation).
//      A client that reconnects within the TTL, or several tabs racing the same
//      upgrade, cost one upstream resolution instead of N.
//   2. A GLOBAL in-flight ceiling. Past it, upgrades are shed with 503 +
//      Retry-After instead of queueing — the pod stays responsive for the
//      connections it already holds, and the client's jittered backoff
//      (`shared/utils/backoff.ts`) spreads the retry.
//
// The memo is per-process and in-memory ON PURPOSE: the payload carries an
// access token, and a shared Dragonfly cache would put bearer credentials in a
// store shared by every tier. Per-pod caching still cuts the amplification
// proportionally, because a given client reconnects to one pod at a time.
// TTL is deliberately short — it bounds how long a revoked session can still
// ride a cached scope. 0 disables the memo entirely.
const WS_UPGRADE_MAX_INFLIGHT = parseInt(process.env.GRID_WS_UPGRADE_MAX_INFLIGHT || '32', 10)
const WS_SCOPE_CACHE_TTL_MS = parseInt(process.env.GRID_WS_SCOPE_CACHE_TTL_MS || '10000', 10)
const WS_SCOPE_CACHE_MAX_ENTRIES = 5000

let inflightScopeResolutions = 0
const scopeCache = new Map()
const scopeInflight = new Map()

const scopeCacheKey = (req, projectId, conversationId) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify([req.headers.cookie || '', projectId ?? null, conversationId ?? null])
    )
    .digest('hex')

/**
 * Resolve the collection scope for an upgrade, memoised and admission-gated.
 *
 * Returns the same shape as `fetchCollectionScopeHeader`, plus `rejected: true`
 * when the global in-flight ceiling shed this upgrade.
 */
const resolveCollectionScope = (req, projectId, conversationId) => {
  // The memo and the admission ceiling are INDEPENDENT bounds: disabling the
  // memo (TTL <= 0, e.g. to force fresh auth) must not also disable the ceiling.
  const cacheEnabled = WS_SCOPE_CACHE_TTL_MS > 0
  const key = cacheEnabled ? scopeCacheKey(req, projectId, conversationId) : null

  if (cacheEnabled) {
    const cached = scopeCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.result)
    }

    // Coalesce concurrent upgrades for the same session onto one upstream call.
    const pending = scopeInflight.get(key)
    if (pending) return pending
  }

  if (WS_UPGRADE_MAX_INFLIGHT > 0 && inflightScopeResolutions >= WS_UPGRADE_MAX_INFLIGHT) {
    return Promise.resolve({ ok: false, status: 503, header: null, data: null, rejected: true })
  }

  inflightScopeResolutions += 1
  const request = fetchCollectionScopeHeader(req, projectId, conversationId)
    .then((result) => {
      // Only successes are memoised — a transient failure must not be sticky.
      if (cacheEnabled && result.ok) {
        if (scopeCache.size > WS_SCOPE_CACHE_MAX_ENTRIES) scopeCache.clear()
        scopeCache.set(key, { expiresAt: Date.now() + WS_SCOPE_CACHE_TTL_MS, result })
      }
      return result
    })
    .finally(() => {
      inflightScopeResolutions -= 1
      if (cacheEnabled) scopeInflight.delete(key)
    })

  if (cacheEnabled) scopeInflight.set(key, request)
  return request
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

    // Draining: fail readiness immediately so the kubelet marks this pod
    // NotReady and the gateway stops sending it new traffic, while requests and
    // WebSockets already in flight keep running to completion. Liveness uses the
    // same path, but a NotReady pod that is already terminating is never
    // restarted for it.
    if (draining && parsedUrl.pathname === '/api/healthz') {
      res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ status: 'draining' }))
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

    // Refuse NEW sessions while draining — a pod that is going away must not
    // accept a WebSocket it cannot see through. The client reconnects and the
    // gateway routes it to a replica that is staying.
    if (draining) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // Proxy /websocket to backend
    if (pathname === '/websocket' || pathname.startsWith('/websocket')) {
      if (!(await wsUpgradeAllowed(getClientKey(req)))) {
        socket.write(
          'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\n\r\n'
        )
        socket.destroy()
        return
      }

      const projectId = normalizeQueryParam(parsedUrl.query.projectId)
      const conversationId = normalizeQueryParam(parsedUrl.query.conversationId)
      req.url = '/websocket' + (parsedUrl.search || '')

      try {
        const result = await resolveCollectionScope(req, projectId, conversationId)
        if (result.rejected) {
          // Shed rather than queue: the pod protects the connections it already
          // holds, and the client retries on a jittered backoff.
          try {
            socket.write(
              'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n'
            )
          } catch {}
          socket.destroy()
          return
        }
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
          // CRITICAL: projectContext and projectMemory are MULTI-LINE text.
          // Node rejects '\n' in header values (ERR_INVALID_CHAR) and the
          // throw would kill the upgrade (and, uncaught, the process). They
          // are therefore base64url-encoded here and decoded by the Python
          // backend (project_context.py) — same scheme as the collection
          // scope header.
          if (result.data?.projectContext) {
            req.headers['x-grid-project-context'] = Buffer.from(
              result.data.projectContext,
              'utf8'
            ).toString('base64url')
          }
          // Project id + core memory digest for the agent. The id lets backend
          // tools (e.g. `remember`) write project-scoped rows; the digest is
          // merged into the injected agent context alongside project context.
          if (result.data?.projectId) {
            req.headers['x-grid-project-id'] = result.data.projectId
          }
          if (result.data?.projectMemory) {
            req.headers['x-grid-project-memory'] = Buffer.from(
              result.data.projectMemory,
              'utf8'
            ).toString('base64url')
          }
          // Feature flag: whether the async memory-reflection stage is enabled
          // for this caller (WorkOS flag per-org, or the env fallback). Always
          // forwarded so the backend fails closed when the header is absent.
          req.headers['x-grid-feature-memory-reflection'] = result.data?.memoryReflectionEnabled
            ? 'true'
            : 'false'
          // Per-org runtime model overrides ({agentGroup: openrouterModelId},
          // from the org's active model-config version) and the remaining LLM
          // budget snapshot. Both are JSON → base64url-encoded like the other
          // structured headers; decoded in aiq_agent (model_overrides.py /
          // cost_tracking.py). Absent header = workflow defaults / no cap.
          if (result.data?.modelOverrides) {
            req.headers['x-grid-model-overrides'] = Buffer.from(
              JSON.stringify(result.data.modelOverrides),
              'utf8'
            ).toString('base64url')
          }
          if (result.data?.budget) {
            req.headers['x-grid-budget'] = Buffer.from(
              JSON.stringify(result.data.budget),
              'utf8'
            ).toString('base64url')
          }
          // Org-disabled data sources (e.g. web_search when the org toggle is
          // off, ADR-0022). Decoded in aiq_agent (data_sources.py) and
          // subtracted from every tool selection. Absent header = nothing
          // disabled.
          if (Array.isArray(result.data?.disabledSources) && result.data.disabledSources.length > 0) {
            req.headers['x-grid-disabled-sources'] = Buffer.from(
              JSON.stringify(result.data.disabledSources),
              'utf8'
            ).toString('base64url')
          }
          // Consolidated, signed context envelope (backlog T3-9 follow-up,
          // 2026-07-16, user-mandated) — DUAL-WRITE alongside every
          // individual x-grid-* header set above, built from the SAME
          // `result.data` values. See buildGridRequestContextEnvelopeHeaders'
          // own comment (top of file) for why this is duplicated rather than
          // imported from request-context.ts.
          Object.assign(
            req.headers,
            buildGridRequestContextEnvelopeHeaders({
              organizationId: result.data?.organizationId,
              userId: result.data?.userId,
              projectId: result.data?.projectId,
              collectionScope: result.data?.scope,
              projectContext: result.data?.projectContext,
              projectMemory: result.data?.projectMemory,
              modelOverrides: result.data?.modelOverrides,
              budget: result.data?.budget,
              disabledSources: result.data?.disabledSources,
              memoryReflectionEnabled: result.data?.memoryReflectionEnabled,
              bundesland: result.data?.bundesland,
            })
          )
        } else if (result.status === 401 || result.status === 403) {
          const statusText = result.status === 401 ? 'Unauthorized' : 'Forbidden'
          try {
            socket.write(`HTTP/1.1 ${result.status} ${statusText}\r\n\r\n`)
          } catch {}
          socket.destroy()
          return
        } else {
          // Fail CLOSED: any other scope-resolution failure (5xx, network
          // error, malformed response) must not proxy the socket to the
          // backend stripped of its collection-scope/auth/org headers.
          console.warn(
            '[WS Proxy] Collection scope unavailable (status: %s), rejecting upgrade',
            result.status
          )
          try {
            socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
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

      // Guard the proxy call itself: http-proxy can throw SYNCHRONOUSLY from
      // ws() (e.g. an invalid header value) and an uncaught throw in the
      // 'upgrade' listener crashes the whole gateway process.
      try {
        backendProxy.ws(
          req,
          socket,
          head,
          // Conversation affinity: pin this conversation to its owning backend
          // replica so in-process WS/HITL/task state is always reachable.
          { target: pickBackendWsTarget(conversationId), changeOrigin: true },
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
      } catch (err) {
        console.error('[WS Proxy] Upgrade failed synchronously:', err.message)
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        } catch {}
        socket.destroy()
      }
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

  // Multi-replica without a shared cache is a misconfiguration: the read-through
  // caches (ADR-0019) and the WS-upgrade rate limiter fall back to per-process
  // state, so they diverge across pods (e.g. the rate limit becomes N×). Fail
  // open (don't crash — matches the cache/limiter philosophy) but warn loudly so
  // it's caught. Single replica / dev with no REDIS_URL is fine and stays quiet.
  if (FRONTEND_REPLICAS > 1 && !process.env.REDIS_URL) {
    console.error(
      `[Gateway] WARNING: FRONTEND_REPLICAS=${FRONTEND_REPLICAS} but REDIS_URL is unset — ` +
        'the shared cache and WS rate limiter will run per-process and diverge across replicas. ' +
        'Set REDIS_URL (Dragonfly) for correct multi-replica behavior.',
    )
  }

  server.listen(port, hostname, () => {
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Frontend: http://localhost:${port}
  Backend:  ${BACKEND_HTTP_URL}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
  })

  // Graceful shutdown. `server.close()` stops accepting new connections and
  // resolves once every existing one (including WebSockets) has ended, so the
  // timer is the hard ceiling on how long a rolling update waits for this pod.
  const cleanExit = (signal) => {
    if (draining) return
    draining = true
    console.log(`\nShutting down (${signal}) — draining for up to ${SHUTDOWN_DRAIN_MS}ms...`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), SHUTDOWN_DRAIN_MS)
  }

  process.once('SIGTERM', () => cleanExit('SIGTERM'))
  process.once('SIGINT', () => cleanExit('SIGINT'))
}

startServer().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
