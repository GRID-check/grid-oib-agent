import { describe, expect, it } from 'vitest'

import {
  blankComments,
  findViolations,
  parseStaticUtilities,
  run,
} from './check-static-utility-modifiers.mjs'

describe('parseStaticUtilities', () => {
  it('reports a utility whose body never calls --modifier()', () => {
    const css = `@utility bg-warning {\n  background-color: var(--warn);\n}`
    expect(parseStaticUtilities(css)).toEqual(['bg-warning'])
  })

  it('exempts a utility that declares a --modifier(), so the guard retires itself', () => {
    const css = `@utility bg-warning {\n  background-color: --alpha(var(--warn) / --modifier(integer, [percentage]));\n}`
    expect(parseStaticUtilities(css)).toEqual([])
  })

  // The body search must brace-match, not stop at the first `}` — otherwise a
  // nested block would hide a `--modifier()` that comes after it.
  it('searches the whole block, including nested rules', () => {
    const css = `@utility fancy {\n  &:hover {\n    color: red;\n  }\n  border-color: --modifier(--alpha(x));\n}`
    expect(parseStaticUtilities(css)).toEqual([])
  })

  it('skips functional utilities, whose name is a pattern Tailwind resolves itself', () => {
    const css = `@utility tab-* {\n  tab-size: --value(--tab-size-*);\n}`
    expect(parseStaticUtilities(css)).toEqual([])
  })
})

describe('findViolations', () => {
  const names = ['bg-info', 'bg-info-subtle', 'border-error', 'border-warning']

  it('flags a slash modifier on a static utility', () => {
    const source = `const c = 'border-warning/40 bg-info-subtle/30'`
    expect(findViolations(source, names).map((v) => v.className)).toEqual([
      'border-warning/40',
      'bg-info-subtle/30',
    ])
  })

  it('prefers the longest utility name, so bg-info-subtle is not read as bg-info', () => {
    expect(findViolations(`className="bg-info-subtle/40"`, names)[0].utility).toBe('bg-info-subtle')
  })

  it('sees through variants and the important prefix', () => {
    const source = `className="dark:hover:border-error/50 !bg-info/15"`
    expect(findViolations(source, names).map((v) => v.utility)).toEqual(['border-error', 'bg-info'])
  })

  it('accepts arbitrary modifier values', () => {
    expect(findViolations(`className="bg-info/[0.06]"`, names)[0].className).toBe('bg-info/[0.06]')
  })

  it('reports line and column so the failure is navigable', () => {
    const source = `line one\nconst c = 'bg-info/15'\n`
    expect(findViolations(source, names)[0]).toMatchObject({ line: 2, column: 12 })
  })

  it('leaves the solid class alone', () => {
    expect(findViolations(`className="border-warning bg-info-subtle"`, names)).toEqual([])
  })

  it('ignores a longer identifier that merely ends with a utility name', () => {
    expect(findViolations(`className="hairline-bg-info/15"`, names)).toEqual([])
  })

  // The two fixed components carry comments naming the broken classes they
  // replaced; the guard must not turn that documentation into a failure.
  it('ignores class names mentioned in comments', () => {
    const source = [
      '// `border-warning/40` matched nothing and fell back to the neutral border.',
      '/* bg-info-subtle/30 was the same defect. */',
      `const c = 'border-warning'`,
    ].join('\n')
    expect(findViolations(source, names)).toEqual([])
  })

  it('does not mistake a URL protocol for a comment and go blind after it', () => {
    const source = `const help = 'https://example.test/x'\nconst c = 'bg-info/15'`
    expect(findViolations(source, names).map((v) => v.className)).toEqual(['bg-info/15'])
  })

  it('scans inside template literals, where class names also live', () => {
    expect(findViolations('const c = `border-error/50 ${x}`', names)[0].utility).toBe(
      'border-error'
    )
  })
})

describe('run', () => {
  // The real tree must be clean apart from the documented baseline — this is the
  // assertion that fails the moment someone reintroduces the defect anywhere in src/.
  it('finds no unexpected violations and no stale baseline entries in the repo', () => {
    expect(run()).toEqual({ unexpected: [], stale: [] })
  })

  it('flags a baseline entry that no longer matches, so the list cannot rot', () => {
    const { stale } = run({
      knownViolations: [{ file: 'src/nowhere.tsx', className: 'bg-info/15' }],
    })
    expect(stale).toEqual([{ file: 'src/nowhere.tsx', className: 'bg-info/15' }])
  })
})
