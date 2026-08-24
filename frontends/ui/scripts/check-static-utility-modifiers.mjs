#!/usr/bin/env node
/**
 * Guard: a static `@utility` can never take a slash-opacity modifier.
 *
 * `src/app/globals.css` declares the design-system colour classes as Tailwind v4
 * `@utility <name> { … }` blocks. A block that does not call `--modifier(…)` is a
 * STATIC utility: Tailwind matches the class name literally, so `bg-warning/15` or
 * `border-info/40` matches no rule at all and is dropped from the stylesheet.
 * Nothing warns — the element simply renders with no fill, or with whatever border
 * colour the base layer left on it, and the mistake survives review because the
 * class name looks exactly like a working Tailwind class.
 *
 * The utility names are read out of globals.css at check time, so the guard tracks
 * the design system instead of a hardcoded list, and a utility that later grows a
 * real `--modifier()` stops being reported the moment it does.
 *
 * Run: `node scripts/check-static-utility-modifiers.mjs` (wired into `bun run lint`).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GLOBALS_CSS = 'src/app/globals.css'
const SCAN_ROOT = 'src'
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css'])

/**
 * Violations that predate this guard — deliberately EMPTY, and worth the effort
 * of keeping it that way.
 *
 * A guard with a baseline reports "clean" while the thing it guards against is
 * still on screen, and nobody reads a baseline entry twice. The single entry
 * this shipped with was `border-base/60` on a dev preview page: a dashed border
 * that silently fell back to the default colour, and a one-word fix rather than
 * an exception worth carrying.
 *
 * If an entry ever does belong here, it is per-occurrence rather than a
 * directory exclusion on purpose: every other slash-on-static-utility in
 * `src/**` — including anything new under the same path — still fails. And the
 * `stale` result below makes an entry that no longer matches an error in its own
 * right, so the list cannot quietly outlive the defect it documents.
 */
const KNOWN_VIOLATIONS = []

/**
 * Blank out comment bodies while preserving every byte offset and newline, so
 * line/column numbers stay true and prose that merely *mentions* a broken class
 * (a code comment explaining this very defect) is not reported as one.
 *
 * String and template literals are deliberately left intact — that is where class
 * names actually live — and are tracked only so a `//` inside `'https://…'` is not
 * mistaken for a comment.
 *
 * `lineComments: false` is for CSS, where `//` is not a comment at all: blanking
 * it would swallow the rest of a line holding an unquoted `url(https://…)`.
 */
export function blankComments(source, { lineComments = true } = {}) {
  const out = source.split('')
  let i = 0
  let quote = null // "'" | '"' | '`' when inside a string/template literal

  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]

    if (quote) {
      if (ch === '\\') i += 2
      else {
        if (ch === quote) quote = null
        i += 1
      }
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      i += 1
      continue
    }

    if (lineComments && ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out[i++] = ' '
      continue
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      while (i < stop) {
        if (source[i] !== '\n') out[i] = ' '
        i += 1
      }
      continue
    }

    i += 1
  }

  return out.join('')
}

/**
 * Names of `@utility` blocks in globals.css whose body never calls `--modifier(…)`.
 * Functional utilities (`@utility foo-*`) are skipped: their name is a pattern, not
 * a literal class, and Tailwind resolves their modifiers itself.
 */
