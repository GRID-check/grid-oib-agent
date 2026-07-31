/**
 * Gateway WS-upgrade admission + scope memoisation.
 *
 * `server.js` had no test harness in this repo (see the note at the top of that
 * file). It is plain CommonJS with no exports, so it is covered the only way it
 * can be: spawn the real process, point it at a fake upstream that counts
 * `/api/auth/websocket-scope` resolutions, and drive real upgrade requests
 * through it.
 *
 * What this pins: a fleet-wide reconnect (rolling deploy, node drain) must not
 * amplify one-to-one into session resolution + FGA + budget reads — ADR-0020.
 * The per-IP rate limiter does not cover that case, because the herd arrives
 * from thousands of distinct IPs.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const UI_ROOT = path.resolve(__dirname, '../..')

let upstream: http.Server
let upstreamPort = 0
let scopeHits = 0
let slowScope = false
const running: ChildProcess[] = []
const openSockets = new Set<import('node:stream').Duplex>()

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/auth/websocket-scope')) {
      scopeHits += 1
      const reply = () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            header: 'c2NvcGU',
            organizationId: 'org_1',
            userId: 'user_1',
            scope: ['col_a'],
          })
        )
      }
      if (slowScope) setTimeout(reply, 400)
      else reply()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  upstream.on('connection', (sock) => {
    openSockets.add(sock)
    sock.on('close', () => openSockets.delete(sock))
  })
  upstream.on('upgrade', (_req, sock) => {
    openSockets.add(sock)
    sock.on('close', () => openSockets.delete(sock))
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, resolve))
  upstreamPort = (upstream.address() as { port: number }).port
})

afterAll(async () => {
  // The gateway holds keep-alive and upgraded sockets to the upstream;
  // `close()` alone waits for them and would hang the hook.
  for (const sock of openSockets) sock.destroy()
  openSockets.clear()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

afterEach(() => {
  while (running.length) running.pop()?.kill('SIGKILL')
  slowScope = false
})

/** Let the OS pick a free port, then hand it to the gateway. */
async function reservePort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** Boot a real gateway on a free port; resolves once it is listening. */
async function startGateway(env: Record<string, string> = {}): Promise<number> {
  const port = await reservePort()
  const child = spawn('node', ['server.js'], {
    cwd: UI_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      NEXT_INTERNAL_URL: `http://127.0.0.1:${upstreamPort}`,
      BACKEND_URL: `http://127.0.0.1:${upstreamPort}`,
      // Isolate the behaviour under test from the per-IP limiter: every request
      // here comes from 127.0.0.1, which is exactly the case it does cover.
      GRID_WS_UPGRADE_RATE_LIMIT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.push(child)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway did not start')), 20_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Frontend:')) {
        clearTimeout(timer)
        setTimeout(resolve, 200)
      }
    })
  })
  return port
}

/** Drive one WS upgrade; resolves with the HTTP status (101 on success). */
function upgrade(port: number, cookie: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({
      port,
      path: '/websocket?conversationId=conv-1',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        Cookie: cookie,
      },
    })
    req.on('upgrade', (res, sock) => {
      sock.destroy()
      resolve(res.statusCode ?? 101)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', () => resolve(0))
    req.end()
  })
}

describe('gateway WS-upgrade scope memoisation', () => {
  it('collapses repeat upgrades for one session onto a single resolution', async () => {
    const port = await startGateway()
    scopeHits = 0

    for (let i = 0; i < 5; i += 1) await upgrade(port, 'session=alpha')

    expect(scopeHits).toBe(1)
  })

  it('keys the memo per session, not globally', async () => {
    const port = await startGateway()
    scopeHits = 0

    await upgrade(port, 'session=alpha')
    await upgrade(port, 'session=beta')

    expect(scopeHits).toBe(2)
  })

  it('pays per upgrade when the memo is disabled', async () => {
    const port = await startGateway({ GRID_WS_SCOPE_CACHE_TTL_MS: '0' })
    scopeHits = 0

    for (let i = 0; i < 5; i += 1) await upgrade(port, 'session=alpha')

    expect(scopeHits).toBe(5)
  })

  it('coalesces concurrent upgrades for one session (single-flight)', async () => {
    const port = await startGateway()
    slowScope = true
    scopeHits = 0

    await Promise.all(Array.from({ length: 10 }, () => upgrade(port, 'session=gamma')))

    expect(scopeHits).toBe(1)
  })
})

describe('gateway WS-upgrade admission gate', () => {
  it('sheds past the in-flight ceiling instead of queueing', async () => {
    const port = await startGateway({ GRID_WS_UPGRADE_MAX_INFLIGHT: '2' })
    slowScope = true
    scopeHits = 0

    const codes = await Promise.all(
      Array.from({ length: 12 }, (_, i) => upgrade(port, `session=load-${i}`))
    )

    // The ceiling bounds what reaches the BFF; everything else is shed fast so
    // the pod keeps serving the sockets it already holds.
    expect(scopeHits).toBe(2)
    expect(codes.filter((c) => c === 503)).toHaveLength(10)
    expect(codes.filter((c) => c === 101)).toHaveLength(2)
  })
})
