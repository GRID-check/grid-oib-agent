#!/usr/bin/env node
/**
 * Fails the check on typography a German reader notices at once and a tired
 * reviewer does not: the English spaced em dash where German sets a spaced en
 * dash, „a quote closed with a straight one", straight quotes in German blog
 * prose, and a number torn from its unit at a line break ("30" / "s").
 *
 * It reads the dictionary (src/i18n/ui.ts, both locales, comments skipped) and
 * the blog posts (prose lines only: MDX component attributes use straight
 * quotes as syntax).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RULES = [
  [/ — /, 'spaced em dash: use a spaced en dash " – " (or rewrite the sentence)'],
  [/„[^“\n]*["”]/, 'German quote closed with the wrong mark: „…“'],
  [/(\d) (%|€|cm|mm|m²|s)(?![\wäöü])/, 'number and unit split by a normal space: use \\u00a0'],
  [/§ \d/, '"§ 106" needs a no-break space: §\\u00a0106'],
]
const DE_PROSE = [[/"/, 'straight quote in German prose: use „…“']]

let failures = 0
const report = (file, i, why, line) => {
  console.error(`${file}:${i + 1}: ${why}\n    ${line.trim().slice(0, 140)}`)
  failures++
}
const check = (file, lines, rules, skip = () => false) =>
  lines.forEach((line, i) => {
    if (skip(line)) return
    for (const [pattern, why] of rules) if (pattern.test(line)) report(file, i, why, line)
  })

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line)

const dict = 'src/i18n/ui.ts'
check(dict, readFileSync(dict, 'utf8').split('\n'), RULES, isComment)

const blog = 'src/content/blog'
for (const locale of readdirSync(blog)) {
  if (!['de', 'en'].includes(locale)) continue
  for (const name of readdirSync(join(blog, locale))) {
    if (!name.endsWith('.mdx')) continue
    const file = join(blog, locale, name)
    const body = readFileSync(file, 'utf8').split(/^---$/m).slice(2).join('---').split('\n')
    // Prose starts at column 0; component props are indented or open a tag.
    const notProse = (line) => /^(\s|<|import |export |\{)/.test(line) || line === ''
    check(file, body, locale === 'de' ? [...RULES, ...DE_PROSE] : RULES, notProse)
  }
}

if (failures) {
  console.error(`\n${failures} typography issue(s). See scripts/lint-typography.mjs.`)
  process.exit(1)
}
console.log('Typography lint passed.')
