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
 * Speed. Startup dominates a small run, so the harness avoids paying it twice:
 * an already-running `next dev` for this app (`.next/dev/lock`) is reused, and
 * `SCREENSHOT_KEEP_SERVER=1` leaves ours up for the next run to attach to — the
 * fast inner loop while iterating on one component. From cold, the routes are
 * pre-compiled with plain fetches *while Chromium launches*, so the dev server's
 * on-demand compile overlaps the browser boot instead of stalling the first
 * navigation of every route. Capture itself runs a pool of workers
 * (SCREENSHOT_CONCURRENCY, default ~half the cores) and loads each page ONCE per
 * viewport — the light and dark shots come off that single load by flipping
 * `prefers-color-scheme` plus the app's `.dark` class.
 *
 * Env: SCREENSHOT_CONCURRENCY, SCREENSHOT_KEEP_SERVER, SCREENSHOT_NO_REUSE=1
 * (always boot a private server), SCREENSHOT_SETTLE_MS, SCREENSHOT_THEME_SETTLE_MS,
 * SCREENSHOT_NETWORK_IDLE_MS.
 *
 * Browser: uses the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH), so no
 * download is needed. Override with CHROMIUM_PATH if resolution fails.
 */

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENSHOT_TARGETS } from './registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_ROOT = join(HERE, '..')
const OUT_DIR = join(HERE, 'screenshots')
const THEMES = ['light', 'dark']
const VIEWPORT = { width: 1200, height: 900 }
// Mobile variant — a common phone logical width (iPhone 12/13/14 class). Captured
// with isMobile/hasTouch so viewport meta + touch heuristics match a real device,
// written as `<id>.mobile.<theme>.png` alongside the desktop shot.
const MOBILE_VIEWPORT = { width: 390, height: 844 }

/** Workers capturing in parallel. Each holds one browser context at a time. */
const CONCURRENCY = Math.max(
  1,
  Number(process.env.SCREENSHOT_CONCURRENCY) || Math.min(4, Math.max(2, Math.floor(cpus().length / 2))),
)
/** Settle budget after a page is ready, on top of fonts/animation-frame waits. */
const SETTLE_MS = Number(process.env.SCREENSHOT_SETTLE_MS ?? 400)
/** Shorter settle after flipping the theme on an already-settled page (repaint only). */
const THEME_SETTLE_MS = Number(process.env.SCREENSHOT_THEME_SETTLE_MS ?? 150)
/** Cap on the quiet-network wait — see `settle()` for why it is bounded. */
const NETWORK_IDLE_MS = Number(process.env.SCREENSHOT_NETWORK_IDLE_MS ?? 5000)
/** Cap on the best-effort wait for a `waitFor` match to become *visible*. */
const VISIBLE_MS = Number(process.env.SCREENSHOT_VISIBLE_MS ?? 3000)

/** The dev server this process owns, so a Ctrl-C takes it down with us. */
let activeServer = null
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    activeServer?.stop()
    process.exit(1)
  })
}

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

