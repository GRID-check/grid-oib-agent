import { FlatCompat } from '@eslint/eslintrc'
import requireTenantScope from './eslint-rules/require-tenant-scope.mjs'
import motionVocabulary from './eslint-rules/motion-vocabulary.mjs'
import cardTypeScale from './eslint-rules/card-type-scale.mjs'
import requireTenantCacheKey from './eslint-rules/require-tenant-cache-key.mjs'
import { PRE_EXISTING_DB_IMPORTERS } from './eslint-rules/route-db-access-allowlist.mjs'
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
    'require-tenant-cache-key': requireTenantCacheKey,
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
 * Sprint 1 (charter §C): key_takeaways, verdict_header, callout, the two
 * proposal cards.
 *
 * Sprint 2: the shared schematic chrome. `kit.tsx`
 * earns its place first because it is the chrome for eight cards — eyebrow,
 * title, note and norm footer — so one migration moves all of them onto the
 * ramp at once, and every schematic card migrated after it starts from a
 * compliant shell.
 */
const CARDS_ON_THE_TYPE_RAMP = [
  'src/features/grid-cards/components/KeyTakeawaysCard.tsx',
  'src/features/grid-cards/components/VerdictHeaderCard.tsx',
  'src/features/grid-cards/components/CalloutCard.tsx',
  'src/features/grid-cards/components/ProposalShell.tsx',
  'src/features/grid-cards/schematics/kit.tsx',
]

const TRANSPORT_DOES_NOT_QUERY =
  'Route handlers and server components call a service; the query lives there (ADR-0017). Re-export a constant from the service if the route needs one.'

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
    // Transport code does not query (ADR-0017). `server-component-db-access.spec.ts`
    // holds the same rule, but it lives under src/lib/db, so a targeted test run
    // of the area you changed never reaches it, and twice in one branch a route
    // importing `@/lib/db/schema` was first caught by CI. Here it fails
    // `eslint <file>` and the editor. Type-only imports stay allowed.
    files: ['src/app/**/*.{ts,tsx}'],
    ignores: ['src/**/*.spec.{ts,tsx}', ...PRE_EXISTING_DB_IMPORTERS.map((file) => `src/${file.replace(/[\\[\]]/g, '\\$&')}`)],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@/lib/db', allowTypeImports: true, message: TRANSPORT_DOES_NOT_QUERY }],
          patterns: [
            {
              group: ['@/lib/db/*', '!@/lib/db/tenant-context'],
              allowTypeImports: true,
              message: TRANSPORT_DOES_NOT_QUERY,
            },
          ],
        },
      ],
    },
  },
  {
    // The other half of the tenant boundary, and the half row-level security
    // cannot backstop: `getCached` answers from the store BEFORE the loader
    // runs, so an unpartitioned key never reaches a tenant scope at all. It has
    // already happened once (gotchas.md:36, "Cached project context comes back
    // belonging to another tenant") and the keys were ad-hoc template strings at
    // 28 call sites when the caching audit counted them. ERROR, with a reasoned
    // allowlist in eslint-rules/global-cache-keys.mjs for the keys that really
    // are one per deployment. See eslint-rules/require-tenant-cache-key.mjs.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.spec.{ts,tsx}'],
    rules: { 'grid/require-tenant-cache-key': 'error' },
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
    // drizzle's `tx.rollback()` THROWS `TransactionRollbackError`; it does not
    // return. `promoteVersionToPublished` called it and then `return null`, the
    // null was unreachable, and a lost publish race answered 500 instead of 409.
    // Throw a sentinel of your own inside the transaction and catch it outside
    // (`LostCompareAndSwap` in lib/documents/version-repository.ts).
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.spec.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='rollback'][arguments.length=0]",
          message:
            "drizzle's tx.rollback() throws TransactionRollbackError, so nothing after it runs. Throw a sentinel inside the transaction and catch it outside (see LostCompareAndSwap).",
        },
        {
          // Every `error.code === '23505'` in this tree compared against
          // drizzle's `Failed query` wrapper, whose code is undefined — the
          // driver's error is its `cause` — so each race backstop behind one was
          // dead in production and its loser got a 500.
          selector: "Literal[value='23505']",
          message:
            "drizzle wraps the driver error: `error.code` is undefined and the SQLSTATE is on `cause`. Use isUniqueViolation(error, '<constraint>') from @/lib/db/errors.",
        },
        {
          // pdf.js drains its text stream with `for await`, and Safari before 27
          // cannot iterate a ReadableStream: every cited passage went unmarked
          // there while the page rendered fine.
          selector: "CallExpression[callee.property.name='getTextContent']",
          message:
            "page.getTextContent() iterates a ReadableStream with for-await, which Safari before 27 cannot do. Use readPageTextItems(page) from features/knowledge/lib/pdfjs-runtime.",
        },
      ],
    },
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
