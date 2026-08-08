#!/usr/bin/env node
/**
 * Full-page screenshots of the blog posts a PR touches, so whoever wrote the
 * post can see it before it is published rather than after.
 *
 * Expects a already-running server (the node adapter's `dist/server/entry.mjs`)
 * built with PUBLIC_INCLUDE_DRAFTS=1, so drafts render too — a draft is exactly
 * the thing an author most wants to look at.
 *
 *   node scripts/preview-shots.mjs <outDir> <baseUrl> <path> [path…]
 */

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const [outDir, baseUrl, ...paths] = process.argv.slice(2)

if (!outDir || !baseUrl || paths.length === 0) {
  console.error('usage: preview-shots.mjs <outDir> <baseUrl> <path> [path…]')
  process.exit(2)
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

mkdirSync(outDir, { recursive: true })

// CI installs a browser matching its playwright-core. The dev container instead
// ships a pinned Chromium at /opt/pw-browsers (docs/ux/visual-screenshots.md),
// whose build rarely matches — point at it explicitly rather than re-downloading.
const executablePath = process.env.PREVIEW_CHROMIUM_PATH || undefined

const browser = await chromium.launch(executablePath ? { executablePath } : {})
let failures = 0

for (const path of paths) {
  for (const viewport of VIEWPORTS) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height },
    })
    const url = new URL(path, baseUrl).href
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
      if (!response || !response.ok()) {
        throw new Error(`HTTP ${response ? response.status() : 'no response'}`)
      }
      // The landing page animates content in on scroll via `data-reveal`; without
      // settling it first, a screenshot catches half-faded elements.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(500)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(250)

      const slug = path.replace(/^\/|\/$/g, '').replace(/\//g, '_') || 'index'
      await page.screenshot({
        path: `${outDir}/${slug}.${viewport.name}.png`,
        fullPage: true,
      })
      console.log(`captured ${url} (${viewport.name})`)
    } catch (error) {
      failures += 1
      console.error(`FAILED ${url} (${viewport.name}): ${error.message}`)
    } finally {
      await page.close()
    }
  }
}

await browser.close()

// A missing screenshot is worth reporting, but this is an informational preview:
// never turn a flaky capture into a blocked PR.
if (failures > 0) console.error(`${failures} capture(s) failed`)
