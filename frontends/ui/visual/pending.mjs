/**
 * Prints the screenshot targets that need (re-)capturing: missing PNGs, a
 * `/dev` route changed since its last capture, or a target never captured.
 *
 * Used by `.github/workflows/screenshot-preview.yml` to decide what to capture
 * and commit back on a same-repo PR, so a stale or missing image is healed by
 * CI instead of failing `fe:test` with no remedy a contributor can run where
 * screenshots are unavailable. Reads only `node:` modules and the registry —
 * no dependencies, no browser.
 *
 * Ids are filtered to the registry's safe shape before they leave this process:
 * the workflow interpolates them into shell commands, filename globs and a
 * comment body.
 */

import { pendingCaptures } from './manifest.mjs'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ids = (await pendingCaptures()).filter((id) => SAFE_ID.test(id))
process.stdout.write(ids.join(' '))
