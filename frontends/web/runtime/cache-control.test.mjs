import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IMMUTABLE, LONG_REVALIDATE, cacheControlFor } from './cache-control.mjs'

test('hashed build assets are immutable', () => {
  assert.equal(cacheControlFor('/_astro/BaseLayout.M30jRaNT.css'), IMMUTABLE)
})

test('unhashed fonts revalidate after a week; versioned art is immutable', () => {
  assert.equal(cacheControlFor('/fonts/inter-var-latin.woff2'), LONG_REVALIDATE)
  assert.equal(cacheControlFor('/art/piloti-ii-schichten-720.webp'), IMMUTABLE)
})

test('pages and server routes keep the adapter default', () => {
  // HTML must revalidate on every view, or a deploy is invisible for a week.
  for (const path of ['/', '/en/', '/blog/', '/sign-in', '/keystatic', '/api/keystatic/x']) {
    assert.equal(cacheControlFor(path), undefined, path)
  }
})

test('a prefix only matches a whole directory', () => {
  assert.equal(cacheControlFor('/_astro'), undefined)
  assert.equal(cacheControlFor('/fonts-preview/'), undefined)
  assert.equal(cacheControlFor('/artikel/'), undefined)
})
