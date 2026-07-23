/**
 * Visual screenshot harness.
 *
 * Captures each target in `visual/registry.mjs` in both light and dark themes and
 * writes deterministic PNGs into `visual/screenshots/`. These are the UI evidence
 * the definition-of-done requires for user-visible changes.
 *
 * Usage:
 *   npm run screenshots                 # boots `next dev` on a free port, captures all
 *   BASE_URL=http://localhost:3000 npm run screenshots   # reuse a running server
 *   npm run screenshots -- document-grid                 # capture only matching id(s)
 *
 * Browser: uses the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH), so no
 * download is needed. Override with CHROMIUM_PATH if resolution fails.
 */

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENSHOT_TARGETS } from './registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_ROOT = join(HERE, '..')
const OUT_DIR = join(HERE, 'screenshots')
const THEMES = ['light', 'dark']
const VIEWPORT = { width: 1200, height: 900 }

/** Resolve the pre-installed Chromium executable (no download in this env). */
async function resolveChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  try {
    const entries = await readdir(base)
    const dir = entries.filter((e) => e.startsWith('chromium-') && !e.includes('headless')).sort().pop()
    if (dir) {
      const candidate = join(base, dir, 'chrome-linux', 'chrome')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* fall through to Playwright's own resolution */
  }
  return undefined // let Playwright try its bundled path
}

/** Poll a URL until it responds (server ready) or the deadline passes. */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.status < 500) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`)
}

/** Boot `next dev` on a free-ish port; returns { baseUrl, stop }. */
async function bootDevServer() {
  const port = Number(process.env.PORT) || 3311
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`[screenshots] booting next dev on ${baseUrl} …`)
  const child = spawn('npx', ['next', 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: UI_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      REQUIRE_AUTH: 'false',
      // AuthKit's proxy middleware constructs a redirect URI on every request and
      // throws if it is unset — even with middlewareAuth disabled. The library
      // reads NEXT_PUBLIC_WORKOS_REDIRECT_URI (see authkit-nextjs env-variables),
      // so dummy values here let it initialize and the backend-free /dev preview
      // routes render.
      NEXT_PUBLIC_WORKOS_REDIRECT_URI:
        process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI || `${baseUrl}/api/auth/callback`,
      WORKOS_API_KEY: process.env.WORKOS_API_KEY || 'sk_test_screenshot_harness',
      WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID || 'client_screenshot_harness',
      WORKOS_COOKIE_PASSWORD:
        process.env.WORKOS_COOKIE_PASSWORD || 'screenshot_harness_cookie_password_at_least_32b',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  // Poll the liveness probe — it's excluded from the AuthKit matcher and returns
  // 200 as soon as the Node server is up, so it's a reliable readiness signal
  // (unlike '/', which can 500 while providers initialize).
  await waitForServer(`${baseUrl}/api/healthz`, 180_000)
  return {
    baseUrl,
    stop: () => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    },
  }
}

async function main() {
  const only = process.argv.slice(2)
  const targets = only.length ? SCREENSHOT_TARGETS.filter((t) => only.includes(t.id)) : SCREENSHOT_TARGETS
  if (targets.length === 0) {
    console.error(`[screenshots] no targets matched: ${only.join(', ')}`)
    process.exit(1)
  }

  await mkdir(OUT_DIR, { recursive: true })

  let server = null
  let baseUrl = process.env.BASE_URL
  if (!baseUrl) {
    server = await bootDevServer()
    baseUrl = server.baseUrl
  }

  const executablePath = await resolveChromium()
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })

  const written = []
  try {
    for (const target of targets) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: VIEWPORT,
          colorScheme: theme,
          deviceScaleFactor: 2, // crisp, retina-quality PNGs
        })
        const page = await context.newPage()
        const url = `${baseUrl}${target.path}`
        console.log(`[screenshots] ${target.id} (${theme}) → ${url}`)
        await page.goto(url, { waitUntil: 'networkidle', timeout: 120_000 })
        // Force the app's class-based theme so `.dark` tokens apply deterministically.
        await page.evaluate((t) => {
          document.documentElement.classList.toggle('dark', t === 'dark')
        }, theme)
        if (target.waitFor) {
          await page.waitForSelector(target.waitFor, { timeout: 30_000 }).catch(() => {})
        }
        await page.waitForTimeout(400) // let fonts/animations settle
        const file = join(OUT_DIR, `${target.id}.${theme}.png`)
        await page.screenshot({ path: file, fullPage: true })
        written.push(file)
        await context.close()
      }
    }
  } finally {
    await browser.close()
    if (server) server.stop()
  }

  console.log(`[screenshots] wrote ${written.length} file(s):`)
  for (const f of written) console.log(`  ${f}`)
}

main().catch((err) => {
  console.error('[screenshots] failed:', err)
  process.exit(1)
})
