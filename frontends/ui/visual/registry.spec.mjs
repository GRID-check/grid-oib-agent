/**
 * The visual registry, gated (ledger 33).
 *
 * Three properties, each of which was true only by convention until now:
 *
 *  1. **Every registered target has its PNGs committed.** A target with no
 *     image is a claim of evidence with no evidence.
 *  2. **Every PNG belongs to a target.** An orphan is the leftover of a renamed
 *     or deleted preview, and it stays in the repo forever looking like the
 *     current state of something.
 *  3. **No PNG is older than the `/dev` route it photographs.** This is the one
 *     that actually happened: PR #631 and #634 both shipped with the harness
 *     unrun, and the `sessions*` images stopped describing the surface with
 *     nothing anywhere saying so.
 *
 * ## The mechanism for (3), and why it is a manifest
 *
 * A checksum manifest (`visual/screenshots.manifest.json`), not file mtimes and
 * not `git log`. The reasoning is in `visual/manifest.mjs`; the short version is
 * that a checkout gives every file the same mtime, and `git log` on a PNG you
 * have just re-captured still answers with the commit BEFORE the fix — so both
 * inferred mechanisms fail exactly where they have to work. The manifest records
 * the route's hash at capture time instead, and `capture.mjs` rewrites it.
 *
 * ## What the baseline means
 *
 * The manifest was bootstrapped from the tip when this gate landed, so it stops
 * the NEXT drift rather than certifying every image already committed. The
 * `sessions*` set — the one this ledger row is about — was genuinely re-captured
 * in the same change. The census of what else was stale at bootstrap is in the
 * ledger row, not here: a list in a spec is a list nobody updates.
 */

import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { SCREENSHOT_TARGETS } from './registry.mjs'
import {
  MANIFEST_PATH,
  SHOTS_DIR,
  UI_ROOT,
  hashFile,
  readManifest,
  routeFileFor,
  shotNamesFor,
} from './manifest.mjs'

const pngs = (await readdir(SHOTS_DIR)).filter((name) => name.endsWith('.png'))
const manifest = await readManifest()

describe('the screenshot registry', () => {
  test('every target id is unique', () => {
    const ids = SCREENSHOT_TARGETS.map((t) => t.id)
    expect(ids).toEqual([...new Set(ids)])
  })

  test('every target points at a /dev route that exists', () => {
    const missing = SCREENSHOT_TARGETS.filter((t) => !existsSync(routeFileFor(t.path))).map(
      (t) => `${t.id} → ${routeFileFor(t.path).slice(UI_ROOT.length + 1)}`
    )
    expect(missing).toEqual([])
  })

  test('every target has all of its PNGs committed', () => {
    // Two for a desktop-only target, four when it opts into `mobile: true` —
    // the mobile twin is a first-class surface here, not an extra.
    const have = new Set(pngs)
    const missing = SCREENSHOT_TARGETS.flatMap((target) =>
      shotNamesFor(target)
        .filter((name) => !have.has(name))
        .map((name) => `${target.id}: ${name}`)
    )
    expect(missing).toEqual([])
  })

  test('no PNG is orphaned from a target', () => {
    const expected = new Set(SCREENSHOT_TARGETS.flatMap(shotNamesFor))
    const orphans = pngs.filter((name) => !expected.has(name))
    expect(orphans).toEqual([])
  })
})

describe('the screenshot manifest — a PNG may not outlive its route', () => {
  test('the manifest exists and covers every target', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true)
    const unrecorded = SCREENSHOT_TARGETS.filter((t) => !manifest.targets[t.id]).map((t) => t.id)
    expect(unrecorded).toEqual([])
  })

  test('every recorded route hash still matches the route on disk', async () => {
    const stale = []
    for (const target of SCREENSHOT_TARGETS) {
      const entry = manifest.targets[target.id]
      if (!entry) continue
      const file = routeFileFor(target.path)
      if (!existsSync(file)) continue
      if ((await hashFile(file)) !== entry.routeHash) stale.push(target.id)
    }
    // The remedy is one command, so it is named in the failure rather than left
    // for the reader to work out from a hash mismatch.
    expect(
      stale,
      `these previews changed since their screenshots were taken — re-run:\n` +
        `  cd frontends/ui && bun run screenshots -- ${stale.join(' ')}`
    ).toEqual([])
  })

  test('the manifest names no target the registry has dropped', () => {
    const known = new Set(SCREENSHOT_TARGETS.map((t) => t.id))
    expect(Object.keys(manifest.targets).filter((id) => !known.has(id))).toEqual([])
  })

  test('every recorded route path is inside the /dev tree', () => {
    // A manifest is a file a hand can edit; this is the one thing it may not be
    // edited INTO — a hash of something that is not the preview.
    const outside = Object.entries(manifest.targets)
      .filter(([, entry]) => !entry.route?.startsWith('src/app/dev/'))
      .map(([id]) => id)
    expect(outside).toEqual([])
  })

  test('the recorded shot list agrees with the registry', () => {
    const wrong = SCREENSHOT_TARGETS.filter((target) => {
      const entry = manifest.targets[target.id]
      return entry && entry.shots.join('|') !== shotNamesFor(target).join('|')
    }).map((t) => t.id)
    expect(wrong).toEqual([])
  })

  test('the shots dir holds nothing but PNGs and its own README', async () => {
    const strays = (await readdir(SHOTS_DIR)).filter(
      (name) => !name.endsWith('.png') && name !== 'README.md'
    )
    expect(strays).toEqual([])
  })
})
