#!/usr/bin/env node
/**
 * Fails the check when a text colour token drops below WCAG AA on a background
 * it is actually set on.
 *
 * The quiet greys used to be tuned by eye, and the sentences that keep the site
 * honest ("Fiktives Beispiel", the price disclaimer) ended up the least legible
 * text on the page at 2.3:1. The pairs below are the ones the components use;
 * add a pair when a component puts a token on a new background.
 */
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8')
const token = (name) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))
  if (!m) throw new Error(`token --color-${name} not found in global.css`)
  return m[1]
}

const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const LIGHT = ['canvas', 'paper', 'surface', 'surface-dim']
/** [text token, background tokens] — every pair must reach 4.5:1. */
const PAIRS = [
  ['ink-soft', [...LIGHT, 'hero-bg', 'tint']],
  ['ink-mute', [...LIGHT, 'hero-bg', 'tint']],
  ['ink-faint', [...LIGHT, 'hero-bg']],
  ['ink-ghost', [...LIGHT, 'hero-bg']],
  ['accent-600', [...LIGHT, 'hero-bg']],
  ['accent-700', ['tint']],
  ['ok', ['paper', 'chip-project']],
  ['chip-project-ink', ['chip-project']],
  ['chip-law-ink', ['chip-law']],
  ['on-dark', ['panel', 'accent-900']],
  ['on-dark-label', ['panel', 'accent-900']],
  ['on-dark-tag', ['panel', 'accent-900']],
]

let failures = 0
for (const [fg, bgs] of PAIRS) {
  for (const bg of bgs) {
    const r = ratio(token(fg), token(bg))
    if (r < 4.5) {
      console.error(`--color-${fg} on --color-${bg}: ${r.toFixed(2)}:1, needs 4.5:1`)
      failures++
    }
  }
}
if (failures) {
  console.error(`\n${failures} text/background pair(s) below WCAG AA. See scripts/lint-contrast.mjs.`)
  process.exit(1)
}
console.log('Contrast lint passed.')
