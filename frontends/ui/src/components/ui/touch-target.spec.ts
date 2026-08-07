/**
 * The touch-target contract.
 *
 * Every control in the app is sized for a finger on ONE axis — `pointer-coarse`
 * — either by growing (the `size` variants on Button and friends) or by widening
 * its catchment with the `touch-target` utility. Both halves fail SILENTLY:
 *
 *  - A `touch-target` class whose `@utility` is missing or misspelled renders a
 *    perfectly normal-looking control with a 16px hit area. Nothing warns. That
 *    is not hypothetical — during this work the class sat in the markup while
 *    the rule was absent from the stylesheet, and the only way to notice was to
 *    measure the rendered `::after` in a browser.
 *  - A `md:`-based touch size looks right on a phone and leaves a tablet past
 *    the breakpoint with mouse-sized targets, because viewport width is not
 *    what a fingertip depends on.
 *
 * So these assert the wiring rather than the pixels: the utility exists and is
 * scoped to coarse pointers, every use of it resolves, and the shared control
 * primitives each still carry a coarse-pointer affordance. Pixel evidence is
 * the screenshot harness's job (`visual/screenshots/*.mobile.*.png`).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..')
const GLOBALS_CSS = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(tsx?|css)$/.test(entry)) out.push(path)
  }
  return out
}

const SOURCE_FILES = walk(SRC)

describe('touch-target utility', () => {
  it('is declared in globals.css', () => {
    expect(GLOBALS_CSS).toMatch(/@utility\s+touch-target\s*\{/)
  })

  it('only applies under a coarse pointer, so a mouse keeps the visible box', () => {
    const body = GLOBALS_CSS.split(/@utility\s+touch-target\s*\{/)[1] ?? ''
    // Everything up to the utility's closing brace — enough to see the guard.
    expect(body.slice(0, body.indexOf('\n}'))).toMatch(/@media\s*\(pointer:\s*coarse\)/)
  })

  it('reaches the 44px floor a fingertip needs', () => {
    const body = GLOBALS_CSS.split(/@utility\s+touch-target\s*\{/)[1] ?? ''
    const decl = body.slice(0, body.indexOf('\n}'))
    expect(decl).toMatch(/width:\s*max\(100%,\s*44px\)/)
    expect(decl).toMatch(/height:\s*max\(100%,\s*44px\)/)
  })

  it('has no near-miss spellings anywhere in src — those render a silent 16px target', () => {
    const typos: string[] = []
    for (const file of SOURCE_FILES) {
      if (file.endsWith('globals.css') || file.endsWith('touch-target.spec.ts')) continue
      for (const match of readFileSync(file, 'utf8').matchAll(/\btouch-target[\w-]+/g)) {
        typos.push(`${file.slice(SRC.length + 1)}: ${match[0]}`)
      }
    }
    expect(typos).toEqual([])
  })
})

describe('touch sizing uses one axis', () => {
  it('sizes targets on pointer-coarse, never on the md breakpoint', () => {
    // `md:` is for LAYOUT. A `md:`-reverted touch SIZE is the two-axis drift
    // this work removed: it leaves a touch tablet past `md` on mouse-sized
    // controls. Matches the shapes the old sites actually used.
    const offenders: string[] = []
    for (const file of SOURCE_FILES) {
      if (file.endsWith('touch-target.spec.ts')) continue
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/\bmd:(?:min-h-0|size-7|h-8|min-h-11|size-11|h-11)\b/g)) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('control primitives carry a coarse-pointer touch size', () => {
  // Each of these is a control a finger drives directly, and each was under the
  // 44px floor before this work — see the audit numbers in the commit message.
  it.each([
    ['button.tsx'],
    ['input.tsx'],
    ['select.tsx'],
    ['tabs.tsx'],
    ['dropdown-menu.tsx'],
    ['dialog.tsx'],
    ['sheet.tsx'],
    ['checkbox.tsx'],
    ['switch.tsx'],
    ['chip.tsx'],
  ])('%s', (file) => {
    const source = readFileSync(join(SRC, 'components', 'ui', file), 'utf8')
    expect(source).toMatch(/pointer-coarse:|touch-target/)
  })

  it('gives Button a floor on both axes — height alone leaves icon buttons narrow', () => {
    const source = readFileSync(join(SRC, 'components', 'ui', 'button.tsx'), 'utf8')
    expect(source).toMatch(/pointer-coarse:h-11/)
    expect(source).toMatch(/pointer-coarse:size-11/)
    expect(source).toMatch(/pointer-coarse:min-w-11/)
  })
})
