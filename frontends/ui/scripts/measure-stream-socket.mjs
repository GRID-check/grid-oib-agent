#!/usr/bin/env node
/**
 * Measure one chat turn through the real socket path: `/dev/stream-socket`.
 *
 *   node scripts/measure-stream-socket.mjs [--url http://localhost:3001]
 *        [--speed 1] [--runs 1] [--viewport phone|desktop|both]
 *        [--reader scroll] [--animations]
 *        [--scenario <name>] [--error preack|steps|prose|finish]
 *        [--drop <ms>] [--reload <ms>] [--switch <ms>] [--stop <ms>]
 *        [--toggle open@<ms>,close@<ms>]
 *        [--reduced-motion] [--color-scheme dark|light] [--browser chromium|webkit]
 *
 * Opens the page in headless Chromium at 390x844 (CPU throttled 4x over CDP,
 * the phone case) and at 1280x800 (unthrottled), waits for the turn to settle
 * and for 2.5 s after it (the Herleitung collapses and the footer lands in
 * that window), and prints one JSON line per run:
 *
 *   maxFrameKB / totalKB  the largest frame but the settled snapshot and the terminal, and the whole turn
 *   longTaskMs / maxLongTaskMs / longTasksOver50  main-thread tasks during the turn
 *   rafBusyMs      summed rAF gaps beyond one 60 Hz frame (sees shorter work too)
 *   backlogMs      last frame sent → last frame handled by the client
 *   maxFrameLagMs  the worst send → handled gap of any frame
 *   firstCardMs    question sent → first card in the DOM; null when the turn has none
 *   settleMs       terminal frame handled → answer settled
 *   cls            layout shift summed over the turn, the 2.5 s after the settle included
 *   clsBeforeSettle / clsAfterSettle  the same, split at the settle
 *   caretShift     shifts made only by the caret following its text; kept out of cls
 *   shiftsMoved    the largest moves of elements on screen before and after ({t, v, node, dy, dh})
 *   shiftsEdge     count and largest sources that ENTERED or LEFT the viewport. Their dy/dh are of
 *                  the visible part only, so an answer rising 1,400 px from below the fold reads as
 *                  `dy +228`: look at `reading` for how far things really went (gotchas.md)
 *   reading        the reader's line: `firstProseMaxDelta` and `lastLineMaxDelta` (px, the largest
 *                  frame-to-frame jump of the answer's first prose block / of the last visible line
 *                  while on screen, the reader's own scrolling excluded), `worst` {t, which, delta},
 *                  and `answerInViewAtFirstWord` (the answer card's top inside the scroller when its
 *                  first word showed)
 *   scrollCalls    programmatic scrolls of the thread's scroller during the turn, and the first
 *                  few as fn@t; one (the top-anchor on send) is the budget
 *   loaf           long animation frames: count over 50 ms, the longest, and the scripts that held
 *                  the most frame time
 *
 * --reader scroll  wheels the thread down to the answer 2.5 s after its first word, as a reader
 *                  who wants to read it would; what the settle then does to that reader is the case
 *                  the default run cannot see when the answer streams below the fold.
 * --scenario, --error, --drop, --reload, --switch, --stop, --toggle  go to the page as its query
 *                  parameters, unchanged: the lifecycle to play (`app/dev/stream-socket/page.tsx` lists
 *                  them). The line then carries `actions`, what the harness did and when (each
 *                  `attach` with how many frames it replayed), `turnsAsked` and `resumed`.
 * --reduced-motion  the context prefers reduced motion. With --animations the audit changes its
 *                  question: a 0 ms entry is the reduced path working and is not flagged, and an
 *                  entry is flagged `!` only when it still runs longer than 0 ms and is anything
 *                  but a pure opacity fade of at most `--motion-quick` (the one motion reduced
 *                  motion keeps). Each line names the animated properties.
 * --color-scheme dark  the context prefers the dark scheme.
 * --browser webkit  WebKit from the Playwright browsers directory, for Safari's layout (no scroll
 *                  anchoring). Exits with a message when none is installed; CPU throttling and
 *                  --animations need Chromium's CDP and are skipped there.
 * --animations     records every animation Chromium starts (CDP Animation domain) and prints, after
 *                  the run's line, each distinct one with its duration and easing, flagged `!` when
 *                  neither matches the motion tokens (src/styles/tokens.css,
 *                  src/components/motion/index.tsx). motion.dev's JS-driven height tweens never
 *                  reach the compositor and are not listed.
 *
 * The page is development only, so this measures `next dev`: several times
 * the production cost, and the React dev build. Compare runs on the same
 * server (before against after), never a dev number with a production one
 * (docs/contributing/gotchas.md).
 *
 * Chromium comes from PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers) or
 * CHROMIUM_PATH; nothing here downloads a browser.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright-core'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}

const baseUrl = arg('url', 'http://localhost:3001')
const speed = arg('speed', '1')
const runs = Math.max(1, Number(arg('runs', '1')) || 1)
const viewportArg = arg('viewport', 'both')
const TIMEOUT_MS = Number(arg('timeout', '240000'))
const reader = arg('reader', 'still')
const auditAnimations = args.includes('--animations')
const reducedMotion = args.includes('--reduced-motion')
const colorScheme = arg('color-scheme', 'light')
const browserName = arg('browser', 'chromium')
/** The page's own parameters, passed through as given. */
const PAGE_PARAMS = ['scenario', 'error', 'drop', 'reload', 'switch', 'stop', 'toggle']
const pageQuery = () => {
  const query = new URLSearchParams({ speed })
  for (const name of PAGE_PARAMS) {
    const value = arg(name, undefined)
    if (value !== undefined) query.set(name, value)
  }
  return query.toString()
}

