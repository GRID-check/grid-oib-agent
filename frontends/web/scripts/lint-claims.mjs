#!/usr/bin/env node
/**
 * Fails the check when the site says something it must not.
 *
 * Two kinds of text reached the public site before: placeholder legal data
 * ("[Firmenbuchnummer — Platzhalter]") and a promise the platform does not keep
 * (AI and data "in der EU", while model requests go through US providers).
 * Both read fine to a tired reviewer, so a pattern list holds the line instead.
 * A phrase belongs here once it has been retracted; remove it only when the
 * platform genuinely makes it true again, and say so in the PR.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = [
  [/Platzhalter|\bplaceholder\]/i, 'placeholder text on a public page'],
  // Any mention of the EU, except the factual ones the privacy policy needs.
  [/\bEU\b(?!-US Data Privacy)/, 'retracted claim: EU processing or residency', /(außerhalb|outside) (der|the) EU\b/g],
  [/jederzeit exportierbar|exportable at any time/i, 'unsupported claim: bulk export does not exist'],
  [/selben Werktag|same working day/i, 'unsupported claim: response-time promise'],
]

const ROOTS = ['src/i18n', 'src/components', 'src/content', 'src/data', 'src/pages', 'src/consts.ts']
const SKIP = /changelog\.json$|lint-claims/

function* files(path) {
  if (statSync(path).isFile()) return yield path
  for (const name of readdirSync(path)) yield* files(join(path, name))
}

let failures = 0
for (const root of ROOTS) {
  for (const file of files(root)) {
    if (SKIP.test(file) || !/\.(ts|astro|mdx|md|json)$/.test(file)) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const [pattern, why, allowed] of FORBIDDEN) {
          if (pattern.test(allowed ? line.replace(allowed, '') : line)) {
            console.error(`${file}:${i + 1}: ${why}\n    ${line.trim().slice(0, 140)}`)
            failures++
          }
        }
      })
  }
}
if (failures) {
  console.error(`\n${failures} forbidden claim(s). See scripts/lint-claims.mjs for why each is banned.`)
  process.exit(1)
}
console.log('Claims lint passed.')
