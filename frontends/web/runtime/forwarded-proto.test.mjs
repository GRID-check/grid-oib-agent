import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createRequestFromNodeRequest } from 'astro/app/node'
import { markForwardedScheme } from './forwarded-proto.mjs'

/** A node request as Envoy delivers it: plain HTTP on the socket. */
function fromEnvoy(headers) {
  const socket = Object.assign(new EventEmitter(), { remoteAddress: '10.0.0.7' })
  return { method: 'GET', url: '/kontakt/', headers: { host: 'piloti.at', ...headers }, socket }
}

test('a request Envoy accepted over TLS reaches Astro as https, so a form POST passes its origin check', () => {
  const req = fromEnvoy({ 'x-forwarded-proto': 'https' })
  markForwardedScheme(req)
  const request = createRequestFromNodeRequest(req)
  assert.equal(new URL(request.url).origin, 'https://piloti.at')
})

test('without the mark, Astro sees http: the 403 this exists to prevent', () => {
  const request = createRequestFromNodeRequest(fromEnvoy({ 'x-forwarded-proto': 'https' }))
  assert.equal(new URL(request.url).origin, 'http://piloti.at')
})

test('a reused connection follows each request, not the first one', () => {
  const req = fromEnvoy({ 'x-forwarded-proto': 'https' })
  markForwardedScheme(req)
  req.headers['x-forwarded-proto'] = 'http'
  markForwardedScheme(req)
  assert.equal(new URL(createRequestFromNodeRequest(req).url).origin, 'http://piloti.at')
})

test('an absent or unknown header changes nothing', () => {
  for (const headers of [{}, { 'x-forwarded-proto': 'gopher' }]) {
    const req = fromEnvoy(headers)
    markForwardedScheme(req)
    assert.equal('encrypted' in req.socket, false)
  }
})
