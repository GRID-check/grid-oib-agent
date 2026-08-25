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
 *   DOC OVERFLOW  the document itself scrolls horizontally — always a defect.
 *   OVERFLOW      an element's box sticks out past the viewport with nothing
 *                 above it to catch the overhang. Only the OUTERMOST offender is
 *                 listed. Content clipped by an ancestor is not reported at all
 *                 (a progress indicator translated inside its own track is a
 *                 technique, not a defect).
 *   SCROLLS       the same, but an ancestor scrolls horizontally, so the content
 *                 is reachable sideways. A deliberate strip of chips and a table
 *                 nobody meant to make horizontal look identical from here —
 *                 this line says "this scrolls", and you decide whether it should.
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
    /* fall through to Playwright's own resolution */
  }
  return undefined
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
    documentScrollWidth: document.documentElement.scrollWidth,
    overflow,
    small,
  }
}

/** Boot a private `next dev`, with the same stub auth env the capture harness uses. */
async function startServer() {
  const { spawn } = await import('node:child_process')
  const port = Number(process.env.PORT) || 3411
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn('npx', ['next', 'dev', '--turbopack', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: UI_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      NEXT_PUBLIC_WORKOS_REDIRECT_URI:
        process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI || `${baseUrl}/api/auth/callback`,
      WORKOS_API_KEY: process.env.WORKOS_API_KEY || 'sk_test_touch_audit',
      WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID || 'client_touch_audit',
      WORKOS_COOKIE_PASSWORD:
        process.env.WORKOS_COOKIE_PASSWORD || 'touch_audit_cookie_password_at_least_32b',
    },
  })
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/dev/chat-turn`, { method: 'HEAD' })
      if (res.status < 500) return { baseUrl, stop: () => child.kill() }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  child.kill()
  throw new Error(`Dev server did not become ready at ${baseUrl}`)
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
try {
  for (const target of targets) {
    let report
    try {
      await page.goto(baseUrl + target.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      if (target.waitFor) await page.waitForSelector(target.waitFor, { timeout: 8_000 }).catch(() => {})
      await page.waitForTimeout(700)
      report = await page.evaluate(AUDIT, { interactive: INTERACTIVE, floor: FLOOR, slack: SLACK })
    } catch (error) {
      console.log(`\n## ${target.id}  FAILED: ${String(error.message).split('\n')[0]}`)
      continue
    }

    const scrolls = report.documentScrollWidth > report.viewportWidth + 1
    const clean = !scrolls && report.overflow.length === 0 && report.small.length === 0
    if (!clean) flagged += 1
    console.log(`\n## ${target.id}  (${target.path})${clean ? '  clean' : ''}`)
    if (scrolls) {
      console.log(`   DOC OVERFLOW  ${report.documentScrollWidth} > ${report.viewportWidth}`)
    }
    for (const item of report.overflow) {
      const label = item.scroller ? 'SCROLLS  ' : 'OVERFLOW '
      console.log(`   ${label} ${item.left}..${item.right}  ${item.what}`)
    }
    for (const item of report.small) {
      console.log(`   SMALL  ${item.width}x${item.height}  ${item.what}`)
    }
  }
} finally {
  await browser.close()
  server?.stop()
}

console.log(`\n${targets.length} target(s) audited at ${VIEWPORT.width}x${VIEWPORT.height}; ${flagged} with findings.`)
