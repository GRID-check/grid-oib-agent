/**
 * Gateway WebSocket FRAME limiting (ADR-0040 layer L2b).
 *
 * `server.js` has no unit-test seam — it is plain CommonJS with no exports — so
 * this is covered the same way `ws-upgrade-admission.test.ts` covers admission:
 * spawn the real process against a fake upstream, complete a real upgrade, and
 * push real WebSocket frames down the socket.
 *
 * What this pins is the blind spot the whole layer exists for: to the edge, a
 * chat session is ONE HTTP request (the upgrade) and every turn afterwards is
 * invisible. If the observer in `server.js` ever loses frame sync, or is never
 * attached, the limiter silently stops counting and nothing else in the system
 * notices. These tests fail when that happens.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import http from 'node:http'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAT_TURN_LIMIT } from '@/lib/limits'

const UI_ROOT = path.resolve(__dirname, '../..')

let upstream: http.Server
let upstreamPort = 0
const running: ChildProcess[] = []
const openSockets = new Set<Duplex>()

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/auth/websocket-scope')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          header: 'c2NvcGU',
          organizationId: 'org_1',
          userId: 'user_1',
          scope: ['col_a'],
        })
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  upstream.on('connection', (sock) => {
    openSockets.add(sock)
    sock.on('close', () => openSockets.delete(sock))
  })
  // Accept the upgrade and then swallow everything: this test is about what the
  // GATEWAY does with client frames, not what a backend replies.
  upstream.on('upgrade', (_req, sock) => {
    openSockets.add(sock)
    sock.on('data', () => {})
    sock.on('error', () => {})
    sock.on('close', () => openSockets.delete(sock))
    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    )
  })
  await new Promise<void>((resolve) => upstream.listen(0, resolve))
  upstreamPort = (upstream.address() as { port: number }).port
})

afterAll(async () => {
  for (const sock of openSockets) sock.destroy()
  openSockets.clear()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

afterEach(() => {
  while (running.length) running.pop()?.kill('SIGKILL')
})

async function reservePort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as { port: number }
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

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
      // Every request here comes from 127.0.0.1; the per-IP upgrade limit is a
      // different layer and would only add noise to what these tests assert.
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

/** Complete an upgrade and hand back the live client socket. */
function openSocket(port: number, cookie: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
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
    req.on('upgrade', (_res, sock) => {
      sock.on('error', () => {})
      resolve(sock)
    })
    req.on('response', () => reject(new Error('upgrade refused')))
    req.on('error', reject)
    req.end()
  })
}

/** A masked client→server text frame, the way a browser sends one. */
function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const header =
    body.length < 126
      ? Buffer.from([0x81, 0x80 | body.length])
      : (() => {
          const h = Buffer.alloc(4)
          h[0] = 0x81
          h[1] = 0x80 | 126
          h.writeUInt16BE(body.length, 2)
          return h
        })()
  const masked = Buffer.from(body)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

const chatTurn = (n: number) =>
  textFrame(JSON.stringify({ type: 'user_message', id: `m${n}`, content: { messages: [] } }))

/** Resolves true if the socket closes within `ms`. */
function closedWithin(socket: Duplex, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed || socket.readableEnded) return resolve(true)
    const timer = setTimeout(() => resolve(false), ms)
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    socket.once('close', done)
    socket.once('end', done)
  })
}

describe('gateway WS frame limiting', () => {
  it('closes a socket that floods chat turns past the burst clause', async () => {
    const port = await startGateway()
    const socket = await openSocket(port, 'session=flooder')

    // Comfortably past the burst clause — a client loop, not a person typing.
    const burst = CHAT_TURN_LIMIT.burst?.limit ?? CHAT_TURN_LIMIT.limit
    for (let i = 0; i < burst + 5; i++) socket.write(chatTurn(i))

    expect(await closedWithin(socket, 5000)).toBe(true)
  })

  it('leaves an ordinary conversational pace alone', async () => {
    const port = await startGateway()
    const socket = await openSocket(port, 'session=polite')

    // Two turns is nobody's idea of abuse, and this is the assertion that keeps
    // the limit from being quietly tightened into the way of real users.
    socket.write(chatTurn(1))
    socket.write(chatTurn(2))

    expect(await closedWithin(socket, 1500)).toBe(false)
    socket.destroy()
  })

  it('does not count frames when the limiter is switched off', async () => {
    const port = await startGateway({ GRID_WS_MESSAGE_LIMITS: '0' })
    const socket = await openSocket(port, 'session=unlimited')

    const burst = CHAT_TURN_LIMIT.burst?.limit ?? CHAT_TURN_LIMIT.limit
    for (let i = 0; i < burst + 20; i++) socket.write(chatTurn(i))

    // The escape hatch has to actually work, or an operator cannot roll the
    // behaviour back without a deploy.
    expect(await closedWithin(socket, 1500)).toBe(false)
    socket.destroy()
  })
})
