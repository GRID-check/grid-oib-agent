/**
 * Production entry for the public site: the Astro node adapter's own handler,
 * behind one step that sets Cache-Control on static files (`cache-control.mjs`).
 *
 * Why a wrapper and not an adapter option: `@astrojs/node` has no hook for the
 * headers of files it serves from `dist/client` (`staticHeaders` covers
 * prerendered routes only, and only for CSP), and Astro middleware never runs
 * for a static file. Why not Envoy: an HTTPRoute `ResponseHeaderModifier`
 * cannot tell a 200 from a 404, and during a rolling update a new page can ask
 * an old pod for an asset it does not have yet. That 404 must not be cached
 * for a year. Here the header is set only when the file exists.
 *
 * Run it after `npm run build`: `node runtime/server.mjs`. HOST and PORT come
 * from the environment, as with `dist/server/entry.mjs`.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheControlFor } from './cache-control.mjs'

// The standalone entry starts its own server on import unless told not to.
// Static imports are hoisted, so the flag has to be set before a dynamic one.
process.env.ASTRO_NODE_AUTOSTART = 'disabled'
const { handler } = await import('../dist/server/entry.mjs')

const CLIENT_DIR = fileURLToPath(new URL('../dist/client/', import.meta.url))
const HOST = process.env.HOST ?? 'localhost'
const PORT = Number(process.env.PORT ?? 4321)

/** @param {string} pathname */
function isClientFile(pathname) {
  let decoded
  try {
    decoded = decodeURI(pathname)
  } catch {
    return false
  }
  const file = path.resolve(CLIENT_DIR, `.${decoded}`)
  if (!file.startsWith(CLIENT_DIR)) return false
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
function setCacheControl(req, res) {
  const pathname = (req.url ?? '/').split(/[?#]/, 1)[0]
  const value = cacheControlFor(pathname)
  if (value && isClientFile(pathname)) res.setHeader('Cache-Control', value)
}

const server = http.createServer((req, res) => {
  setCacheControl(req, res)
  handler(req, res)
})
server.listen(PORT, HOST, () => {
  console.log(`piloti-web listening on http://${HOST}:${PORT}`)
})
