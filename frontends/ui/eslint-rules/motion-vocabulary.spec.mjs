/**
 * The guard on the guard, same reasoning as card-type-scale.spec.mjs. The
 * literal-duration pattern has two opposite silent failure modes: miss
 * `duration-200` and the sweep that removed forty of them un-ratchets, or
 * flag `duration-snap` / `data-[state=open]:duration-base` and the next
 * author disables the rule.
 */

import { RuleTester } from 'eslint'
import rule from './motion-vocabulary.mjs'

const ruleTester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
})

// `RuleTester.run` declares its own suite, so it has to sit at the top level.
ruleTester.run('motion-vocabulary', rule, {
  valid: [
    // The duration scale itself, bare and behind variants.
    `const a = 'transition-colors duration-snap ease-out'`,
    `const a = 'transition-opacity duration-quick motion-reduce:transition-none'`,
    `const a = 'animate-in fade-in-0 duration-base ease-entrance'`,
    `const a = 'data-[state=open]:duration-deliberate data-[state=open]:ease-entrance'`,
    `const a = 'hover:duration-snap md:duration-quick'`,
    `const a = 'animate-spin duration-ambient ease-cycle'`,
    // Named-property transitions and the sanctioned easings.
    `const a = 'transition-transform ease-exit'`,
    // Words that merely start the same are not durations.
    `const a = 'duration-snappy'`,
  ],
  invalid: [
    {
      code: `const a = 'transition-colors duration-200 ease-out'`,
      errors: [{ messageId: 'literalDuration' }],
    },
    {
      // Every numeric step Tailwind ships.
      code: `const a = 'duration-75 duration-100 duration-150 duration-300 duration-500 duration-700 duration-1000'`,
      errors: Array(7).fill({ messageId: 'literalDuration' }),
    },
    {
      // Arbitrary values are the same finding.
      code: `const a = 'duration-[180ms]'`,
      errors: [{ messageId: 'literalDuration' }],
    },
    {
      // Plain variant prefixes and `!` are stripped before matching.
      code: `const a = 'md:duration-200 duration-150!'`,
      errors: [{ messageId: 'literalDuration' }, { messageId: 'literalDuration' }],
    },
    {
      code: 'const a = `duration-500 ${x}`',
      errors: [{ messageId: 'literalDuration' }],
    },
    // The three original findings still fire.
    {
      code: `const a = 'transition-all'`,
      errors: [{ messageId: 'transitionAll' }],
    },
    {
      code: `const a = 'ease-linear'`,
      errors: [{ messageId: 'easeLinear' }],
    },
    {
      code: `const a = 'transition-[width]'`,
      errors: [{ messageId: 'layoutTransition' }],
    },
  ],
})
