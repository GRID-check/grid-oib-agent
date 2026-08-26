/**
 * Touch audit — the measurement half of the mobile contract.
 *
 * `src/components/ui/touch-target.spec.ts` and
 * `src/components/ui/mobile-affordances.spec.ts` assert the WIRING: the utility
 * exists, a reveal has a touch escape, a hand-written field carries the 16px
 * floor. None of them can say how big anything actually rendered, and that is
 * where the defects were. Three examples this script produced on its first run,
 * every one of which passed review and every static check:
 *
 *   - the inline citation marker, the most-pressed control in an answer, at 13x16;
 *   - the Herleitung's source row — the whole point of the surface — at 290x19,
 *     because a `p-0` override stripped the padding that was its target;
 *   - the Files list, whose Name column laid out 437px wide inside a 308px
 *     wrapper, so `truncate` never fired and the reader had to drag the list
 *     sideways to read a filename. Nothing looked broken: the Table primitive's
 *     `overflow-x-auto` caught it.
 *
 * It loads every `/dev` preview in `registry.mjs` at a phone viewport with
 * `hasTouch`, then reports, per target:
 *
 *   PAGE RUNS PAST the page itself has content past the viewport — always a
 *   THE VIEWPORT   defect. Derived from the OVERFLOW walk below (an element
 *                 sticking out with nothing clipping or scrolling it), NOT from
 *                 `scrollWidth > clientWidth` and NOT from trying to scroll and
 *                 reading back. The first counts content inside a nested
 *                 scroller; the second cannot work under `isMobile` emulation,
 *                 where the layout viewport does not pan programmatically and
 *                 `window.scrollX` stays 0 for every page. Both shipped here
 *                 before being measured against a deliberately over-wide
 *                 document, which is the only way either mistake shows.
 *   OVERFLOW      an element's box sticks out past the viewport with nothing
 *                 above it to catch the overhang. Only the OUTERMOST offender is
 *                 listed. Content clipped by an ancestor is not reported at all
 *                 (a progress indicator translated inside its own track is a
 *                 technique, not a defect).
 *   SCROLLS       the same, but an ancestor scrolls horizontally, so the content
 *                 is reachable sideways. A deliberate strip of chips and a table
 *                 nobody meant to make horizontal look identical from here —
 *                 this line says "this scrolls", and you decide whether it should.
 *   SCROLL TRAP   a region at least a third of the viewport tall whose
 *                 `touch-action` refuses the vertical pan. A finger landing on
 *                 it moves nothing, so the page reads as frozen rather than as a
 *                 control misbehaving — taps still work. This is how React
 *                 Flow's `.react-flow__pane` took the whole reasoning graph: one
 *                 inherited declaration from a library stylesheet, for gestures
 *                 the graph had already turned off in its props.
 *   SMALL         an interactive element under 44px on either axis, measured
 *                 INCLUDING any `touch-target` ::after catchment, so a control
 *                 that widens its catchment correctly does not report.
 *
 * SMALL is a prompt, not a verdict. An inline target inside a sentence cannot
 * reach 44px without stealing its neighbour's taps — see the note in
 * `CitationMarker.tsx` — and WCAG 2.5.8 exempts it for that reason. What the
 * list is for is the control that is small because nobody looked.
 *
 * Usage:
 *   node visual/touch-audit.mjs                     # boot a server, audit all
 *   node visual/touch-audit.mjs chat-turn intake    # only these registry ids
 *   BASE_URL=http://127.0.0.1:3011 node visual/touch-audit.mjs   # reuse a server
 *
 * `--include-platform` adds the `platform-*` targets, which are excluded by
 * default: they are the internal operator console, not a customer surface.
 */

import { chromium } from 'playwright-core'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENSHOT_TARGETS } from './registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_ROOT = join(HERE, '..')

/** A common phone logical width — the same viewport `capture.mjs` shoots at. */
const VIEWPORT = { width: 390, height: 844 }
/** The floor, in CSS px. Half a pixel of slack for sub-pixel layout. */
const FLOOR = 44
const SLACK = 0.5

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const only = args.filter((a) => !a.startsWith('--'))

const INTERACTIVE = [
  'button',
  'a[href]',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=switch]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=option]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Every place a Chromium can plausibly be, in the order it should win.
 *
 * `npx playwright install chromium` — the command this harness tells you to run
 * — writes to Playwright's per-OS cache, NOT to `/opt/pw-browsers`. An earlier
 * version searched only `PLAYWRIGHT_BROWSERS_PATH` and `/opt/pw-browsers`, so
 * following the documented remedy on an ordinary machine still failed with the
 * error that recommended it. The default cache is now searched too, which makes
 * the instruction true instead of making the reader set an env var to repair it.
 */
