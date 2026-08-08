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
    files: ['src/app/**/*.{ts,tsx}'],
    ignores: ['src/**/*.spec.{ts,tsx}'],
    plugins: { grid: { rules: { 'require-tenant-scope': requireTenantScope } } },
    rules: { 'grid/require-tenant-scope': 'error' },
  },
  {
    // The CommonJS bridge modules under `src/lib/**`.
    //
    // A handful of files are CommonJS on purpose, not by accident: `server.js`
    // (the WebSocket proxy) and `purger/` are plain Node and cannot import
    // TypeScript, yet they must share EXACTLY the data and algorithms the typed
    // side uses — the rate-limit catalog, and the tenant bucket naming rule that
    // decides which bucket a tenant's objects are erased from. Reimplementing
    // either on the other side of the language boundary is how the two drift,
    // and both drift silently.
    //
    // `no-require-imports` exists to stop TypeScript reaching for `require`.
    // These files have no other option. Listed one by one rather than by glob,
    // so the exemption cannot quietly grow to cover a file that does have a
    // choice.
    files: ['src/lib/storage/tenant-bucket.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
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