const VIEWPORTS = {
  phone: { width: 390, height: 844, cpuThrottle: 4 },
  desktop: { width: 1280, height: 800, cpuThrottle: 1 },
}
const viewports = viewportArg === 'both' ? ['phone', 'desktop'] : [viewportArg]

/** A Chromium binary already on disk: CHROMIUM_PATH, then the Playwright browsers directory. */
const findChromium = () => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return undefined
  const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name))
  const candidate = dir ? join(root, dir, 'chrome-linux', 'chrome') : undefined
  return candidate && existsSync(candidate) ? candidate : undefined
}

/** A WebKit build in the Playwright browsers directory, or undefined: nothing here downloads one. */
const findWebkit = () => {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return undefined
  return readdirSync(root).find((name) => /^webkit-\d+$/.test(name))
}

const round = (value) => Math.round(value)
const round3 = (value) => Math.round(value * 1000) / 1000

/**
 * The motion vocabulary, read from its two sources so the audit cannot drift
 * from them: the `--motion-*` durations and `--ease-*` curves in tokens.css,
 * and the spring settle durations in the motion module.
 */
const motionTokens = () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const css = readFileSync(join(root, 'styles', 'tokens.css'), 'utf8')
  const motion = readFileSync(join(root, 'components', 'motion', 'index.tsx'), 'utf8')
  const durations = new Set([0])
  for (const [, ms] of css.matchAll(/--motion-[\w-]+:\s*(\d+)ms/g)) durations.add(Number(ms))
  for (const [, seconds] of motion.matchAll(/duration:\s*(\d*\.?\d+)/g)) durations.add(round(Number(seconds) * 1000))
  for (const [, ms] of motion.matchAll(/LinearDuration\s*=\s*'(\d+)ms'/g)) durations.add(Number(ms))
  for (const [, seconds] of motion.matchAll(/SettleSeconds\s*=\s*(\d*\.?\d+)/g)) durations.add(round(Number(seconds) * 1000))
  const quick = Number(/--motion-quick:\s*(\d+)ms/.exec(css)?.[1] ?? 180)
  const easings = new Set(['linear'])
  for (const [, curve] of css.matchAll(/--ease-[\w-]+:\s*(cubic-bezier\([^)]*\))/g)) easings.add(curve.replace(/\s+/g, ''))
  return { durations, easings, quick }
}

/** Is this an easing the tokens produce? A `linear(…)` spring twin counts. */
const tokenEasing = (easing, tokens) => {
  const compact = (easing ?? '').replace(/\s+/g, '')
  return tokens.easings.has(compact) || compact.startsWith('linear(')
}

