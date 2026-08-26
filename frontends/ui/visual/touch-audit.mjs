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

async function resolveChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  try {
    const entries = await readdir(base)
    const dir = entries
      .filter((e) => e.startsWith('chromium-') && !e.includes('headless'))
      .sort()
      .pop()
    if (dir) {
      const candidate = join(base, dir, 'chrome-linux', 'chrome')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    /* fall through below */
  }
  // `playwright-core` ships NO browser, so there is nothing to fall through to:
  // without one of the two paths above, `chromium.launch()` throws a stack trace
  // about a missing executable, which reads as the harness being broken rather
  // than as a machine that has never had a browser installed. Say the actual
  // thing, with the two ways out.
  throw new Error(
    [
      'No Chromium found for the touch audit.',
      '',
      `  Looked in: ${process.env.CHROMIUM_PATH ?? '(CHROMIUM_PATH unset)'}`,
      `             ${base}`,
      '',
      'This repo pins `playwright-core`, which ships no browser of its own. Either:',
      '  • install one:  npx playwright install chromium',
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
    // How far the document ACTUALLY scrolls sideways, by trying it — not
    // `scrollWidth > clientWidth`, which was the first version of this check and
    // reports pages that do not scroll at all. An ancestor's `scrollWidth`
    // accounts for content laid out inside a nested horizontal scroller even
    // though that content is reachable only by scrolling the strip, so a
    // composer with a chip rail read as 453px wide on a 390px screen and moved
    // nowhere. Asking the browser to scroll and reading back how far it went is
    // the question we actually mean.
    // Whether the PAGE itself runs past the viewport — derived from the walk
    // above, not from trying to scroll.
    //
    // Two probes were tried and both are wrong. `scrollWidth > clientWidth`
    // counts content laid out inside a nested horizontal scroller, so a composer
    // with a chip rail reads as 453px on a 390px screen and is perfectly fine.
    // Scrolling and reading back looks like the honest answer and cannot work
    // here at all: under Playwright's `isMobile` emulation the layout viewport
    // does not pan programmatically, so `window.scrollX` stays 0 no matter what
    // — verified against a deliberately 900px-wide document, where the same
    // probe returns 510 with `isMobile: false` and 0 with it on. A check that
    // always answers "no" is worse than no check, because it reads as evidence.
    //
    // What actually decides it: an element sticking out past the viewport with
    // NOTHING above it clipping or scrolling the overhang. That is precisely the
    // `overflow` list — `covered`/`clipped` are already excluded, and anything
    // inside a scroller is flagged `scroller`. If one of those exists, the page
    // has content it cannot show without moving sideways.
    pageOverflow: overflow.filter((item) => !item.scroller).length,
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
  const { spawn } = await import('node:child_process')
  const port = Number(process.env.PORT) || 3411
  const baseUrl = `http://127.0.0.1:${port}`
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
      process.kill(-child.pid, 'SIGTERM')
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
 * Is THIS app serving previews at `baseUrl`?
 *
 * Not "did something answer below 500". A 3xx to a sign-in page and an unrelated
 * service already on port 3411 both clear that bar, and the audit would then
 * measure whatever they returned and report it as a clean surface. So: no
 * redirect, a 200, and a body carrying the marker the `/dev` layout renders.
 */
async function servesPreviews(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}${PROBE_TARGET.path}`, { redirect: 'manual' })
    const body = await res.text()
    if (res.status !== 200) return false
    return PROBE_MARKER ? body.includes(PROBE_MARKER) : true
  } catch {
    return false
  }
}

/**
 * The surface readiness is checked against, and a string its HTML must contain.
 *
 * `waitFor` in the registry is a Playwright selector, and this probe is a plain
 * `fetch` — so the marker is the selector's own text where that is a `text=`
 * locator, and otherwise readiness settles for a clean 200. Either way it is
 * THIS app answering, not a redirect and not whatever else holds the port.
 */
const PROBE_TARGET = SCREENSHOT_TARGETS.find((t) => t.id === 'chat-turn') ?? SCREENSHOT_TARGETS[0]
const PROBE_MARKER = PROBE_TARGET?.waitFor?.startsWith('text=')
  ? PROBE_TARGET.waitFor.slice('text='.length)
  : null

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

    const scrolls = report.pageOverflow > 0
    const clean =
      !scrolls &&
      report.overflow.length === 0 &&
      report.traps.length === 0 &&
      report.small.length === 0
    if (!clean) flagged += 1
    console.log(`\n## ${target.id}  (${target.path})${clean ? '  clean' : ''}`)
    if (scrolls) {
      console.log(
        `   PAGE RUNS PAST THE VIEWPORT  ${report.pageOverflow} element(s) with nothing clipping them  ` +
          `(laid out ${report.documentScrollWidth} in ${report.viewportWidth}; see OVERFLOW below)`,
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
