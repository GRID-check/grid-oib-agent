#!/usr/bin/env node
/**
 * Holds the site to `shared/public-site.json`, the public URLs other services
 * put in front of people: the app's settings card links the mail inbox help
 * page, and the Worker's bounce text links it and the privacy policy. A copy
 * of such a bounce stays in somebody's mailbox for years, so these paths may
 * not move.
 *
 * The site cannot import the file: its Docker build sees only
 * `frontends/web`, like `build-brand-assets.mjs` says. So `src/consts.ts`
 * keeps its own literal, and this check (run by `npm run check`) fails when
 * that literal, the site's default origin, or the page behind a path drifts
 * from the contract. The app holds its copy to the same file in
 * `frontends/ui/src/lib/brand.spec.ts`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const contract = JSON.parse(readFileSync(resolve(webRoot, '../../shared/public-site.json'), 'utf8'))

const failures = []

const consts = readFileSync(resolve(webRoot, 'src/consts.ts'), 'utf8')
const slug = /export const MAIL_INBOX_SLUG = '([^']+)'/.exec(consts)?.[1]
if (`/${slug}/` !== contract.paths.mailInbox) {
  failures.push(`src/consts.ts MAIL_INBOX_SLUG is '${slug}', the contract says ${contract.paths.mailInbox}`)
}

const config = readFileSync(resolve(webRoot, 'astro.config.mjs'), 'utf8')
if (!config.includes(`site: process.env.PUBLIC_SITE_URL || '${contract.origin}'`)) {
  failures.push(`astro.config.mjs does not default \`site\` to ${contract.origin}`)
}

// A path the contract names must be a page, in both locales. The mail inbox
// page is a `[mailInbox]` route fed by the slug checked above.
for (const [name, path] of Object.entries(contract.paths)) {
  if (!/^\/[a-z0-9-]+\/$/.test(path)) failures.push(`${name}: ${path} is not a one-segment ASCII path`)
  if (name === 'mailInbox') continue
  for (const dir of ['src/pages', 'src/pages/en']) {
    const page = resolve(webRoot, dir, `${path.slice(1, -1)}.astro`)
    if (!existsSync(page)) failures.push(`${name}: no page at ${dir}${path.slice(0, -1)}.astro`)
  }
}

if (failures.length > 0) {
  console.error('check-public-site: the site drifted from shared/public-site.json')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('check-public-site: ok')
