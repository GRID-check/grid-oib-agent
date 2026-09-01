import { FlatCompat } from '@eslint/eslintrc'
import requireTenantScope from './eslint-rules/require-tenant-scope.mjs'
import motionVocabulary from './eslint-rules/motion-vocabulary.mjs'
import cardTypeScale from './eslint-rules/card-type-scale.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

/**
 * The repo's own rules, registered once under a single `grid` namespace.
 *
 * Flat config refuses to redefine a plugin name across two config objects that
 * both match a file, and the blocks below deliberately overlap (one is scoped
 * to src/app, one to all of src). Declaring the plugin in one fileless block
 * and only setting severities per scope keeps that from being a footgun the
 * next rule walks into.
 */
const gridRules = {
  rules: {
    'require-tenant-scope': requireTenantScope,
    'motion-vocabulary': motionVocabulary,
    'card-type-scale': cardTypeScale,
  },
}

/**
 * The cards that have been through a charter sprint and now carry ONLY the
 * §A2 type ramp. One line per card, added by the sprint that migrates it.
 *
 * The list is here rather than inside the rule on purpose: the charter's
 * migration is deliberately incremental ("a flag-day rewrite of 200 call sites
 * is not worth the review burden"), so the set of compliant files is real
 * project state, and config is where a reviewer looks for it. A rule carrying
 * its own exemption list would instead report "clean" while eleven cards still
 * carried an off-ramp size.
 *
 * Sprint 1 (charter §C): follow_ups, key_takeaways, verdict_header, summary,
 * callout, the two proposal cards.
 *
 * Sprint 2: the shared schematic chrome and the two table cards. `kit.tsx`
 * earns its place first because it is the chrome for NINE cards — eyebrow,
 * title, note and norm footer — so one migration moves all of them onto the
 * ramp at once, and every schematic card migrated after it starts from a
 * compliant shell.
 */
const CARDS_ON_THE_TYPE_RAMP = [
  'src/features/grid-cards/components/FollowUpsCard.tsx',
  'src/features/grid-cards/components/KeyTakeawaysCard.tsx',
  'src/features/grid-cards/components/VerdictHeaderCard.tsx',
  'src/features/grid-cards/components/SummaryCard.tsx',
  'src/features/grid-cards/components/CalloutCard.tsx',
  'src/features/grid-cards/components/ProposalShell.tsx',
  'src/features/grid-cards/components/DiagramCard.tsx',
  'src/features/grid-cards/schematics/kit.tsx',
  'src/features/grid-cards/components/ComparisonTableCard.tsx',
  'src/features/grid-cards/components/TypedTableCard.tsx',
]

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  { plugins: { grid: gridRules } },
  {
    // Row-level security is enforced by Postgres at request time, which means a
    // missing tenant scope is invisible until a user actually hits it. Twice now
    // that user has been a customer (#342, #344). This moves the check into the
    // editor and CI. See eslint-rules/require-tenant-scope.mjs.
    files: ['src/app/**/*.{ts,tsx}'],
    ignores: ['src/**/*.spec.{ts,tsx}'],
    rules: { 'grid/require-tenant-scope': 'error' },
  },
  {
    // Motion is decoration with a job here, which makes it cheap to get wrong in
    // ways nobody notices until a dense screen shimmers. Warn, not error, on the
    // same reasoning as no-console below: the point is to stop new instances,
    // and the few already in the tree (vendored shadcn sidebar chrome, one
    // progress bar) should stay visible without turning unrelated runs red.
    // See eslint-rules/motion-vocabulary.mjs.
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'grid/motion-vocabulary': 'warn' },
  },
  {
    // Thirteen font sizes is how the card set lost its hierarchy, and every one
    // of them looked reasonable at the call site that introduced it. ERROR, not
    // warn, because unlike the motion utilities there is no legacy to be
    // tolerant of here: a file only enters this list once it is already clean.
    // See eslint-rules/card-type-scale.mjs and grid-card-charter.md §A2.
    files: CARDS_ON_THE_TYPE_RAMP,
    rules: { 'grid/card-type-scale': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `any` is not a type we accept anywhere in this codebase — not in
      // production code and not in test doubles. Reach for the real type, a
      // `Partial<T>`/`Pick<T, …>` of it, `unknown`, or an explicit
      // `as unknown as T` assertion when a fixture is deliberately incomplete.
      '@typescript-eslint/no-explicit-any': 'error',
      'prefer-const': 'error',
      // `debug` joins the allow-list because it is this repo's deliberate
      // dev-only diagnostic channel (every call site is NODE_ENV-gated and
      // asserted on in storage-logger.spec.ts). Stray `console.log` stays
      // blocked — that is what this rule is here to catch.
      'no-console': ['warn', { allow: ['warn', 'error', 'debug'] }],
    },
  },
]
