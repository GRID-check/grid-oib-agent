#!/usr/bin/env node
/**
 * Landing-page screenshot harness. Unlike `preview-shots.mjs` (which captures
 * whole blog posts for authors), this one is for looking at the marketing site
 * while working on it: several viewports, several scroll positions per page,
 * both locales.
 *
 *   node scripts/shots.mjs <outDir> <baseUrl> [--viewports=desktop,mobile] [paths…]
 *
 * Viewports: wide (1920), desktop (1440), laptop (1280), tablet (834),
 *            mobile (390), mobile-sm (360)
 * Each page is captured full-page, plus one viewport-sized frame per scroll
 * stop (0 %, 20 %, 40 %, 60 %, 80 %) so long-page detail survives the
 * downscaling a full-page shot forces.
 */

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const VIEWPORTS = {
  wide: { width: 1920, height: 1080 },
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
  'mobile-sm': { width: 360, height: 740 },
}

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const positional = argv.filter((a) => !a.startsWith('--'))
const [outDir, baseUrl, ...paths] = positional

if (!outDir || !baseUrl) {
  console.error('usage: shots.mjs <outDir> <baseUrl> [--viewports=…] [--frames] [path…]')
  process.exit(2)
}

const wanted = (flags.find((f) => f.startsWith('--viewports='))?.split('=')[1] ?? 'desktop,mobile')
  .split(',')
  .filter(Boolean)
const frames = flags.includes('--frames')
const targets = paths.length ? paths : ['/']

for (const v of wanted) {
  if (!VIEWPORTS[v]) {
    console.error(`unknown viewport "${v}" (have: ${Object.keys(VIEWPORTS).join(', ')})`)
    process.exit(2)
  }
}

mkdirSync(outDir, { recursive: true })

const executablePath = process.env.PREVIEW_CHROMIUM_PATH || undefined
const browser = await chromium.launch(executablePath ? { executablePath } : {})
let failures = 0

for (const path of targets) {
  for (const name of wanted) {
    const viewport = VIEWPORTS[name]
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
    const url = new URL(path, baseUrl).href
    const slug = path.replace(/^\/|\/$/g, '').replace(/\//g, '_') || 'index'
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 })
      if (!response || !response.ok()) {
        throw new Error(`HTTP ${response ? response.status() : 'no response'}`)
      }
      // Settle the scroll-driven choreography: walk the page once so every
      // `data-reveal` has fired, then return to the top.
      const height = await page.evaluate(async () => {
        const h = document.body.scrollHeight
        for (let y = 0; y <= h; y += Math.round(window.innerHeight / 2)) {
          window.scrollTo(0, y)
          await new Promise((r) => setTimeout(r, 90))
        }
        window.scrollTo(0, h)
        return h
      })
      await page.waitForTimeout(600)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(500)

      await page.screenshot({ path: `${outDir}/${slug}.${name}.png`, fullPage: true })

      if (frames) {
        const stops = [0, 0.2, 0.4, 0.6, 0.8]
        for (const [i, stop] of stops.entries()) {
          const y = Math.round((height - viewport.height) * stop)
          await page.evaluate((to) => window.scrollTo(0, to), y)
          await page.waitForTimeout(700)
          await page.screenshot({ path: `${outDir}/${slug}.${name}.frame${i}.png` })
        }
        await page.evaluate(() => window.scrollTo(0, 0))
      }
      console.log(`ok   ${url} @ ${name}`)
    } catch (error) {
      failures++
      console.error(`FAIL ${url} @ ${name}: ${error.message}`)
    } finally {
      await page.close()
    }
  }
}

await browser.close()
process.exit(failures ? 1 : 0)
