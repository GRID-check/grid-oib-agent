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
  // Retracted in the copy review of September 2026: each overstated what the
  // product does or what we have measured.
  [/gesamte Wissen|all the knowledge/i, 'unprovable claim: "all" the knowledge'],
  [/Stunden Suche|hours of searching/i, 'unmeasured claim: only the ≈30 s answer time is measured'],
  [/Standort offen|location disclosed/i, 'unsupported claim: provider locations are not listed'],
  [/\b(Die KI-Plattform|The AI platform)\b|ist die KI-Wissensplattform|is the AI knowledge platform/, 'category claim: say "eine" / "an"'],
  [/jede Aussage lässt sich bis|every statement can be traced|(zu|für) jede[rn]? Aussage die (Quelle|Fundstelle)|(source|citation)s? (of|for) every statement|check every statement/i, 'unsupported claim: an answer cites its sources, not every statement its origin'],
  [/Piloti (kennt|versteht)\b|Piloti (knows|understands)\b/, 'anthropomorphic claim: say what Piloti works with'],
  // A file is a Dokument, Datei or Unterlage; "plan" names a drawing or a legal
  // instrument, and nothing knows a file is one until its Dokumentart says so
  // (CONTEXT.md, Fassung). Compounds (Bebauungsplan, Lageplan) are not standalone
  // words and pass without an entry. The allowed phrases are drawing types and
  // legal instruments (floor plan, zoning plan), research and subscription
  // plans, the hero's "Plan more", and code keys such as `plan:` or `plan.line`.
  [/(?<![\p{L}\-.])(plans?|pläne|plänen)(?![\p{L}\-])(?!\s*[:=])(?!\.[\p{L}_])/iu,
    'a file called a plan: say Dokument, Datei, Unterlage or Zeichnung',
    /\bPlan more\b|\b(zoning|development|land-use|floor|site|roof|research|monthly|subscription|pricing) plans?\b|\bplan (and section|chest)\b|\bplan symbols\b/giu],
  // Retracted in October 2026: pages stated which OIB edition Piloti's corpus
  // holds and called its values mere pointers. Nobody on the site's side knows
  // what the corpus holds at a given time; say what Piloti does instead.
  [/\b(Korpus|corpus)\b|Hinweis, bis (Sie|er|man)|pointer until/i, 'unverified claim about what Piloti\'s corpus holds'],
]

const ROOTS = ['src/i18n', 'src/components', 'src/content', 'src/data', 'src/pages', 'src/lib', 'src/layouts', 'src/consts.ts']
// The changelog is history. art.json is the riso manifest: its alt text
// describes what a picture shows, a drawn plan included, and it is generated.
const SKIP = /changelog\.json$|art\.json$|lint-claims/

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
        // Comments explain why a claim is gone; only what renders is checked.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
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
