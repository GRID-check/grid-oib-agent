/**
 * The guard on the guard. `grid/card-type-scale` is the only thing standing
 * between the card set and a fourteenth font size, and its two failure modes
 * are opposite and both silent: miss `text-[13px]` and the drift comes back,
 * flag `text-muted-foreground` and the next author disables the rule.
 */

import { RuleTester } from 'eslint'
import { describe, expect, it } from 'vitest'
import rule from './card-type-scale.mjs'

const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
})

// `RuleTester.run` declares its own suite, so it has to sit at the top level.
ruleTester.run('card-type-scale', rule, {
  valid: [
    // The ramp itself.
    `const a = 'card-eyebrow text-muted-foreground'`,
    `const a = 'card-meta font-mono text-muted-foreground/60'`,
    `const a = 'card-body text-pretty'`,
    `const a = 'card-title text-foreground'`,
    `const a = 'card-figure-20 tracking-tight text-balance'`,
    `const a = 'card-value font-mono'`,
    `const a = 'card-prose text-default'`,
    // Semantic INK, which is spelled `text-*` too and is not a size.
    `const a = 'text-muted-foreground text-subtle text-error text-success'`,
    // Sizes of things that are not type.
    `const a = 'size-3.5 w-3 h-[3px] max-w-[46ch]'`,
  ],
  invalid: [
    {
      code: `const a = 'text-sm font-semibold'`,
      errors: [{ messageId: 'offRamp' }],
    },
    {
      code: `const a = 'text-[13.5px] leading-[1.55]'`,
      errors: [{ messageId: 'offRamp' }],
    },
    {
      // The exact drift the charter measured: one size, two spellings.
      code: `const a = 'text-xs'; const b = 'text-[12px]'`,
      errors: [{ messageId: 'offRamp' }, { messageId: 'offRamp' }],
    },
    {
      // Variants and `!` are the same finding.
      code: `const a = 'md:text-lg text-2xl!'`,
      errors: [{ messageId: 'offRamp' }, { messageId: 'offRamp' }],
    },
    {
      code: 'const a = `text-[0.8rem] ${x}`',
      errors: [{ messageId: 'offRamp' }],
    },
    {
      // Whole-token matching means PROSE that names a size is reported too.
      // Deliberate, and the same trade motion-vocabulary.mjs makes: a string
      // carrying `text-sm` as its own token is a class list in practice, and
      // the alternative (substring matching) would miss nothing and flag far
      // more. A comment is not a Literal, so the usual place to explain a size
      // is unaffected.
      code: `const a = 'the text-sm step is gone'`,
      errors: [{ messageId: 'offRamp' }],
    },
  ],
})

describe('grid/card-type-scale', () => {
  it('names the step to reach for, so the message is a fix and not a scolding', () => {
    const collected = []
    const context = {
      report: (descriptor) => collected.push(descriptor.data),
    }
    const visitor = rule.create(context)
    for (const value of ['text-[13.5px]', 'text-sm', 'text-2xl', 'text-[10px]']) {
      visitor.Literal({ type: 'Literal', value })
    }

    expect(collected.map((d) => d.step)).toEqual([
      'card-body (13.5px)',
      'card-title (14px)',
      'card-figure-20 (20px) — and only if this is the card ANSWER (§A2: one per card)',
      // 10px lands on Meta, not on Eyebrow: the eyebrow is retired inside
      // cards (§A2), so the rule must never suggest reaching for it there.
      'card-meta (11px)',
    ])
  })
})
