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