/** The largest few of a list by a score. */
const top = (list, score, count) => [...list].sort((a, b) => score(b) - score(a)).slice(0, count)

/** The probe, reduced to the numbers that say what the turn cost. */
const summarize = (probe) => {
  const tasks = probe.longTasks
  const since = (at) => (at > 0 && probe.sentAt > 0 ? round(at - probe.sentAt) : null)
  return {
    scenario: probe.scenario,
    error: probe.error,
    turnsAsked: probe.turnsAsked,
    resumed: probe.resumed,
    actions: probe.actions.map((action) => `${action.action}@${action.t}`),
    framesScripted: probe.framesScripted,
    framesHandled: probe.framesHandled,
    stepKB: round(probe.stepBytes / 1024),
    maxFrameKB: Math.round(probe.maxFrameBytes / 102.4) / 10,
    totalKB: round(probe.totalBytes / 1024),
    heartbeats: probe.heartbeats,
    longTaskMs: tasks.reduce((sum, task) => sum + task.ms, 0),
    maxLongTaskMs: tasks.reduce((max, task) => Math.max(max, task.ms), 0),
    longTasksOver50: tasks.filter((task) => task.ms > 50).length,
    rafBusyMs: round(probe.rafBusyMs),
    backlogMs: probe.lastSentAt > 0 ? round(probe.lastHandledAt - probe.lastSentAt) : null,
    maxFrameLagMs: probe.maxFrameLagMs,
    firstStepMs: since(probe.firstStepAt),
    firstDeltaMs: since(probe.firstDeltaAt),
    firstCardMs: since(probe.firstCardAt),
    completeMs: since(probe.completeAt),
    settleMs: probe.settledAt > 0 && probe.completeAt > 0 ? round(probe.settledAt - probe.completeAt) : null,
    cls: round3((probe.clsBeforeSettle ?? 0) + (probe.clsAfterSettle ?? 0)),
    clsBeforeSettle: round3(probe.clsBeforeSettle),
    clsAfterSettle: round3(probe.clsAfterSettle),
    caretShift: round3(probe.caretShift ?? 0),
    shiftsMoved: top(
      probe.shifts.flatMap((shift) =>
        shift.moved.map((source) => ({ t: shift.t, v: round3(shift.value), after: shift.afterSettle, ...source }))
      ),
      (source) => Math.abs(source.dy) + Math.abs(source.dh),
      4
    ),
    shiftsEdge: {
      count: probe.shifts.reduce((sum, shift) => sum + shift.edge.length, 0),
      largest: top(
        probe.shifts.flatMap((shift) =>
          shift.edge.map((source) => ({ t: shift.t, v: round3(shift.value), after: shift.afterSettle, ...source }))
        ),
        (source) => source.v,
        3
      ),
    },
    reading: probe.reading,
    scrollCalls: {
      count: probe.scrollCalls.length,
      afterSettle: probe.scrollCalls.filter((call) => call.afterSettle).length,
      first: probe.scrollCalls.slice(0, 4).map((call) => `${call.fn}@${call.t}`),
    },
    loaf: summarizeLoaf(probe.loaf),
  }
}

/** Long animation frames: how many, the longest, and which scripts held the most frame time. */
const summarizeLoaf = (frames) => {
  const byScript = new Map()
  for (const frame of frames) {
    for (const script of frame.scripts) byScript.set(script.name, (byScript.get(script.name) ?? 0) + script.ms)
  }
  const longest = top(frames, (frame) => frame.ms, 1)[0]
  return {
    over50: frames.filter((frame) => frame.ms > 50).length,
    maxMs: longest?.ms ?? 0,
    maxAt: longest?.t ?? null,
    blockingMs: frames.reduce((sum, frame) => sum + frame.blockingMs, 0),
    topScripts: top([...byScript], ([, ms]) => ms, 3).map(([name, ms]) => `${name} ${ms}ms`),
  }
}