function chromiumSearchPath() {
  const home = homedir()
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers']
  // Playwright's own defaults, per platform (see its `registry/index.ts`).
  if (process.platform === 'darwin') roots.push(join(home, 'Library', 'Caches', 'ms-playwright'))
  else if (process.platform === 'win32') {
    roots.push(join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright'))
  } else roots.push(join(home, '.cache', 'ms-playwright'))
  return roots.filter(Boolean)
}

async function resolveChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH
  const roots = chromiumSearchPath()
  for (const base of roots) {
    let entries
    try {
      entries = await readdir(base)
    } catch {
      continue
    }
    // Newest revision wins, and `headless_shell` is excluded: it cannot render
    // the previews this audit measures.
    const dirs = entries
      .filter((e) => e.startsWith('chromium-') && !e.includes('headless'))
      .sort((a, b) => Number(a.slice('chromium-'.length)) - Number(b.slice('chromium-'.length)))
    for (const dir of dirs.reverse()) {
      // The layout differs by platform; check each rather than assume Linux.
      for (const rel of [
        ['chrome-linux', 'chrome'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-win', 'chrome.exe'],
      ]) {
        const candidate = join(base, dir, ...rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  // `playwright-core` ships NO browser, so there is nothing to fall through to:
  // without one of the paths above, `chromium.launch()` throws a stack trace
  // about a missing executable, which reads as the harness being broken rather
  // than as a machine that has never had a browser installed. Say the actual
  // thing, with the ways out.
  throw new Error(
    [
      'No Chromium found for the touch audit.',
      '',
      `  Looked in: ${process.env.CHROMIUM_PATH ?? '(CHROMIUM_PATH unset)'}`,
      ...roots.map((r) => `             ${r}`),
      '',
      'This repo pins `playwright-core`, which ships no browser of its own. Either:',
      '  • install one:  npx playwright install chromium',
      '    (it lands in the last path above, which this harness searches)',
      '  • or point at an existing binary:  CHROMIUM_PATH=/path/to/chrome task fe:touch-audit',
      '',
      'The devcontainer and CI images already provide one at /opt/pw-browsers.',
    ].join('\n'),
  )
}

/**
 * Runs INSIDE the page. Kept as one self-contained function because it is
 * serialised across the CDP boundary — it can close over nothing from here.
 */
const AUDIT = ({ interactive, floor, slack }) => {
  const viewportWidth = document.documentElement.clientWidth
  const describe = (el) => {
    const cls = (el.getAttribute('class') || '').slice(0, 110)
    const text = (el.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' ')
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${text}" [${cls}]`
  }

  const overflow = []
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (rect.right <= viewportWidth + 1 && rect.left >= -1) continue

    // Walk up once, answering two questions at the same time.
    let parent = el.parentElement
    let covered = false
    let clipped = false
    let scroller = false
    while (parent) {
      const box = parent.getBoundingClientRect()
      // Report the outermost offender only: a child sticking out of a parent
      // that already sticks out is the same defect reported twice.
      if (box.right > viewportWidth + 1 || box.left < -1) {
        covered = true
        break
      }
      const overflowX = getComputedStyle(parent).overflowX
      // `hidden`/`clip` means the overhang is not on screen at all. A progress
      // bar's indicator is translated far off its own left edge inside a clipped
      // track; reporting it is reporting the technique, not a defect.
      if (overflowX === 'hidden' || overflowX === 'clip') {
        clipped = true
        break
      }
      // `auto`/`scroll` means the content is REACHABLE but only sideways. Worth
      // saying — a deliberate strip of chips and a table nobody meant to make
      // horizontal look identical from here — so it is reported under its own
      // label rather than as an overflow.
      if (overflowX === 'auto' || overflowX === 'scroll') scroller = true
      parent = parent.parentElement
    }
    if (covered || clipped) continue
    overflow.push({
      what: describe(el),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      scroller,
    })
  }

  // Scroll traps: a region that refuses the vertical pan, so a finger landing on
  // it moves nothing and the page reads as frozen.
  //
  // The browser decides a gesture by intersecting `touch-action` across the
  // touched element AND every ancestor up to the scroll container, so one
  // declaration on a wrapper strands everything inside it no matter what those
  // descendants compute for themselves. That is how React Flow's
  // `.react-flow__pane` took the whole reasoning graph — 877px of it on an 844px
  // screen. Reading a node's own computed style there says `auto` and is
  // worthless, which is why this walks outward instead.
  //
  // Only regions worth stranding on are reported: at least a third of the
  // viewport tall and most of it wide, i.e. big enough that a reader's thumb has
  // no obvious way around. A 3D canvas or a slider that legitimately owns its
  // gestures will show up here too — this says "nothing scrolls here", and you
  // decide whether that is the intent.
  const traps = []
  const PANS_VERTICALLY = /^(auto|manipulation|pan-y|pan-up|pan-down)\b/
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el)
    if (PANS_VERTICALLY.test(style.touchAction)) continue
    const rect = el.getBoundingClientRect()
    if (rect.height < window.innerHeight / 3) continue
    if (rect.width < viewportWidth * 0.6) continue
    // Report the outermost region only: the declaration is inherited, so every
    // descendant would otherwise repeat its ancestor's finding.
    const parent = el.parentElement
    if (parent && !PANS_VERTICALLY.test(getComputedStyle(parent).touchAction)) continue
    traps.push({
      what: describe(el),
      touchAction: style.touchAction,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }

  const small = []
  for (const el of document.querySelectorAll(interactive)) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    // Screen-reader-only controls (the skip link, a visually-hidden radio behind
    // a styled label) are clipped to 1px BY DESIGN and report as the smallest
    // target on every page. What a finger hits is the label, which is measured
    // on its own.
    // `aria-hidden` covers Radix's hidden native `<select>`, which exists for
    // form submission and is 1px by construction; the styled trigger beside it
    // is the real control and is measured on its own.
    if (el.closest('[aria-hidden="true"]')) continue
    const style = getComputedStyle(el)
    if (style.clipPath !== 'none' && rect.width <= 2 && rect.height <= 2) continue
    if (Number(style.opacity) === 0 && rect.width <= 2 && rect.height <= 2) continue
    // A `touch-target` catchment IS the target, so measure the ::after too.
    const after = getComputedStyle(el, '::after')
    const width = Math.max(rect.width, parseFloat(after.width) || 0)
    const height = Math.max(rect.height, parseFloat(after.height) || 0)
    if (width >= floor - slack && height >= floor - slack) continue
    small.push({ what: describe(el), width: Math.round(width), height: Math.round(height) })
  }

  return {
    viewportWidth,
    // Does the PAGE run past the viewport, and if so what is responsible?
    //
    // Three probes were tried before this one. `scrollWidth > clientWidth` PER
    // ELEMENT over-reports, because a horizontal scroller exceeds its own client
    // width by design — that is what makes it a scroller. Scrolling and reading
    // `window.scrollX` back cannot work here at all: under Playwright's
    // `isMobile` emulation the layout viewport does not pan programmatically, so
    // the read is 0 for every page (verified against a deliberately 900px-wide
    // document: 510 with `isMobile: false`, 0 with it on). Deriving it purely
    // from the element walk under-reports: a pseudo-element can push the
    // document wider while appearing nowhere in `querySelectorAll('*')` and
    // contributing nothing to its host's border box — verified with an
    // over-wide `::after`, where the document measured 900px against a 390px
    // viewport and the walk found nothing.
    //
    // So the two questions are separated. `documentElement` answers WHETHER,
    // and it is the right element for it: unlike a per-element read it counts
    // only what the document itself must scroll to show, so content inside an
    // `overflow-x:auto` rail correctly reads as clean (measured: 390 vs 390 for
    // a 1200px rail, 1200 vs 390 for the same content unclipped). The walk
    // answers WHAT, and may legitimately come up empty — an overflow no element
    // accounts for is a pseudo-element, and is reported as unattributed rather
    // than swallowed.
    pageOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    pageOverflowBy: Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    pageOverflowBlamed: overflow.filter((item) => !item.scroller).length,
    documentScrollWidth: document.documentElement.scrollWidth,
    overflow,
    traps,
    small,
  }
}

/**
 * Boot a private `next dev`, with the same stub auth env the capture harness uses.
 *
 * `detached: true` and killing the PROCESS GROUP, not the child: `npx` is a
 * wrapper, so `child.kill()` reaps the wrapper and leaves `next dev` holding the
 * port. That orphan then answers the next audit's readiness probe from stale
 * state, or blocks the boot outright — it happened during this harness's own
 * development, twice, and cost a machine to a `next-server` nobody could see.
 *
 * `REQUIRE_AUTH: 'false'` is FORCED rather than defaulted. Everything else here
 * falls back to an ambient value because a real credential is more useful than a
 * stub, but this one decides whether `/dev/*` renders the preview or an auth
 * redirect — inherit a `true` from the surrounding shell and the audit measures
 * a sign-in page while reporting on the surface it thinks it loaded.
 */
async function startServer() {
  const { spawn, spawnSync } = await import('node:child_process')
  const port = Number(process.env.PORT) || 3411
  const baseUrl = `http://127.0.0.1:${port}`
  if (await portIsBusy(port)) {
    throw new Error(
      `Port ${port} is already in use.\n\n` +
        'The audit will not adopt it: a stale `next dev` from an earlier run, or an\n' +
        'unrelated service, would answer the readiness probe while our own server\n' +
        'failed to bind — and the audit would report that other process\'s pages as\n' +
        "this branch's. Stop whatever holds the port, or pass a free one.",
    )
  }

  const child = spawn('npx', ['next', 'dev', '--turbopack', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: UI_ROOT,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      REQUIRE_AUTH: 'false',
      NEXT_PUBLIC_WORKOS_REDIRECT_URI:
        process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI || `${baseUrl}/api/auth/callback`,
      WORKOS_API_KEY: process.env.WORKOS_API_KEY || 'sk_test_touch_audit',
      WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID || 'client_touch_audit',
      WORKOS_COOKIE_PASSWORD:
        process.env.WORKOS_COOKIE_PASSWORD || 'touch_audit_cookie_password_at_least_32b',
    },
  })

  const stop = () => {
    try {
      if (process.platform === 'win32') {
        // Windows has no process groups, so `process.kill(-pid)` throws EINVAL and
        // the catch below would swallow it — leaving `next dev` holding the port.
        // That used to be a silent leak; with `portIsBusy` above it is now a hard
        // failure on the NEXT run, so the platform needs its own path rather than
        // a shared one that only works on POSIX. `/t` takes the tree (the `npx`
        // wrapper AND the server under it), `/f` because the server ignores a
        // polite close once Turbopack is up.
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch {
      /* already gone */
    }
  }

  let exited = null
  child.on('exit', (code, signal) => {
    exited = `code ${code}${signal ? `, signal ${signal}` : ''}`
  })

  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Dev server exited before becoming ready (${exited})`)
    if (await servesPreviews(baseUrl)) return { baseUrl, stop }
    await new Promise((r) => setTimeout(r, 500))
  }
  stop()
  throw new Error(`Dev server did not become ready at ${baseUrl}`)
}

/**
 * Turn a registry `waitFor` selector into a string the SERVER-RENDERED HTML must
 * contain, or null when the selector cannot yield one.
 *
 * `waitFor` is a Playwright selector and this probe is a plain `fetch`, so only
 * some selector shapes survive the translation. `text=` and `[data-testid="x"]`
 * do. A class hook like `.react-flow__node` does not: it is applied by client
 * JavaScript and appears nowhere in the server's HTML.
 */
function htmlMarkerFor(waitFor) {
  if (typeof waitFor !== 'string') return null
  if (waitFor.startsWith('text=')) return waitFor.slice('text='.length)
  const testId = waitFor.match(/\[data-testid=["']([^"']+)["']\]/)
  if (testId) return `data-testid="${testId[1]}"`
  return null
}

/**
 * The surface readiness is checked against, and the string its HTML must carry.
 *
 * Chosen for whether it yields a marker, NOT by id. The previous version pinned
 * `chat-turn`, whose `waitFor` is `.react-flow__node` — a client-applied class,
 * so the marker was null and the probe fell back to "any 200 will do". That is
 * exactly the hole the marker exists to close: a stale `next dev` still holding
 * the port answers 200 for the previous branch's code, and the audit measures
 * it. 97 of the registry's targets use a `data-testid`, which IS in the server's
 * HTML, so a usable marker is always available.
 */
const PROBE_TARGET = SCREENSHOT_TARGETS.find((t) => htmlMarkerFor(t.waitFor))
const PROBE_MARKER = htmlMarkerFor(PROBE_TARGET?.waitFor)
if (!PROBE_MARKER) {
  // Never degrade to "any 200": that silently turns a readiness check into a
  // liveness check and the audit reports another server's pages as this one's.
  throw new Error(
    'No registry target yields a server-HTML marker for the readiness probe.\n' +
      'Give one target a `text=` or `[data-testid="…"]` waitFor, or the audit\n' +
      'cannot tell this app apart from anything else holding the port.',
  )
}

/**
 * Is THIS app serving previews at `baseUrl`?
 *
 * Not "did something answer below 500". A 3xx to a sign-in page and an unrelated
 * service on the port both clear that bar, and the audit would then measure
 * whatever they returned and report it as a clean surface. So: no redirect, a
 * 200, and a body carrying a marker only this app's `/dev` preview renders.
 */
async function servesPreviews(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}${PROBE_TARGET.path}`, { redirect: 'manual' })
    if (res.status !== 200) return false
    return (await res.text()).includes(PROBE_MARKER)
  } catch {
    return false
  }
}

/**
 * Is anything already listening on `port`?
 *
 * Checked BEFORE spawning. Our own `next dev` would fail to bind and exit, while
 * the incumbent keeps answering the readiness probe — so without this the audit
 * silently measures whatever that other process serves. Refusing is the only
 * honest option: the port's occupant is not ours to kill.
 */
async function portIsBusy(port) {
  return await new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (busy) => {
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

const targets = SCREENSHOT_TARGETS.filter((t) => {
  if (only.length) return only.includes(t.id)
  return flags.has('--include-platform') || !t.id.startsWith('platform-')
})

if (targets.length === 0) {
  console.error(`No registry targets matched ${only.join(', ')}`)
  process.exit(1)
}

const server = process.env.BASE_URL ? null : await startServer()
const baseUrl = process.env.BASE_URL ?? server.baseUrl

const browser = await chromium.launch({ executablePath: await resolveChromium() })
const context = await browser.newContext({
  viewport: VIEWPORT,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
})
const page = await context.newPage()

let flagged = 0
let failed = 0
try {
  for (const target of targets) {
    let report
    try {
      await page.goto(baseUrl + target.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      if (target.waitFor) await page.waitForSelector(target.waitFor, { timeout: 8_000 }).catch(() => {})
      await page.waitForTimeout(700)
      report = await page.evaluate(AUDIT, { interactive: INTERACTIVE, floor: FLOOR, slack: SLACK })
    } catch (error) {
      // A target that did not load is a FINDING, not a skip. Counting it as
      // neither is how an audit that measured nothing reports "0 with findings"
      // and exits 0 — the failure mode that makes a green harness worthless.
      failed += 1
      console.log(`\n## ${target.id}  FAILED TO LOAD: ${String(error.message).split('\n')[0]}`)
      continue
    }

    const scrolls = report.pageOverflow
    const clean =
      !scrolls &&
      report.overflow.length === 0 &&
      report.traps.length === 0 &&
      report.small.length === 0
    if (!clean) flagged += 1
    console.log(`\n## ${target.id}  (${target.path})${clean ? '  clean' : ''}`)
    if (scrolls) {
      // An overflow the walk cannot name is the pseudo-element case: `::before`
      // and `::after` are absent from `querySelectorAll('*')` and contribute
      // nothing to their host's rect, so they widen the document invisibly. Say
      // so rather than printing "0 element(s)", which reads as a contradiction.
      const blame = report.pageOverflowBlamed
        ? `${report.pageOverflowBlamed} element(s) with nothing clipping them; see OVERFLOW below`
        : 'no element accounts for it — check for an over-wide ::before / ::after'
      console.log(
        `   PAGE RUNS PAST THE VIEWPORT  by ${report.pageOverflowBy}px  ` +
          `(laid out ${report.documentScrollWidth} in ${report.viewportWidth})\n` +
          `                                ${blame}`,
      )
    }
    for (const item of report.overflow) {
      const label = item.scroller ? 'SCROLLS  ' : 'OVERFLOW '
      console.log(`   ${label} ${item.left}..${item.right}  ${item.what}`)
    }
    for (const item of report.traps) {
      console.log(
        `   SCROLL TRAP  ${item.width}x${item.height}  touch-action: ${item.touchAction}  ${item.what}`,
      )
    }
    for (const item of report.small) {
      console.log(`   SMALL  ${item.width}x${item.height}  ${item.what}`)
    }
  }
} finally {
  await browser.close()
  server?.stop()
}

const loaded = targets.length - failed
console.log(
  `\n${loaded}/${targets.length} target(s) audited at ${VIEWPORT.width}x${VIEWPORT.height}; ` +
    `${flagged} with findings${failed ? `, ${failed} failed to load` : ''}.`,
)
// Non-zero only for targets that could not be measured. Findings themselves do
// not fail the run: `SMALL` is a prompt to read (an inline target in a sentence
// legitimately stays under the floor), so exiting on them would train everyone
// to pass `|| true`. A target that never loaded is different — it means the
// numbers above are describing fewer surfaces than they claim to.
if (failed > 0) process.exitCode = 1