/** Poll a URL until it responds (server ready), the deadline passes, or `died` resolves. */
async function waitForServer(url, timeoutMs, died) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // A dev server that exited (port in use, bad env, …) will never answer; failing
    // here turns a multi-minute poll into an immediate, readable error.
    const reason = died?.()
    if (reason) throw new Error(`Dev server exited before becoming ready (${reason})`)
    try {
      const res = await fetch(url, { method: 'HEAD' })
      if (res.status < 500) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Server did not become ready at ${url} within ${timeoutMs}ms`)
}

/**
 * Reuse a `next dev` that is already running for this app, if there is one.
 *
 * Next records the live dev server in `.next/dev/lock`. Booting a second one
 * fails ("Another next dev server is already running"), and starting from cold
 * costs a server boot plus an on-demand compile of every route — so when a usable
 * server is already up (a leftover from a previous run with
 * SCREENSHOT_KEEP_SERVER, or the developer's own `npm run dev`) we attach to it.
 *
 * The probe is deliberately strict: the route has to answer 200 without a
 * redirect, so a dev server that gates `/dev/*` behind auth is rejected rather
 * than silently screenshotted as a sign-in page.
 */
async function findRunningServer(probePath) {
  if (process.env.SCREENSHOT_NO_REUSE === '1') return null
  let lock
  try {
    lock = JSON.parse(await readFile(join(UI_ROOT, '.next', 'dev', 'lock'), 'utf8'))
  } catch {
    return null // no dev server has run here
  }
  if (!lock?.port) return null
  try {
    process.kill(lock.pid, 0) // still alive?
  } catch {
    return null // stale lock from a killed server
  }
  const baseUrl = `http://127.0.0.1:${lock.port}`
  try {
    const res = await fetch(`${baseUrl}${probePath}`, { redirect: 'manual' })
    await res.arrayBuffer()
    if (res.status !== 200) {
      console.log(`[screenshots] ignoring dev server on ${baseUrl} (${probePath} → ${res.status})`)
      return null
    }
  } catch {
    return null
  }
  return baseUrl
}

/** Boot `next dev` on a free-ish port; returns { baseUrl, stop }. */
async function bootDevServer() {
  const port = Number(process.env.PORT) || 3311
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`[screenshots] booting next dev on ${baseUrl} …`)
  // Call the local binary directly — `npx` re-resolves the package on every run.
  const localNext = join(UI_ROOT, 'node_modules', '.bin', 'next')
  const [cmd, argv] = existsSync(localNext) ? [localNext, []] : ['npx', ['next']]
  const child = spawn(cmd, [...argv, 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: UI_ROOT,
    // Own process group: `next dev` spawns its own server child, and SIGTERM to the
    // npx wrapper alone leaves it running — the next run then dies on "Another next
    // dev server is already running". Killing the group takes the whole tree down.
    detached: true,
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
  let exited = null
  child.on('exit', (code, signal) => {
    exited = `code ${code}${signal ? `, signal ${signal}` : ''}`
  })
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  // Poll the liveness probe — it's excluded from the AuthKit matcher and returns
  // 200 as soon as the Node server is up, so it's a reliable readiness signal
  // (unlike '/', which can 500 while providers initialize).
  try {
    await waitForServer(`${baseUrl}/api/healthz`, 180_000, () => exited)
  } catch (err) {
    stop()
    throw err
  }
  return { baseUrl, stop }
}

/**
 * Pre-compile the dev routes with plain fetches. `next dev` compiles a route the
 * first time it is requested; doing that here (concurrently, while the browser
 * launches) keeps the compile off the critical path of the first navigation.
 */
async function warmRoutes(baseUrl, targets) {
  const paths = [...new Set(targets.map((t) => new URL(t.path, baseUrl).pathname))]
  let next = 0
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++]
      try {
        const res = await fetch(`${baseUrl}${path}`)
        await res.arrayBuffer() // drain so the connection is reusable
      } catch {
        /* the real navigation will surface any genuine failure */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY * 2, paths.length) }, worker))
}

/**
 * Wait until the page has stopped changing, then a fixed settle.
 *
 * The quiet-network wait is what makes a shot faithful — several previews only
 * finish rendering after a fixture fetch resolves, and without it the same target
 * captures at a different height on every run. It is *bounded* because that is
 * also the harness's worst stall: the React Flow previews keep the network busy
 * for ~30s, and waiting it out cost more than every other target combined.
 * Capping it keeps the fidelity and drops the stall.
 */
async function settle(page, ms, { networkIdle = true } = {}) {
  if (networkIdle) {
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => {
      /* bounded on purpose — the layout-stability check below is the real gate */
    })
  }
  await page
    .evaluate(async () => {
      await document.fonts?.ready
      await Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete)
          .map(
            (img) =>
              new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true })
                img.addEventListener('error', resolve, { once: true })
              }),
          ),
      )
      // Layout stability: hold until the document height stops moving. Async
      // fixture data and measured layouts (React Flow sizes its canvas from
      // measured node bounds) land a few frames late, and capturing before that
      // yields a shorter page — the flakiest failure this harness has.
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      let last = -1
      let stable = 0
      for (let i = 0; i < 40 && stable < 3; i++) {
        await frame()
        const height = document.documentElement.scrollHeight
        stable = height === last ? stable + 1 : 0
        last = height
      }
    })
    .catch(() => {
      /* a navigation mid-evaluate is not worth failing the capture over */
    })
  if (ms > 0) await page.waitForTimeout(ms)
}

/** Apply a theme to an already-loaded page: media query + the app's class token. */
async function applyTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme })
  // Force the app's class-based theme so `.dark` tokens apply deterministically.
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark')
  }, theme)
}

/**
 * Capture one (target, viewport variant): load the page once, then shoot every
 * theme off that single load.
 */
