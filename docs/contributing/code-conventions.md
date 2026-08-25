# Code conventions

House rules that are not obvious from the code, each one written down because
somebody already paid for it. Language defaults and formatting live in the
tooling (`ruff`, `eslint`, `tsconfig`), not here.

## Python

Ruff, line length 120, Python 3.11. New tools use `@register_function` with a
`FunctionBaseConfig` subclass.

## TypeScript

### `any` is not a type we accept, in production code or in tests

`@typescript-eslint/no-explicit-any` is an **error** in
`frontends/ui/eslint.config.mjs`, and the suite is clean. Reach for the real
type, a `Partial<T>` or `Pick<T, …>` of it, `unknown`, or a deliberate
`as unknown as T` at a single documented boundary.

For spec fixtures use the shared helpers rather than casting:

- `@/test-utils/store-fixtures`: `DeepPartial<TState>` plus `asStoreState` for
  zustand selector mocks. The fixture stays partial and every field is still
  checked against the real store.
- `@/test-utils/db-fixtures`: `makeProject`, `makeDocument`, `makeMemoryItem`
  for whole repository rows, and `asDb` for the one drizzle query-builder-stub
  boundary.

`any` in a test double is how fixtures silently drift from the code they stand
in for.

`no-console` allows `warn`, `error` and `debug`. `console.debug` is the dev-only
diagnostic channel and its call sites are `NODE_ENV`-gated.

### Raw `sql<T>` results are not runtime-validated, so coerce at the repository boundary

Drizzle decodes column values only for direct column references. A raw
``sql<Date>`max(...)` `` or ``sql<number>`count(...)` `` fragment is a
compile-time assertion and nothing more, so `tsc` and the LSP see no error even
when the driver hands back a string.

Convert on the way out of the repository (`new Date(row.x)`, `Number(row.x)`)
and never trust the annotation downstream. A missing coercion here produced the
profiler's `toISOString is not a function` crash; that fix and its
`totalDurationMsRaw` sibling are the reference pattern.

### A general-purpose helper belongs in a shared module

Before writing a text transform, a formatter, a date or number helper, or any
other utility that is not *about* your feature's domain, search for an existing
one. If you write a new one, put it where the next caller will look:
`lib/text/`, `lib/utils/`, `lib/format.ts`. `features/<x>/lib/` is for logic
that really is domain logic.

A private copy inside a feature file is a fork. The copies drift, and the drift
is invisible because each one looks locally correct. German transliteration
(`ä`→`ae`, `ß`→`ss`) existed in `MarkdownRenderer.tsx` and in
`norm-entry-editor.tsx`, and a third was being written into `lib/bim/bcf.ts`,
where its absence had been shipping `Beispielstraße` as the filename
`Beispielstra-e`. All three now call `lib/text/latinize.ts`.

Sharing is not merging. Keep the pieces that genuinely differ separate and say
why: `latinize` splits into `transliterateGerman` and `foldDiacritics` precisely
because Markdown anchors must not gain diacritic folding, since their ids are
already published in links. `bucket.ts`, `MentionPicker` and `passage-highlight`
each document why they keep their own fold. **Document the non-adopters.** An
unexplained holdout reads as an oversight and gets "fixed" later.

## Capability doctrine

Four terms, kept distinct on purpose:

| Term | What it is |
|---|---|
| Feature flag | A product decision |
| Environment variable | A real infrastructure dependency |
| Capability | Derived from a dependency, never a second flag |
| Availability | Flag AND capability |

Image upload is the worked example: the `image-upload` flag AND `vlm_available`,
which is derived from the VLM key. Do not add a redundant environment opt-in for
something the dependency already implies.
