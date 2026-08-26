/**
 * The two mobile contracts `touch-target.spec.ts` cannot see.
 *
 * That file guards the SIZE of the shared control primitives, and it guards it
 * well — but it only looks at `components/ui/*`, and this pass found that
 * everything customers actually press in an answer is a bespoke control in
 * `features/`: the citation marker, the mention pill, the source row in the
 * Herleitung, the disclosure under a card. None of them was reachable by a
 * spec that reads the primitives, so none of them was ever checked.
 *
 * Pixels still belong to the browser — `visual/touch-audit.mjs` measures those,
 * and it is what produced the numbers in this pass. What can be held HERE is the
 * two failure modes that are visible in the source and invisible on a desktop:
 *
 *  1. A control revealed by hover, with no other way in. On a mouse it is a
 *     tasteful reveal; on a phone there is no hover event to spend, so the
 *     control is mounted, focusable, and permanently invisible. It does not look
 *     broken in review, in a desktop screenshot, or in a jsdom test — the markup
 *     is right and the element is there. Copying your own message was desktop-only
 *     for as long as that button existed.
 *
 *  2. A text field under 16px. iOS Safari zooms the whole page in when one takes
 *     focus and does NOT zoom back out on blur, so a 14px rename field leaves the
 *     reader magnified and scrolled sideways inside the surface they were reading.
 *     Every raw `<input>` has to carry the floor itself, and three did not — and
 *     the floor is on the POINTER axis, because the version of it built out of a
 *     viewport breakpoint (`text-base … md:text-sm`) is not a floor at all: past
 *     the breakpoint a coarse-pointer tablet renders 14px and zooms exactly as a
 *     phone would. Both halves are asserted below.
 *
 * Both are asserted against the SOURCE for the same reason `touch-target.spec.ts`
 * asserts wiring rather than pixels: these are cheap invariants that hold on every
 * commit, and the expensive measurement is one command away when it is wanted.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { blankComments } from '../../../scripts/check-static-utility-modifiers.mjs'

const SRC = join(__dirname, '..', '..')

/**
 * Read a source file with its COMMENT BODIES BLANKED.
 *
 * Every rule below matches on class strings, and a comment explaining one of
 * these defects contains the defect's own class names — so scanning raw source
 * makes the documentation fail the check that the documentation is about. It did:
 * the note in `input.tsx` saying "this was `text-base … md:text-sm`" was reported
 * as a `md:text-sm`.
 *
 * `blankComments` is the repo's existing solution to exactly this, already
 * exported by `scripts/check-static-utility-modifiers.mjs`. It preserves byte
 * offsets and leaves string literals alone, which is where class names live.
 */
const readCode = (file: string): string => blankComments(readFileSync(file, 'utf8')) as string

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const SOURCE_FILES = walk(SRC).filter((f) => !f.endsWith('mobile-affordances.spec.ts'))

const relative = (file: string): string => file.slice(SRC.length + 1)

/**
 * Every region of a file that resolves to ONE element's class list: a balanced
 * `cn(…)` call, or a plain `className="…"` attribute.
 *
 * Deliberately not "every string literal". A class list is routinely split across
 * several `cn()` arguments — one line for layout, one for state, one for the
 * touch escape — and a literal-scoped rule reads each of those as a separate
 * control. It fails the very fix it is asking for, which is how this function
 * came to exist: the first version of this spec flagged the copy button whose
 * `pointer-coarse:opacity-100` sat one argument below its `opacity-0`.
 */
