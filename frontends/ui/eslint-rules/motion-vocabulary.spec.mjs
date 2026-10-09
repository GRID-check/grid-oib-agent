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
    // The sanctioned loop utilities, and an easing that only shares a prefix.
    `const a = 'animate-caret-breathe motion-reduce:animate-none'`,
    `const a = 'animate-typing-dot animate-progress-sweep ease-entrance'`,
    // A motion target of transform and opacity is the vocabulary.
    `const x = <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} />`,
    // Only initial/animate/exit are motion targets; a style prop is not.
    `const x = <motion.div style={{ height: 40 }} layout />`,
    // A variants object is not followed (see the rule's note).
    `const x = <motion.div variants={v} initial="hidden" animate="visible" />`,
    // Spring the transform, tween the opacity: the per-key override is the fix.
    `const x = <motion.span initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...springSnap, opacity: motionQuick }} />`,
    // A target's own transition governs it, whatever the element default is.
    `const x = <motion.span animate={{ opacity: 1, scale: 1, transition: swap.enter }} exit={{ opacity: 0, transition: motionQuickExit }} transition={springSnap} />`,
    // A spring on a target with no opacity is the vocabulary (a press, a glide).
    `const x = <motion.div animate={{ scale: 0.99 }} transition={springPress} />`,
    `const x = <motion.span layoutId="pill" transition={springGlide} />`,
    `const x = <motion.div whileTap={{ scale: 0.99, transition: springPress }} />`,
    // Opacity only in `initial` is where it starts, not what animates.
    `const x = <motion.span initial={{ opacity: 0 }} animate="shown" transition={springSnap} />`,
    // The kit's CSS-string siblings are not motion transitions.
    `const x = <motion.span animate={{ opacity: 1 }} transition={springSnapLinear} />`,
    // A transition held in a variable is not followed.
    `const x = <motion.span animate={{ opacity: 1 }} transition={landing} />`,
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
    {
      // Hand-written animation timings, bare and behind a variant.
      code: `const a = '[animation-delay:160ms] motion-safe:[animation-duration:2s]'`,
      errors: [
        { messageId: 'arbitraryAnimationTiming' },
        { messageId: 'arbitraryAnimationTiming' },
      ],
    },
    {
      code: `const a = 'motion-safe:animate-pulse'`,
      errors: [{ messageId: 'animatePulse' }],
    },
    {
      code: `const a = 'ease-in-out ease-in'`,
      errors: [{ messageId: 'offVocabularyEasing' }, { messageId: 'offVocabularyEasing' }],
    },
    {
      // A height arrival: ONE finding for the element, on its opening tag, so
      // one disable comment with a reason covers initial, animate and exit.
      code: `const x = <motion.div\n  initial={{ height: 0, opacity: 0 }}\n  animate={{ height: 'auto', opacity: 1 }}\n  exit={{ height: 0 }}\n/>`,
      errors: [{ messageId: 'motionLayoutKey', line: 1 }],
    },
    {
      code: `const x = <motion.div animate={{ 'width': 10, top: 4, left: 0 }} />`,
      errors: [{ messageId: 'motionLayoutKey' }],
    },
    {
      // The icon swap that ran its fade on a 500ms spring: one finding per
      // element, on its opening tag.
      code: `const x = <motion.span\n  initial={{ opacity: 0, scale: 0.6 }}\n  animate={{ opacity: 1, scale: 1 }}\n  exit={{ opacity: 0, scale: 0.6 }}\n  transition={springSnap}\n/>`,
      errors: [{ messageId: 'springOpacity', line: 1 }],
    },
    {
      // Every kit spring and legacy alias.
      code: `const x = <>
        <motion.li animate={{ opacity: 1 }} transition={springDrawer} />
        <motion.li animate={{ opacity: 1 }} transition={springGlide} />
        <motion.li animate={{ opacity: 1 }} transition={springPress} />
        <motion.li animate={{ opacity: 1 }} transition={springSnappy} />
        <motion.li animate={{ opacity: 1 }} transition={springGentle} />
      </>`,
      errors: Array(5).fill({ messageId: 'springOpacity' }),
    },
    {
      // The spring set on the target itself.
      code: `const x = <motion.span animate={{ opacity: 1, transition: springSnap }} />`,
      errors: [{ messageId: 'springOpacity' }],
    },
    {
      // Spread or `type: 'spring'` with no opacity override is still a spring.
      code: `const x = <>
        <motion.span animate={{ opacity: 1 }} transition={{ ...springSnap, delay: 0.1 }} />
        <motion.span animate={{ opacity: 1 }} transition={{ type: 'spring', stiffness: 400 }} />
      </>`,
      errors: [{ messageId: 'springOpacity' }, { messageId: 'springOpacity' }],
    },
    {
      // Either branch of a conditional counts; so does a hover target.
      code: `const x = <>
        <motion.span animate={{ opacity: 1 }} transition={reduced ? motionInstant : springSnap} />
        <motion.span whileHover={{ opacity: 0.8 }} transition={springPress} />
      </>`,
      errors: [{ messageId: 'springOpacity' }, { messageId: 'springOpacity' }],
    },
    {
      // An opacity override that is itself a spring is no override.
      code: `const x = <motion.span exit={{ opacity: 0 }} transition={{ ...springSnap, opacity: springPress }} />`,
      errors: [{ messageId: 'springOpacity' }],
    },
  ],
})
