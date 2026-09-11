/**
 * The screenshot manifest — what makes a stale PNG a FAILING test rather than
 * something a reviewer has to notice (ledger 33).
 *
 * ## The problem
 *
 * PR #631 and #634 both shipped with `task fe:screenshots` unrun (bun was
 * unavailable in that session), so the committed `sessions*` PNGs stopped
 * describing the surface and nothing said so. Everything in the visual system
 * up to here checks that evidence EXISTS; nothing checked that it is evidence
 * of the current thing.
 *
 * ## Why a manifest and not mtimes
 *
 * The obvious gate is "the PNG is newer than its `/dev` route". It cannot be
 * built, twice over:
 *
 *  - **mtime does not survive git.** A checkout writes every file at checkout
 *    time, so on a CI runner every PNG and every route are the same age. The
 *    comparison is meaningless exactly where it has to run.
 *  - **`git log` does not survive the working tree.** Re-capturing a PNG leaves
 *    it MODIFIED, and `git log -1 -- <png>` still answers with the commit
 *    before the re-capture. The gate would fail on the branch that fixes it and
 *    pass once it is committed, which is precisely backwards. (It also needs
 *    full history, and not every CI job checks out with `fetch-depth: 0`.)
 *
 * So the freshness fact is RECORDED at capture time instead of inferred later:
 * `visual/screenshots.manifest.json` holds, per target, the SHA-256 of the
 * `/dev` route source file as it was when the harness rendered it. Change the
 * route and the hash no longer matches; the spec fails until the harness runs
 * again and rewrites the entry. It is content-addressed, so it works in a
 * shallow clone, on an untracked file, and in whatever order the commits land.
 *
 * ## What it does not cover, stated plainly
 *
 * The route file is one input; the components it renders are others. Hashing
 * the whole import graph would gate every target on every shared-atom edit and
 * be ignored within a week. The route is what the harness actually loads and
 * the file a preview change lands in, so it is the honest unit — and the
 * `visual-coverage` workflow already covers the other half (a NEW component
 * arriving without a preview at all).
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const UI_ROOT = join(HERE, '..')
export const SHOTS_DIR = join(HERE, 'screenshots')
export const MANIFEST_PATH = join(HERE, 'screenshots.manifest.json')

/** Themes every shot is captured in. Mirrors `capture.mjs`. */
export const THEMES = ['light', 'dark']

/**
 * The source file behind a registry `path`.
 *
 * `/dev/herleitung?variant=spine` and `/dev/herleitung` are one route and one
 * file: the query string selects a fixture inside the page, so two targets that
 * differ only by variant share a hash, which is correct — a change to that page
 * invalidates both of their shots.
 */
export function routeFileFor(path) {
  const clean = String(path).split('?')[0].split('#')[0].replace(/\/+$/, '')
  return join(UI_ROOT, 'src', 'app', clean, 'page.tsx')
}

/** The PNG filenames a target is expected to have committed. */
export function shotNamesFor(target) {
  const names = THEMES.map((theme) => `${target.id}.${theme}.png`)
  if (target.mobile) names.push(...THEMES.map((theme) => `${target.id}.mobile.${theme}.png`))
  return names
}

export async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

export async function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return { version: 1, targets: {} }
  try {
    const parsed = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
    return { version: 1, targets: parsed?.targets ?? {} }
  } catch {
    // A manifest that cannot be parsed is a manifest that records nothing; the
    // spec then reports every target as unrecorded, which is the truth.
    return { version: 1, targets: {} }
  }
}

/**
 * Merge freshly captured targets into the manifest, leaving every other entry
 * exactly as it was.
 *
 * MERGE and not replace, because `npm run screenshots -- sessions` is the
 * normal way to run this: a partial capture must not claim the other hundred
 * and sixty targets were re-shot.
 */
export async function recordCaptured(targets) {
  const manifest = await readManifest()
  for (const target of targets) {
    const routeFile = routeFileFor(target.path)
    manifest.targets[target.id] = {
      route: routeFile.slice(UI_ROOT.length + 1).split('\\').join('/'),
      routeHash: await hashFile(routeFile),
      shots: shotNamesFor(target),
    }
  }
  // Deliberately no timestamp: a date would be the one field a bootstrap could
  // not fill in truthfully, and the hash already says everything the gate needs.
  const ordered = Object.fromEntries(
    Object.keys(manifest.targets)
      .sort()
      .map((id) => [id, manifest.targets[id]])
  )
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify({ version: 1, note: MANIFEST_NOTE, targets: ordered }, null, 2)}\n`,
    'utf-8'
  )
  return ordered
}

const MANIFEST_NOTE =
  'Generated by visual/capture.mjs. routeHash is the SHA-256 of the /dev route source ' +
  'as it was when that target was last captured; visual/registry.spec.mjs fails when it ' +
  'no longer matches. Do not hand-edit — re-run `bun run screenshots -- <id>` instead.'