/** The reader scrolls the thread until the answer card's top is near the viewport's top. */
const scrollToAnswer = async (page, viewport) => {
  await page.mouse.move(viewport.width / 2, viewport.height / 3)
  const distance = await page.evaluate(
    () => (document.querySelector('[id="message-stream-socket-answer"]')?.getBoundingClientRect().top ?? 0) - 90
  )
  for (let left = distance; left > 0; left -= 400) {
    await page.mouse.wheel(0, Math.min(400, left))
    await page.waitForTimeout(30)
  }
}

/** Records every animation Chromium starts, with the element it runs on. */
const recordAnimations = async (cdp) => {
  const started = []
  await cdp.send('DOM.enable')
  await cdp.send('DOM.getDocument', { depth: 0 })
  await cdp.send('Animation.enable')
  const label = async (backendNodeId) => {
    try {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId })
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const cls = typeof this.className === 'string' ? this.className.split(' ').filter(Boolean).slice(0, 3).join('.') : ''
          return this.nodeType === 1 ? this.tagName.toLowerCase() + (cls ? '.' + cls : '') : this.nodeName
        }`,
      })
      return result.value
    } catch {
      return 'gone'
    }
  }
  // What the animation moves. A CSS transition is named after its property; a
  // Web Animation (motion.dev's WAAPI path) or a CSS animation is asked for its
  // keyframes, which is how the reduced-motion audit tells a fade from a move.
  const properties = async (animation) => {
    if (animation.type === 'CSSTransition') return animation.name || '?'
    try {
      const { remoteObject } = await cdp.send('Animation.resolveAnimation', { animationId: animation.id })
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: remoteObject.objectId,
        returnByValue: true,
        functionDeclaration: `function () {
          const skip = new Set(['offset', 'computedOffset', 'easing', 'composite'])
          const keys = new Set((this.effect?.getKeyframes() ?? []).flatMap((frame) => Object.keys(frame)))
          return [...keys].filter((key) => !skip.has(key)).sort().join(',') || '?'
        }`,
      })
      return result.value
    } catch {
      return '?'
    }
  }
  // A turn starts thousands of animations (a caret, shimmers, every chip).
  // Resolving the element of each one is two CDP round trips and flooded the
  // session until the run timed out, so only the first few elements per
  // distinct timing are named; the rest are counted.
  const named = new Map()
  cdp.on('Animation.animationStarted', async ({ animation }) => {
    const source = animation.source ?? {}
    const entry = {
      type: animation.type,
      name: animation.name || '-',
      duration: round(source.duration ?? 0),
      delay: round(source.delay ?? 0),
      easing: source.easing ?? '-',
      iterations: source.iterations ?? 1,
      node: '…',
      properties: '…',
    }
    started.push(entry)
    const timing = [entry.type, entry.name, entry.duration, entry.easing].join('|')
    const count = named.get(timing) ?? 0
    if (count >= 3 || !source.backendNodeId) return
    named.set(timing, count + 1)
    const [node, moved] = await Promise.all([label(source.backendNodeId), properties(animation)])
    entry.node = node
    entry.properties = moved
  })
  return started
}

/**
 * Under reduced motion the question is not "is this on the tokens" but "should
 * this still be running": 0 ms is the reduced path working, and the one motion
 * it keeps is a short fade. Anything else that runs is a miss, named with why.
 */
const reducedMotionMiss = (animation, tokens) => {
  if (animation.duration === 0) return null
  if (animation.properties === 'opacity' && animation.duration <= tokens.quick) return null
  if (animation.properties === 'opacity') return `opacity over ${tokens.quick}ms`
  return `moves ${animation.properties} for ${animation.duration}ms`
}

/** Each distinct animation once, with how often it ran, flagged when its timing is off the tokens. */
const printAnimations = (started) => {
  const tokens = motionTokens()
  const distinct = new Map()
  for (const animation of started) {
    const key = [
      animation.type,
      animation.name,
      animation.duration,
      animation.easing,
      animation.iterations,
      animation.node,
      animation.properties,
    ].join('|')
    distinct.set(key, { ...animation, count: (distinct.get(key)?.count ?? 0) + 1 })
  }
  let misses = 0
  for (const animation of distinct.values()) {
    const miss = reducedMotion ? reducedMotionMiss(animation, tokens) : null
    const offDuration = !reducedMotion && !tokens.durations.has(animation.duration)
    const offEasing = !reducedMotion && !tokenEasing(animation.easing, tokens)
    const flag = miss || offDuration || offEasing ? '!' : ' '
    if (miss) misses += 1
    const loop = animation.iterations === null || animation.iterations === Infinity ? ' infinite' : ''
    // A spring's `linear(…)` lists dozens of stops; its head is enough to recognise it.
    const easing = animation.easing.length > 48 ? `${animation.easing.slice(0, 45)}…` : animation.easing
    console.log(
      `  ${flag} ${animation.type} ${animation.name} [${animation.properties}] ${animation.duration}ms${offDuration ? '(off-token)' : ''} ${easing}${offEasing ? '(off-token)' : ''}${loop}${miss ? ` (reduced motion: ${miss})` : ''} ×${animation.count} ${animation.node}`
    )
  }
  if (reducedMotion) console.log(`  reduced motion: ${misses} distinct animation(s) still run`)
}

const measure = async (browser, viewportName) => {
  const viewport = VIEWPORTS[viewportName]
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    colorScheme,
  })
  // The dev server's HMR socket, passed through except for its close: a dev
  // server restarting mid-turn must not reload the page being measured.
  await context.routeWebSocket(/\/_next\//, (ws) => {
    ws.connectToServer().onClose(() => {})
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // CDP is Chromium's: WebKit runs unthrottled and without the animation audit.
  const cdp = browserName === 'chromium' ? await context.newCDPSession(page) : null
  if (cdp && viewport.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: viewport.cpuThrottle })
  const animations = cdp && auditAnimations ? await recordAnimations(cdp) : null
  const url = `${baseUrl}/dev/stream-socket?${pageQuery()}`
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 180_000 })
    const deadline = Date.now() + TIMEOUT_MS
    let scrolled = reader !== 'scroll'
    for (;;) {
      // `--reload` navigates mid-run: an evaluate that loses its page is asked again.
      const state = await page
        .evaluate(() => {
          const probe = window.__streamSocket
          return probe && { done: probe.done, sinceFirstWord: probe.firstDeltaAt > 0 ? performance.now() - probe.firstDeltaAt : -1 }
        })
        .catch(() => null)
      if (state?.done) break
      if (!scrolled && state && state.sinceFirstWord > 2_500) {
        scrolled = true
        await scrollToAnswer(page, viewport)
      }
      if (Date.now() > deadline) throw new Error(`no settled turn within ${TIMEOUT_MS} ms`)
      await page.waitForTimeout(250)
    }
    const probe = await page.evaluate(() => window.__streamSocket)
    return {
      result: {
        viewport: viewportName,
        browser: browserName,
        cpuThrottle: cdp ? viewport.cpuThrottle : 1,
        reader,
        ...(reducedMotion ? { reducedMotion: true } : {}),
        ...(colorScheme !== 'light' ? { colorScheme } : {}),
        ...summarize(probe),
        pageErrors: errors.length,
      },
      animations,
    }
  } finally {
    await context.close()
  }
}

/** A run the dev server interrupted (restarting, still compiling) is run again, up to three times. */
const measureWithRetry = async (browser, viewportName) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await measure(browser, viewportName)
    } catch (error) {
      if (attempt >= 3) throw error
      console.error(`retrying ${viewportName}: ${error.message.split('\n')[0]}`)
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
}

const launch = async () => {
  if (browserName === 'webkit') {
    if (!findWebkit()) {
      console.error('no WebKit in the Playwright browsers directory (PLAYWRIGHT_BROWSERS_PATH, default /opt/pw-browsers); install one with `npx playwright install webkit`')
      process.exit(2)
    }
    return webkit.launch({ headless: true })
  }
  const executablePath = findChromium()
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}

const main = async () => {
  const browser = await launch()
  try {
    for (let run = 0; run < runs; run++) {
      for (const viewportName of viewports) {
        const { result, animations } = await measureWithRetry(browser, viewportName)
        console.log(JSON.stringify({ run: run + 1, ...result }))
        if (animations) printAnimations(animations)
      }
    }
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