export function parseStaticUtilities(css) {
  const names = []
  // Comments are blanked first: a commented-out `--modifier(…)` inside a static
  // block would exempt the utility and blind the guard, and a commented-out
  // `@utility foo {` would declare one that does not exist.
  const scannable = blankComments(css, { lineComments: false })
  const declaration = /@utility\s+([a-zA-Z0-9_-]+(?:-\*)?)\s*\{/g

  for (const match of scannable.matchAll(declaration)) {
    const name = match[1]
    if (name.endsWith('-*')) continue

    // Walk to the block's matching close brace so nested rules (@media, &:hover)
    // do not truncate the body we search for `--modifier(`.
    let depth = 0
    let i = match.index + match[0].length - 1
    const start = i
    for (; i < scannable.length; i += 1) {
      if (scannable[i] === '{') depth += 1
      else if (scannable[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }

    if (!scannable.slice(start, i).includes('--modifier(')) names.push(name)
  }

  return names
}

/**
 * Any class-shaped token carrying a slash modifier. The utility names are matched
 * in JavaScript afterwards rather than interpolated into the pattern: a literal
 * regex keeps the SAST pipeline's "no dynamic RegExp" rule satisfied without an
 * exception, and the greedy `[a-zA-Z0-9_-]+` already takes the longest token, so
 * `bg-info-subtle/40` is read as `bg-info-subtle` and never as `bg-info`.
 *
 * The left boundary rejects a longer identifier or a path segment; the modifier is
 * a bare number/percentage or an arbitrary `[…]` value, matching Tailwind's syntax.
 */
const CLASS_WITH_MODIFIER = /(?<![a-zA-Z0-9_./-])([a-zA-Z0-9_-]+)\/(\[[^\]\s]+\]|\d+(?:\.\d+)?%?)/g

export function findViolations(source, utilityNames) {
  if (utilityNames.length === 0) return []

  const scannable = blankComments(source)
  const statics = new Set(utilityNames)
  const lineStarts = [0]
  for (let i = 0; i < scannable.length; i += 1) {
    if (scannable[i] === '\n') lineStarts.push(i + 1)
  }

  const violations = []
  for (const match of scannable.matchAll(CLASS_WITH_MODIFIER)) {
    if (!statics.has(match[1])) continue
    let line = lineStarts.length - 1
    while (line > 0 && lineStarts[line] > match.index) line -= 1
    violations.push({
      line: line + 1,
      column: match.index - lineStarts[line] + 1,
      className: match[0],
      utility: match[1],
    })
  }

  return violations
}

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      collectFiles(full, out)
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/** @returns {{ unexpected: Array, stale: Array }} */
export function run({ root = UI_ROOT, knownViolations = KNOWN_VIOLATIONS } = {}) {
  const utilityNames = parseStaticUtilities(fs.readFileSync(path.join(root, GLOBALS_CSS), 'utf8'))
  const unmatchedBaseline = new Set(knownViolations.map((v) => `${v.file}\u0000${v.className}`))
  const unexpected = []

  for (const file of collectFiles(path.join(root, SCAN_ROOT))) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    for (const violation of findViolations(fs.readFileSync(file, 'utf8'), utilityNames)) {
      const key = `${relative}\u0000${violation.className}`
      if (unmatchedBaseline.has(key)) unmatchedBaseline.delete(key)
      else unexpected.push({ ...violation, file: relative })
    }
  }

  const stale = [...unmatchedBaseline].map((key) => {
    const [file, className] = key.split('\u0000')
    return { file, className }
  })

  return { unexpected, stale }
}

function main() {
  const { unexpected, stale } = run()

  for (const v of unexpected) {
    console.error(
      `${v.file}:${v.line}:${v.column}  \`${v.className}\` — \`${v.utility}\` is a static @utility in ` +
        `${GLOBALS_CSS} with no \`--modifier()\`, so this class compiles to nothing and the element ` +
        `renders unstyled. Use \`${v.utility}\` (or its \`-subtle\` variant), or give the utility a ` +
        `\`--modifier(--alpha(…))\` if a real alpha is wanted.`
    )
  }

  for (const v of stale) {
    console.error(
      `KNOWN_VIOLATIONS in scripts/check-static-utility-modifiers.mjs lists \`${v.className}\` in ` +
        `${v.file}, but it is no longer there. Delete the entry.`
    )
  }

  if (unexpected.length || stale.length) {
    console.error(
      `\n✖ static-utility modifier check failed (${unexpected.length + stale.length} problem(s))`
    )
    process.exit(1)
  }

  console.log('✔ no slash modifiers on static @utility classes')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