async function captureVariant(browser, baseUrl, target, variant) {
  const context = await browser.newContext({
    viewport: variant.viewport,
    colorScheme: THEMES[0],
    deviceScaleFactor: 2, // crisp, retina-quality PNGs
    isMobile: variant.isMobile,
    hasTouch: variant.hasTouch,
  })
  const files = []
  try {
    const page = await context.newPage()
    const url = `${baseUrl}${target.path}`
    // `waitFor` (plus the fonts/images settle below) is the readiness gate, so the
    // navigation itself only has to reach DOMContentLoaded — `networkidle` would
    // additionally sit through a 500ms quiet window on every single load.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await applyTheme(page, THEMES[0])
    if (target.waitFor) {
      // Two-phase on purpose. Presence is the real gate; visibility is only
      // best-effort, because a component may legitimately keep a matched element
      // hidden — React Flow marks its nodes `visibility: hidden` until it has
      // measured them, so Playwright's default `state: 'visible'` wait could only
      // ever time out on the herleitung targets. That was 30s burned on six of
      // the loads in a full run, and it was silent: the shot was then taken on a
      // timeout rather than on a readiness signal.
      const found = await page
        .waitForSelector(target.waitFor, { state: 'attached', timeout: 30_000 })
        .catch(() => null)
      if (!found) {
        console.warn(`[screenshots] WARN ${target.id}${variant.suffix}: "${target.waitFor}" never appeared`)
      } else {
        await page.waitForSelector(target.waitFor, { state: 'visible', timeout: VISIBLE_MS }).catch(() => {})
      }
    }
    // Optional keyboard focus: press Tab N times so `:focus-visible` engages
    // (it only fires for keyboard nav), capturing a real focus-ring state.
    if (target.tabStops) {
      for (let i = 0; i < target.tabStops; i++) await page.keyboard.press('Tab')
    }
    await settle(page, SETTLE_MS) // let fonts/animations settle

    for (const [i, theme] of THEMES.entries()) {
      if (i > 0) {
        await applyTheme(page, theme)
        // Repaint only — the layout is settled and a theme flip issues no requests.
        await settle(page, THEME_SETTLE_MS, { networkIdle: false })
      }
      const file = join(OUT_DIR, `${target.id}${variant.suffix}.${theme}.png`)
      await page.screenshot({ path: file, fullPage: true })
      console.log(`[screenshots] ${target.id}${variant.suffix} (${theme}) → ${file}`)
      files.push(file)
    }
  } finally {
    await context.close()
  }
  return files
}

/** Run `jobs` through `limit` workers, collecting results and failures. */
async function runPool(jobs, limit, run) {
  const results = []
  const failures = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      try {
        results.push(...(await run(job)))
      } catch (err) {
        failures.push({ job, err })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return { results, failures }
}

async function main() {
  const startedAt = Date.now()
  // Flags: `--mobile` also captures the mobile variant for every target;
  // `--mobile-only` captures ONLY the mobile variant. Without either, a target
  // is captured at mobile only when it opts in via `mobile: true` in the registry.
  const rawArgs = process.argv.slice(2)
  const flags = new Set(rawArgs.filter((a) => a.startsWith('--')))
  const forceMobile = flags.has('--mobile')
  const mobileOnly = flags.has('--mobile-only')
  const only = rawArgs.filter((a) => !a.startsWith('--'))
  const targets = only.length ? SCREENSHOT_TARGETS.filter((t) => only.includes(t.id)) : SCREENSHOT_TARGETS
  if (targets.length === 0) {
    console.error(`[screenshots] no targets matched: ${only.join(', ')}`)
    process.exit(1)
  }

  // One job per (target, viewport variant) — both themes come off a single load.
  const jobs = []
  for (const target of targets) {
    if (!mobileOnly) jobs.push({ target, variant: { suffix: '', viewport: VIEWPORT, isMobile: false, hasTouch: false } })
    if (mobileOnly || forceMobile || target.mobile) {
      jobs.push({
        target,
        variant: { suffix: '.mobile', viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true },
      })
    }
  }

  await mkdir(OUT_DIR, { recursive: true })

  let server = null
  let baseUrl = process.env.BASE_URL || (await findRunningServer(targets[0].path))
  if (baseUrl) {
    console.log(`[screenshots] reusing dev server at ${baseUrl}`)
  } else {
    server = await bootDevServer()
    activeServer = server
    baseUrl = server.baseUrl
  }

  const executablePath = await resolveChromium()
  // Compile the routes while Chromium boots — both are on the critical path
  // otherwise, and the dev server is idle during a launch that costs ~a second.
  const [browser] = await Promise.all([
    chromium.launch({ executablePath, args: ['--no-sandbox'] }),
    warmRoutes(baseUrl, targets),
  ])

  const concurrency = Math.min(CONCURRENCY, jobs.length)
  console.log(`[screenshots] ${jobs.length} page load(s) × ${THEMES.length} theme(s), ${concurrency} in parallel`)

  let outcome
  try {
    outcome = await runPool(jobs, concurrency, (job) => captureVariant(browser, baseUrl, job.target, job.variant))
  } finally {
    await browser.close()
    // Keeping the server alive lets the next run skip the boot *and* the compile
    // — the fast inner loop while iterating on one component.
    if (server && process.env.SCREENSHOT_KEEP_SERVER === '1') {
      console.log(`[screenshots] leaving dev server running at ${baseUrl} (SCREENSHOT_KEEP_SERVER=1)`)
    } else if (server) {
      server.stop()
    }
  }

  const { results, failures } = outcome
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[screenshots] wrote ${results.length} file(s) in ${elapsed}s:`)
  for (const f of results.sort()) console.log(`  ${f}`)
  if (failures.length) {
    console.error(`[screenshots] ${failures.length} target(s) failed:`)
    for (const { job, err } of failures) {
      console.error(`  ${job.target.id}${job.variant.suffix}: ${err?.stack || err}`)
    }
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[screenshots] failed:', err)
  process.exit(1)
})