const classRegions = (source: string): string[] => {
  const regions: string[] = []
  for (const match of source.matchAll(/\bcn\(/g)) {
    let depth = 0
    let i = match.index + match[0].length - 1
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    regions.push(source.slice(match.index, i + 1))
  }
  for (const match of source.matchAll(/className=(?:"([^"]*)"|'([^']*)')/g)) {
    regions.push(match[1] ?? match[2] ?? '')
  }
  return regions
}

describe('a hover reveal always has a second way in', () => {
  /**
   * `opacity-0` + `group-hover:opacity-100` in one class list is a control whose
   * entire affordance is the mouse. It needs one of:
   *
   *  - `pointer-coarse:opacity-100` — present where a finger drives the pointer,
   *    which is the escape `project-memory-panel` established; or
   *  - `md:opacity-0` — the mobile-first inversion, where the control is simply
   *    visible below the breakpoint and only hides itself on a desktop.
   *
   * `focus-visible:opacity-100` is NOT one of them: it answers for the keyboard,
   * and a touch device has neither hover nor a tab key.
   */
  it('never hides a control behind hover alone', () => {
    const offenders: string[] = []
    for (const file of SOURCE_FILES) {
      for (const region of classRegions(readCode(file))) {
        if (!region.includes('group-hover:opacity-100')) continue
        // `md:opacity-0` is the inversion, and it also contains `opacity-0` —
        // match the bare utility only.
        if (!/(?:^|[\s'"])opacity-0(?:[\s'"]|$)/.test(region)) continue
        if (region.includes('pointer-coarse:opacity-100')) continue
        if (region.includes('md:opacity-0')) continue
        offenders.push(`${relative(file)}: ${region.slice(0, 100).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('no text field invites the iOS zoom', () => {
  /**
   * Raw `<input>` / `<textarea>` only. The primitives already carry the floor and
   * are covered by their own assertions; what this catches is the element written
   * by hand in a feature, which inherits nothing.
   *
   * Exempt: fields with no visible text of their own — `type="file"`, `type="range"`,
   * `type="checkbox"`, `type="radio"`, and anything `sr-only`/`hidden`. A file
   * input's font size is the label's problem, not the keyboard's.
   */
  const TYPED_TAG = /<(input|textarea)\b[\s\S]*?(?:\/>|>)/g
  const EXEMPT_TYPE = /type=(?:"|')(?:file|range|checkbox|radio|hidden)(?:"|')|type=\{'(?:file|range)'\}/
  const VISUALLY_GONE = /className=(?:"|')(?:[^"']*\s)?(?:sr-only|hidden)(?:\s[^"']*)?(?:"|')/

  it('gives every hand-written field a 16px floor where a soft keyboard is likely', () => {
    const offenders: string[] = []
    for (const file of SOURCE_FILES) {
      if (file.endsWith('.spec.tsx') || file.endsWith('.test.tsx')) continue
      const source = readCode(file)
      for (const match of source.matchAll(TYPED_TAG)) {
        const tag = match[0]
        if (EXEMPT_TYPE.test(tag) || VISUALLY_GONE.test(tag)) continue
        // Under 16px…
        if (!/\btext-(?:xs|sm|\[1[0-5](?:\.\d+)?px\])\b/.test(tag)) continue
        // …unless the field also raises itself back to 16px on a coarse pointer.
        if (/\bpointer-coarse:text-base\b/.test(tag)) continue
        offenders.push(`${relative(file)}: ${tag.slice(0, 90).replace(/\s+/g, ' ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * THE FLOOR IS ON THE POINTER AXIS, NOT A BREAKPOINT — and this is the half
   * that got missed the first time.
   *
   * `text-base … md:text-sm` looks like a floor and is not one: past the
   * breakpoint the override wins, so a coarse-pointer TABLET renders 14px and
   * iOS zooms exactly as it would have on a phone. The bug is invisible in
   * review because the `text-base` is right there in the class list.
   *
   * A field may only step down below 16px on `pointer-fine:`, where no soft
   * keyboard can appear. Width never re-enables the zoom.
   */
  it('never rebuilds the floor out of a viewport breakpoint', () => {
    const offenders: string[] = []
    const BREAKPOINT_SHRINK = /\b(?:sm|md|lg|xl|2xl):text-(?:xs|sm|\[1[0-5](?:\.\d+)?px\])\b/g
    for (const file of SOURCE_FILES) {
      if (file.endsWith('.spec.tsx') || file.endsWith('.test.tsx')) continue
      const source = readCode(file)
      for (const match of source.matchAll(TYPED_TAG)) {
        const tag = match[0]
        if (EXEMPT_TYPE.test(tag) || VISUALLY_GONE.test(tag)) continue
        for (const shrink of tag.match(BREAKPOINT_SHRINK) ?? []) {
          offenders.push(`${relative(file)}: ${shrink}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the shared field primitives raise themselves on a coarse pointer', () => {
    // These three are what every other field inherits from, so the floor holding
    // here is most of the coverage. `select.tsx` is a button rather than a text
    // field and cannot zoom on its own — it carries the same step so a select and
    // an input standing side by side are never two different sizes.
    for (const file of ['input.tsx', 'textarea.tsx', 'select.tsx']) {
      const source = readCode(join(SRC, 'components', 'ui', file))
      expect(source, file).toContain('pointer-coarse:text-base')
      expect(source, file).not.toMatch(/\bmd:text-sm\b/)
    }
  })
})

describe('no library stylesheet keeps the page scroll', () => {
  /**
   * The reasoning graph is built on React Flow, whose stylesheet sets
   * `touch-action: none` on `.react-flow__pane` unconditionally — a graph
   * normally owns pan and pinch. Ours owns neither: `panOnDrag`, `panOnScroll`,
   * `zoomOnScroll`, `zoomOnPinch` and `zoomOnDoubleClick` are all false. CSS does
   * not know that, and the browser decides a gesture by intersecting
   * `touch-action` across every ancestor, so the declaration stranded the entire
   * graph — 877px of it, measured on an 844px screen. A finger anywhere on the
   * Herleitung moved nothing, and taps kept working, so it read as the page
   * being frozen.
   *
   * Three assertions, because the override has three ways to die quietly: the
   * class comes off the element, the rule comes out of the stylesheet, or
   * upstream fixes the default and the override becomes a lie nobody rereads.
   */
  const FLOW = join(SRC, 'features', 'chat', 'components', 'reasoning', 'ReasoningFlow.tsx')

  it('the reasoning graph opts into the override', () => {
    const source = readCode(FLOW)
    expect(source).toContain('reasoning-flow-scrollable')
    // The override is only defensible while the graph really does own no
    // gestures. If one of these is ever turned on, the pane needs its
    // `touch-action` back and this spec should fail rather than let a pan and a
    // page scroll fight over the same finger.
    for (const prop of ['panOnDrag', 'panOnScroll', 'zoomOnScroll', 'zoomOnPinch']) {
      expect(source).toMatch(new RegExp(`${prop}=\\{false\\}`))
    }
  })

  it('globals.css carries the rule the class refers to', () => {
    const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')
    expect(css).toMatch(/\.reasoning-flow-scrollable\s+\.react-flow__pane\s*\{[^}]*touch-action:\s*auto/)
  })

  it('React Flow still ships the default this exists to undo', () => {
    // A stale-guard, the same idea as the empty baseline in
    // `scripts/check-static-utility-modifiers.mjs`: if upstream ever drops
    // `touch-action: none`, this fails and the override can be deleted instead
    // of being carried forever as a rule nobody can justify.
    const upstream = readFileSync(
      join(SRC, '..', 'node_modules', '@xyflow', 'react', 'dist', 'style.css'),
      'utf8',
    )
    expect(upstream).toMatch(/\.react-flow__pane\s*\{[^}]*touch-action:\s*none/)
  })
})

describe('the soft keyboard is told what the action key does', () => {
  /**
   * `enterKeyHint` relabels the phone's action key. It changes nothing on a
   * desktop, which is exactly why it goes missing: the field looks finished.
   *
   * These three are the ones where Enter is wired to something other than "insert
   * a newline", so a key drawn as a return arrow is actively misleading. Held by
   * name because each is a shared molecule — one of them backs every product
   * search field in the app.
   */
  it.each([
    ['components/ui/search-field.tsx', 'search'],
    ['features/layout/components/InputArea.tsx', 'send'],
    ['components/ui/type-to-confirm-dialog.tsx', 'done'],
  ])('%s declares enterKeyHint="%s"', (file, hint) => {
    const source = readCode(join(SRC, ...file.split('/')))
    expect(source).toContain(`enterKeyHint="${hint}"`)
  })

  it('keeps the phone from editing a search query on its way in', () => {
    // A query matches strings. Autocapitalize turns "oib" into "Oib" and
    // autocorrect rewrites the abbreviations these documents are named with, so
    // the result set disagrees with what the reader believes they typed.
    const source = readCode(join(SRC, 'components', 'ui', 'search-field.tsx'))
    expect(source).toMatch(/autoCapitalize="off"/)
    expect(source).toMatch(/autoCorrect="off"/)
  })
})
