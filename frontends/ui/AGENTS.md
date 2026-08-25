<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# The UI and the BFF — `frontends/ui`

Next.js App Router: the product UI, the BFF API routes under `src/app/api`, and
the WebSocket proxy (`server.js`). This is also where tenancy, authorization and
the database live — the Python agent is stateless and trusts what this tier
sends it.

Additive to the root [`../../AGENTS.md`](../../AGENTS.md), not a replacement: this file is only what is true here.

## Commands

```bash
task fe:lint      task fe:types      task fe:test      task fe:build
task fe:verify    # all four, in the order CI runs them
task db:test:rls  # tenant-isolation gate. NOT part of `task verify`
```

`bun` installs and runs scripts here; it is never the runtime. Adding `--bun`
exports `NODE_OPTIONS=--bun` and kills Turbopack's PostCSS step. `task fe:types`
is the signal that the production build will typecheck, because the UI tsconfig
includes spec files — a type error in a test blocks `next build`.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Add an `app/api` route | Declare `authz` on the factory from `@/lib/api/handler` | `apiRoute` does not compile; `authz-coverage.spec.ts` |
| Add a permission | `lib/authz/catalog.ts` first, then `bun run provision:authz --apply` against **every** environment | WorkOS drifts from the code. A project-tier permission that exists only in the catalog is held by nobody |
| Decide access | Check a permission, never a role slug. `lib/authz/decide.ts` is the intended single decision point; adoption is incremental (ADR-0038 §6) and the gates still call `hasPermission` / `requireProjectAccess` / `requirePlatformPermission` directly | Bypasses become implicit. A role-name check breaks every custom role |
| Create a table | `SELECT grid_secure_table('<table>','<predicate>');` in the same migration | `rls-coverage.spec.ts`, by name |
| Read tenant rows | Context from `getGridSession()`, or state it (`withTenant`, `withPlatformAccess`, `withOptionalTenant`) | `internalApiRoute` does not compile |
| Write an endpoint | Route is a thin adapter, service owns logic and authorization, repository owns the SQL and bounds every list | Review. `publicApiRoute` needs an ADR |
| Read a raw `sql<T>` result | Coerce at the repository boundary (`new Date(row.x)`, `Number(row.x)`) | Nothing. `tsc` believes the annotation and you get `toISOString is not a function` at runtime |
| Reach for `any` | Use the real type, `Partial<T>`, `unknown`, or the fixtures in `@/test-utils/*` | `@typescript-eslint/no-explicit-any` is an error, in tests too |
| Write a general-purpose helper | Put it in `lib/text/`, `lib/utils/`, `lib/format.ts` — and search first | A private copy is a fork, and the drift is invisible because each copy looks locally correct |
| Build a component | Compose atoms; if the kit lacks a shape, add the atom rather than a `<div className="…">` in the organism | Review. The viewport that ignored this had four floating panels in three materials, none testable |
| Show something a surface already shows | Compose the same atoms, or reuse the organism | Two lookalikes drift on the first token retune. `project-atoms.tsx` exists for exactly this |
| Add a card type | Classify it in `CARD_INTERACTIVITY` (`features/grid-cards/card-decision.ts`) | `task fe:types` |
| Store a card's answer | On `ChatMessage.cardInteractions` via `useCardDecision` | A reload re-applies the patch; neither endpoint is idempotent |
| Add user-facing copy | Add the key to every dictionary in `src/i18n/dictionaries` | `key-coverage.spec.ts` |
| Ship a user-visible surface | A `/dev/<name>` preview route, a registry target, committed PNGs from `task fe:screenshots` | `visual-coverage` |

## Rules that need more than a row

**The UI is built atomically: atoms → molecules → organisms → route.** An
organism reaches for an atom, never for Tailwind; shape is a primitive
(`components/ui/raised-card.tsx`) and the domain is an atom on top of it
(`components/projects/project-atoms.tsx`). `features/bim/components/viewer/index.ts`
is a barrel that exists purely to enforce the import direction. The layers, and
the three rules that carry them:
[`docs/design/grid-design-language.md`](../../docs/design/grid-design-language.md#component-layers-atomic-design).

**Authorization checks a permission, never a role name.** Both bypasses are
permissions: `org:projects:administer` reaches every project in one
organization, and platform access is membership of the GRID Platform
organization *plus* the specific `platform:*` permission the surface needs.
`session.role === 'admin'` looks equivalent and is not — it denies a custom role
holding every `org:*` permission, and grants any role that merely shares the
name.

**Stepping up is not authorization.** Row-level security guards application
bugs — the missing `WHERE`, the widened join. Anything running arbitrary SQL as
`grid_app_rw` can name any tenant, so every platform-scope caller keeps its own
check. RLS is the backstop, never the plan.

**Put the organization in every cache key.** `getCached` returns before the
loader runs, so a key without the organization serves whatever the first caller
populated and never enters the tenant scope. `lib/project-profile/prompt-view.ts`
is the pattern.

**The project profile has one editor, the intake wizard.** Settings shows it
read-only and links there. Its facts are interdependent, so edits belong in the
guided flow rather than a second form.

**Piloti is the product, GRID is the repo.** User-facing strings say Piloti;
env vars (`GRID_*`), headers (`x-grid-*`) and CSS variables stay GRID.
`lib/brand.ts` is the single source.

## Reference

- [`docs/architecture/bff-service-architecture.md`](../../docs/architecture/bff-service-architecture.md),
  ADR-0017 (repository/service), ADR-0038 (authorization), ADR-0041 (RLS).
- Conventions and the reasoning behind them:
  [`docs/contributing/code-conventions.md`](../../docs/contributing/code-conventions.md).
