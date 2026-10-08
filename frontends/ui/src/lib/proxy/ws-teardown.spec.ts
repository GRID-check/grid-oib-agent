/**
 * @vitest-environment node
 */
/**
 * How the WebSocket proxy reports a spliced socket going away (`server.js`).
 *
 * A post-upgrade `write EPIPE` on the spliced upstream is teardown, not an
 * error: it logs at warn, and the `ws()` callback must not write
 * `HTTP/1.1 502 Bad Gateway` into the live WebSocket stream.
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { handleWsProxyError, watchSplicedSockets } from './ws-teardown.js'

class FakeSocket extends EventEmitter {
  written: string[] = []
  destroyed = false
  ended = false
  write(chunk: string) {
    this.written.push(chunk)
    return true
  }
  end() {
    this.ended = true
  }
  destroy() {
    this.destroyed = true
  }
}

const socketError = (code: string) => Object.assign(new Error(`write ${code}`), { code })

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function splicedPair(logger = makeLogger(), now = () => 0) {
  const client = new FakeSocket()
  const upstream = new FakeSocket()
  watchSplicedSockets(client as never, upstream as never, { logger, now })
  return { client, upstream, logger }
}

describe('watchSplicedSockets', () => {
  it('logs a post-upgrade upstream EPIPE at warn with side and age, and writes no 502', () => {
    let t = 0
    const { client, upstream, logger } = splicedPair(makeLogger(), () => t)
    t = 56_200

    const err = socketError('EPIPE')
    upstream.emit('error', err)
    // http-proxy routes the same error through the ws() callback.
    handleWsProxyError(err, client as never, { logger })

    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]).toEqual(expect.arrayContaining(['upstream', 'EPIPE', '56.2']))
    expect(client.written.join('')).not.toContain('502')
    expect(client.destroyed).toBe(true)
  })

  it.each(['ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_DESTROYED', 'ETIMEDOUT'])(
    'treats a client %s as teardown',
    (code) => {
      const { client, logger } = splicedPair()
      client.emit('error', socketError(code))
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0]).toContain('client')
      expect(logger.error).not.toHaveBeenCalled()
    }
  )

  it('keeps an unknown code at error', () => {
    const { upstream, logger } = splicedPair()
    upstream.emit('error', socketError('ERR_SOMETHING_NEW'))
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('names the side that closed first, once, and closes the other side', () => {
    let t = 0
    const { client, upstream, logger } = splicedPair(makeLogger(), () => t)
    t = 3_000

    upstream.emit('close', false)
    client.emit('close', false)

    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0]).toEqual(expect.arrayContaining(['upstream', '3.0']))
    expect(client.ended).toBe(true)
  })

  it('blames the side that errored even when the other side closes first', () => {
    // http-proxy destroys the client synchronously on an upstream error, so the
    // client's 'close' arrives before the upstream's.
    const { client, upstream, logger } = splicedPair()
    upstream.emit('error', socketError('ECONNRESET'))
    client.emit('close', false)
    upstream.emit('close', true)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.info.mock.calls[0]).toContain('upstream')
  })

  it('destroys the other side when one closes on an error', () => {
    const { client, upstream } = splicedPair()
    client.emit('close', true)
    expect(upstream.destroyed).toBe(true)
  })
})

describe('handleWsProxyError before the upgrade', () => {
  it('answers 502 and warns for a backend that is not there', () => {
    const socket = new FakeSocket()
    const logger = makeLogger()
    handleWsProxyError(socketError('ECONNREFUSED'), socket as never, { logger })
    expect(socket.written.join('')).toContain('502 Bad Gateway')
    expect(socket.destroyed).toBe(true)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('answers 502 and errors for anything else', () => {
    const socket = new FakeSocket()
    const logger = makeLogger()
    handleWsProxyError(new Error('Invalid header'), socket as never, { logger })
    expect(socket.written.join('')).toContain('502 Bad Gateway')
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})

describe('server.js wiring', () => {
  const source = readFileSync(new URL('../../../server.js', import.meta.url), 'utf8')

  it('watches the pair from the proxied request, and has no unclassified socket error log', () => {
    expect(source).toMatch(
      /proxyReq\.once\('upgrade'[\s\S]{0,200}watchSplicedSockets\(socket, proxySocket\)/
    )
    expect(source).not.toContain('upstream socket error')
  })

  it('routes the ws() callback through handleWsProxyError', () => {
    expect(source).toContain('handleWsProxyError(err, socket)')
  })
})
