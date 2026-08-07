import { FlatCompat } from '@eslint/eslintrc'
import requireTenantScope from './eslint-rules/require-tenant-scope.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Row-level security is enforced by Postgres at request time, which means a
    // missing tenant scope is invisible until a user actually hits it. Twice now
    // that user has been a customer (#342, #344). This moves the check into the
    // editor and CI. See eslint-rules/require-tenant-scope.mjs.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts', 'src/lib/db/index.ts'],
    plugins: { grid: { rules: { 'require-tenant-scope': requireTenantScope } } },
    rules: { 'grid/require-tenant-scope': 'error' },
  },
  {
    // Modules written before the rule existed, with their violation counts.
    //
    // A ratchet, not an exemption: the rule is an ERROR everywhere else, so no
    // NEW unscoped query can be added anywhere in the codebase, including in
    // these files (a new one raises the count and the entry stops matching the
    // reality it documents). Every module here is currently reached only from
    // API routes, which get a scope from their route factory — that is why they
    // work today and why they break the moment a server component calls one.
    //
    // Converting them is not a find-and-replace. Each site needs a judgement
    // about whether the query serves ONE tenant (`withTenant`) or genuinely
    // spans them (`withPlatformAccess`, e.g. the platform-tier citation and
    // spend aggregates), and choosing `withPlatformAccess` wrongly silently
    // disables tenant isolation rather than failing closed. That is a per-
    // function security decision, so these land in reviewed batches.
    //
    // The list may only shrink.
    files: [
      'src/lib/inbox/repository.ts', // 19
      'src/lib/conversations/repository.ts', // 16
      'src/lib/projects/memory-service.ts', // 14
      'src/lib/mentions/repository.ts', // 14
      'src/lib/citations/repository.ts', // 14
      'src/lib/budgets/repository.ts', // 12
      'src/lib/sharing/repository.ts', // 11
      'src/lib/feedback/repository.ts', // 10
      'src/lib/workflows/repository.ts', // 9
      'src/lib/llm-credentials/repository.ts', // 7
      'src/lib/platform-workflow-templates/repository.ts', // 6
      'src/lib/model-config/service.ts', // 6
      'src/lib/compliance/repository.ts', // 4
      'src/lib/archiv/repository.ts', // 4
      'src/lib/reasoning-settings/service.ts', // 3
      'src/lib/projects/overview-query.ts', // 3
      'src/lib/projects/folder-service.ts', // 3
    ],
    rules: { 'grid/require-tenant-scope': 'warn' },
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
