#!/usr/bin/env node
/**
 * Measure one chat turn through the real socket path: `/dev/stream-socket`.
 *
 *   node scripts/measure-stream-socket.mjs [--url http://localhost:3001]
 *        [--speed 1] [--runs 1] [--viewport phone|desktop|both]
 *
 * Opens the page in headless Chromium at 390x844 (CPU throttled 4x over CDP,
 * the phone case) and at 1280x800 (unthrottled), waits for the turn to settle
 * and prints one JSON line per run:
 *
 *   maxFrameKB / totalKB  the largest frame but the settled snapshot and the terminal, and the whole turn
 *   longTaskMs / maxLongTaskMs / longTasksOver50  main-thread tasks during the turn
 *   rafBusyMs      summed rAF gaps beyond one 60 Hz frame (sees shorter work too)
 *   backlogMs      last frame sent → last frame handled by the client
 *   maxFrameLagMs  the worst send → handled gap of any frame
 *   firstCardMs    question sent → first card in the DOM
 *   settleMs       terminal frame handled → answer settled
 *   cls            layout shift summed over the turn
 *
 * The page is development only, so this measures `next dev`: several times
 * the production cost, and the React dev build. Compare runs on the same
 * server (before against after), never a dev number with a production one
 * (docs/contributing/gotchas.md).
 *
 * Chromium comes from PLAYWRIGHT_BROWSERS_PATH (default /opt/pw-browsers) or
 * CHROMIUM_PATH; nothing here downloads a browser.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

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

const round = (value) => Math.round(value)

/** The probe, reduced to the numbers that say what the turn cost. */
const summarize = (probe) => {
  const tasks = probe.longTasks
  const since = (at) => (at > 0 && probe.sentAt > 0 ? round(at - probe.sentAt) : null)
  return {
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
    cls: Math.round(probe.layoutShift * 1000) / 1000,
  }
}

const measure = async (browser, viewportName) => {
  const viewport = VIEWPORTS[viewportName]
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
  // The dev server's HMR socket, passed through except for its close: a dev
  // server restarting mid-turn must not reload the page being measured.
  await context.routeWebSocket(/\/_next\//, (ws) => {
    ws.connectToServer().onClose(() => {})
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (viewport.cpuThrottle > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: viewport.cpuThrottle })
  }
  const url = `${baseUrl}/dev/stream-socket?speed=${speed}`
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 180_000 })
    await page.waitForFunction(() => window.__streamSocket?.done === true, null, {
      timeout: TIMEOUT_MS,
      polling: 500,
    })
    const probe = await page.evaluate(() => window.__streamSocket)
    return { viewport: viewportName, cpuThrottle: viewport.cpuThrottle, ...summarize(probe), pageErrors: errors.length }
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

const main = async () => {
  const executablePath = findChromium()
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  try {
    for (let run = 0; run < runs; run++) {
      for (const viewportName of viewports) {
        const result = await measureWithRetry(browser, viewportName)
        console.log(JSON.stringify({ run: run + 1, ...result }))
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
