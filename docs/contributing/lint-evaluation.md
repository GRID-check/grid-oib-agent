# UI lint: oxlint vs Biome (evaluation, 2026-10)

`frontends/ui` linted with ESLint 8 (`next/core-web-vitals` + `next/typescript`
through FlatCompat, plus the repo's own rules). On ~2,600 files that took
35–40 s of every `bun run lint`, 25–35 s of a two-core CI runner, and it was the
slow step of `task fe:verify`. The ask was a much faster lint with nothing the
current one enforces lost, oxlint or Biome, chosen on measurements.

**Decision: oxlint 1.85.0, alone.** The repo's rules run in it unchanged as a JS
plugin, so there is no second linter. The linter step went from 35.8 s to 2.0 s
on four cores and from 40.1 s to 3.0 s on two. `bun run lint` end to end
(including the 1.1 s utility-modifier script) went from about 37 s to 3.8 s.

`frontends/web` and `packages/ifc-spatial` do not use ESLint (`astro check` and
their own `scripts/lint-*.mjs`; `tsc` and tests respectively), so the change is
`frontends/ui` only.

## What had to survive

| Kind | What | Why it cannot be dropped |
|---|---|---|
| Repo rule | `grid/require-tenant-scope` | Security control: a server component or action that resolves a session outside a tenant slot fails closed under RLS (#342, #344) |
| Repo rule | `grid/require-tenant-cache-key` | Security control: a cache key without the organization serves one tenant's value to another, and RLS cannot see it |
| Repo rule | `grid/motion-vocabulary`, `grid/card-type-scale` | Design rules (motion scale, card type ramp §A2) |
| Core rule | `no-restricted-syntax` with three selectors | Each is a production bug: drizzle's throwing `tx.rollback()`, the dead `'23505'` comparisons, Safari's `getTextContent()` |
| Preset | 72 rules from `next/core-web-vitals` + `next/typescript` (`eslint --print-config`), including `@next/next/*`, `react-hooks/rules-of-hooks`, `exhaustive-deps`, and `no-explicit-any` as an error in tests too | The baseline everybody codes against |
| Comments | 52 `eslint-disable-next-line` directives in `src/` | Each one is a reviewed exception |

## Versions and machine

| | Version | Published |
|---|---|---|
| eslint (before) | 8.57.1, eslint-config-next 15.5.15, @typescript-eslint/parser 8.68.0 | |
| oxlint | 1.85.0 | 2026-09-21 |
| @biomejs/biome | 2.5.14 | 2026-09-16 |

Newer releases (oxlint 1.86/1.87, Biome 2.5.15) were less than two weeks old and
were not used.

Machine: 4 vCPU Intel Xeon @ 2.1 GHz, 15 GB RAM, Node 22.22.0, bun 1.4.2. The
two-core figures pin the process with `taskset -c 0,1`, which oxlint and Biome
honour when they size their thread pools. The host is shared: other jobs held
the load average at 4–7 during the main run, so the fast tools show a wide
range. The adopted command was measured again at load ~2 (last two rows).
hyperfine 1.19.0, 10 runs after 2 warmups for anything under ~15 s, 3 runs after
1 warmup otherwise. Every figure is the median wall time in seconds over
`src tests`.

## Timings

| Setup | 4 cores | 2 cores |
|---|---:|---:|
| ESLint, current config | 35.8 | 40.1 |
| ESLint `--cache`, cold | 36.9 | 40.0 |
| ESLint `--cache`, warm, nothing changed | 2.29 | 2.24 |
| **oxlint, native rules + repo rules as a JS plugin (adopted)** | 2.98 | 3.15 |
| oxlint, native rules only | 0.90 | 1.64 |
| Biome, native rules only | 2.01 | 3.21 |
| Biome + GritQL ports of four repo rules | 13.26 | 23.68 |
| ESLint with only the repo rules and the TS parser (the hybrid's ESLint half) | 19.5 | 21.1 |
| Hybrid: oxlint native + that ESLint half | 22.2 | 25.4 |
| Hybrid: Biome native + that ESLint half | 21.7 | 24.1 |
| Repo-rules-only ESLint `--cache`, warm | 0.94 | 0.99 |
| **oxlint (adopted), re-measured at low load** | **2.03** | **3.00** |
| **`bun run lint` after, end to end** | **3.78** | **4.30** |

What the numbers say:

- **A hybrid is not faster in any way that matters.** Turning the overlapping
  rules off (what `eslint-plugin-oxlint` and `eslint-config-biome` do) leaves
  ESLint parsing every file with the TypeScript parser, and that parse is the
  cost. The ESLint half alone, running only the repo rules, is 19.5 s: about
  half the current run. Both hybrids are around 22 s.
- **ESLint's cache is fast only when nothing changed.** Warm, it is 2.3 s, about
  what oxlint takes. A cold cache costs the full run, and CI starts cold on
  every job unless it restores the cache. Any config change, and every edited
  file, invalidates entries too.
- **The JS plugin costs oxlint about 2 s.** `--debug=timings` puts the repo
  rules' own callbacks at 0.23 s and the transfer of ASTs to JavaScript
  ("shared overhead") at 1.36 s. It is still 13–18× faster than ESLint.
- **GritQL is the expensive part of Biome.** Native Biome is 2.0 s. With the
  four ports it is 13.3 s, and 11.3 s of that is the motion-vocabulary port,
  which runs a regex over every string literal. Even with that rewritten,
  `require-tenant-cache-key` cannot be ported (below), so Biome would still need
  the 19.5 s ESLint half.

## The repo's rules

| Rule | oxlint | Biome (GritQL plugin) |
|---|---|---|
| `require-tenant-scope` | Rule module unchanged, loaded through `jsPlugins`. Binding resolution works: an import from the real module opens a slot, and a local function that only shares the name does not | Approximated with `within`. Grit has no binding resolution, so a local `withPageSession` counts as an opener: the planted shadowing case was **missed** |
| `require-tenant-cache-key` | Unchanged | **Not portable.** The rule follows an identifier to its initializer and a call into a local key builder's `return`, up to four hops, through the scope manager. GritQL has nothing like it, so the rule would have to stay in ESLint |
| `motion-vocabulary` | Unchanged | Regex over string literals: one report per string instead of per token, one generic message, and 11 s of runtime |
| `card-type-scale` | Unchanged | Regex. The per-size "nearest step" advice is lost |
| `no-restricted-syntax` | oxlint has no native equivalent. `eslint-rules/no-restricted-syntax.mjs` (20 lines) maps each configured selector to a visitor key, oxlint runs selectors through its bundled esquery, and the options are the same `{ selector, message }` objects | Three patterns, workable |

Evidence for the oxlint column: one planted violation per rule, plus
`no-explicit-any` in `src/` and in `tests/`, `rules-of-hooks`, `exhaustive-deps`,
`no-img-element` and `no-console`. ESLint and oxlint reported the same 17
findings on the same lines. On the unchanged tree, both report the same 12
unused disable directives (`--report-unused-disable-directives`), so oxlint
reads the existing `eslint-disable-next-line <eslint rule name>` comments
exactly as ESLint did. The planted check is now permanent, as
`eslint-rules/lint-config.spec.mjs` (see "Keeping it honest").

## Rule coverage

Every rule the old config enabled, across a card file, an `src/app` page, a spec
and a `tests/` file, with its replacement.

| ESLint rules (count) | oxlint | Biome (`biome migrate eslint`) |
|---|---|---|
| `@next/next/*` (21) | All 21, same names under `nextjs/` | 11. Not ported: `next-script-for-ga`, `no-assign-module-variable`, `no-css-tags`, `no-duplicate-head`, `no-html-link-for-pages`, `no-page-custom-font`, `no-script-component-in-head`, `no-styled-jsx-in-document`, `no-title-in-document-head`, `no-typos` |
| `react-hooks/rules-of-hooks`, `exhaustive-deps` | Both (`react/` in config; diagnostics and disable comments use `react-hooks/`) | `useHookAtTopLevel`, `useExhaustiveDependencies`, with different semantics (below) |
| `react/*` (17) | 14 | 5. Not ported: `display-name`, `jsx-no-undef`, `jsx-uses-react`, `jsx-uses-vars`, `no-deprecated`, `no-direct-mutation-state`, `no-find-dom-node`, `no-is-mounted`, `no-render-return-value`, `no-unescaped-entities`, `require-render-return`, `no-string-refs` (nursery only) |
| `@typescript-eslint/*` (20) | All 20. `no-array-constructor`, `no-unused-expressions` and `no-unused-vars` are TypeScript-aware under their core names | 18. Not ported: `no-unused-expressions`, `triple-slash-reference` |
| `jsx-a11y/*` (6) | All 6, `alt-text` options included | All 6 |
| `import/no-anonymous-default-export` | Yes | No |
| `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread`, `no-console` | All | All |
| `no-restricted-syntax` | Repo plugin (above) | No; GritQL |
| `grid/*` (4) | All, unchanged | 3 approximated, 1 impossible |
| **77 in all** | **69 native, 5 in the repo plugin, 2 unnecessary, 1 lost** | **47 (61%), plus approximations of 3 repo rules** |

### What oxlint does not have

| Rule | Status |
|---|---|
| `react/jsx-uses-react`, `react/jsx-uses-vars` | Not needed. They exist only to tell ESLint's core `no-unused-vars` that a JSX element uses a binding. oxlint's `no-unused-vars` reads JSX itself; 2,632 files lint clean with no false unused-variable reports |
| `react/no-deprecated` | **Lost.** It flags React APIs on their way out (`ReactDOM.render`, `findDOMNode`, legacy lifecycles). On React 19 most of them are gone from `@types/react`, so `tsc` refuses them; the `UNSAFE_*` lifecycles are the remaining gap. `src/` has one class component (an error boundary in `features/a2ui/A2uiCard.tsx`) and no legacy lifecycle |

Smaller differences: `settings.react.version` is pinned to `19.2` (oxlint has no
`detect`), and the disable comment on `UNIQUE_VIOLATION` in `lib/db/errors.ts`
now names `grid/no-restricted-syntax`.

### What Biome would have changed beyond coverage

On the unchanged tree, the migrated Biome config reported 26 errors and 128
warnings where ESLint reports none: 106 `useExhaustiveDependencies` (Biome also
flags dependencies it considers unnecessary), 19 `useAriaPropsSupportedByRole`,
2 `useHookAtTopLevel` reports that ESLint's `rules-of-hooks` does not make (not
triaged), and the rest on lines carrying `eslint-disable` comments, which Biome
does not read. Every one of the 52 directives would have to become a
`biome-ignore` comment with Biome's rule names.

## Decision

oxlint, as the only linter. It is the fastest option that keeps everything:

- The four repo rules, two of them security controls, run unchanged. Biome can
  approximate three and cannot express `require-tenant-cache-key`, which would
  have meant keeping ESLint and paying ~20 s for it.
- Of the 77 rules, 69 have a native equivalent and 5 run as the repo plugin.
  One is lost (`react/no-deprecated`) and two are not needed. Biome migrates 47
  and disagrees with ESLint on 120-odd existing lines.
- Existing `eslint-disable` comments work as written.
- No hybrid: one config, one binary, one output.

The cost, and why it is acceptable: oxlint's JS plugin support is **alpha and
outside semver**. If a release changed how plugins see scopes,
`require-tenant-cache-key` could start passing everything without a single
error. Three things hold that:

1. oxlint is pinned to an exact version (`1.85.0`, no caret).
2. The rule specs run under **oxlint's** `RuleTester` (`oxlint/plugins-dev`),
   the engine that runs the rules in `bun run lint`, so an upgrade that breaks
   scope analysis fails the specs. `require-tenant-scope` had no spec before; it
   has one now, including the shadowing and member-call cases.
3. `eslint-rules/lint-config.spec.mjs` lints planted violations through the
   real `.oxlintrc.json` and the real binary, and fails if any guarded rule
   comes back clean at the path it guards. It was checked by switching
   `require-tenant-cache-key` off and by breaking the `src/app` glob; it failed
   both times.

## What changed

- `frontends/ui/.oxlintrc.json` replaces `eslint.config.mjs` and the stale
  `.eslintrc.json`. Every category is off, so the explicit rule list is the
  whole rule set and an oxlint release cannot add rules unasked. The reasoning
  comments moved with the rules, and the card type-ramp file list is the
  `grid/card-type-scale` override.
- `eslint-rules/index.mjs` registers the `grid` plugin;
  `eslint-rules/no-restricted-syntax.mjs` is new. The directory keeps its name
  because the rules are written against ESLint's rule API, which is the API
  oxlint's JS plugins implement.
- `eslint`, `eslint-config-next` (and everything they pulled in) are removed.
  Next 16 no longer lints during `next build`, so nothing else needed them.
- `bun run lint` is `node scripts/check-static-utility-modifiers.mjs && oxlint src tests`.
  `task fe:lint`, CI and the husky hook call it unchanged.
- A suppression is now written `// oxlint-disable-next-line <rule> -- <reason>`.
  Existing `eslint-disable` comments keep working.

## Editor

Install the **Oxc** extension (`oxc.oxc-vscode`) and remove ESLint's: there is
no ESLint left to run. The extension uses the project's `oxlint` from
`node_modules`. In the devcontainer `oxc.path.oxlint` points it at
`frontends/ui/node_modules/.bin/oxlint`, because the workspace root has no
`node_modules`. It discovers `.oxlintrc.json` on its own. The language server
(`oxlint --lsp`, 1.85.0) reports the `grid/*` diagnostics along with the native
ones; this was checked by opening a file under `src/app/` with planted
violations over the LSP protocol. Other editors: any LSP client can run
`oxlint --lsp`. Prettier stays the formatter; the extension's oxfmt support is
not used.

## Follow-ups, not done here

- **oxlint's `correctness` category** would add 465 findings on the current tree.
  Among them: 20 `no-unsafe-optional-chaining`, 6 `no-control-regex` (the 9
  `no-control-regex` disable comments in `src/` are unused today because neither
  preset enables that rule), and React Compiler-style checks (`set-state-in-effect`
  134, `refs` 112). Worth triaging rule by rule. Switching the category on
  wholesale would bury the signal.
- **`--report-unused-disable-directives`** reports 12 stale directives (above).
  Removing them and adding the flag to `bun run lint` would ratchet that.
- **`check-static-utility-modifiers.mjs`** is now 1.1 s of a 3.8 s lint, the
  largest remaining share.
- CI needs no change: there is no lint cache to restore, and the job still runs
  `task fe:lint`.
