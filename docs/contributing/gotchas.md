# Gotchas

**Read this when something surprises you, before you start debugging it.** Every
entry cost somebody real time once. Finding yours here turns an afternoon into a
minute, and that is the whole return on the
[correction ratchet](correction-ratchet.md).

Entries are indexed by the **symptom you actually arrive with**, because you
arrive with an error message and not with a category. Search this page for the
string you are seeing.

## Tooling and environment

| Symptom | Cause | Do this |
|---|---|---|
| Backend tests pass, but the code you changed is clearly not running | `pytest` resolved `aiq_agent` from whatever the venv installed, possibly another worktree | Set `PYTHONPATH=src`. `Taskfile.yml` does it for you; call `pytest` directly and you own it |
| `uv run` fails to import a knowledge-layer module | `uv run` resolves an environment without the `sources/` workspace packages | Use the venv `uv sync --group dev` builds, which is what the Taskfile does |
| Turbopack's PostCSS step dies spawning `node` | Someone added `--bun`, which exports `NODE_OPTIONS=--bun`, and real `node` rejects the flag | Bun is the installer and script runner here, never the runtime. Do not add `--bun` |
| `next build` fails on a file that is only a test | The UI `tsconfig` includes spec files, so a spec type error blocks the production build | Run `task fe:types`; it is the signal that the build will typecheck |
| A required check fails that `task verify` never ran | `task db:test:rls` needs PostgreSQL server binaries, so it is not part of `verify` | Run it separately whenever you touch the tenant boundary |
| trivy's `image-scan` job fails with `failed=0` | Five parallel `docker run --rm` pulls of `trivy-db` from GCR return 429 | The DB is downloaded once into a shared cache and reused with `--skip-db-update`. Keep it that way |
| `Image vulns (trivy)` takes four minutes again, not twenty seconds | Its layer-analysis cache is keyed on the pin set and the trivy version, and one of the two moved | Expected, once: the run that pays for the walk repopulates the cache for the next one. A job that keeps paying it means the cache is not being saved |
| `apm audit` reports drift against files nothing wrote | apm 0.28 resolves targets differently in `install` (claude) and in the `audit` replay (also agents) | `apm.yml` pins `targets`. Leave it pinned |
| `reno lint` dies with `KeyError: b'<sha>'` | The container's clone is shallow, so reno cannot walk to a commit's parent. Nothing is wrong with your note | Run `task release:lint`'s first command (`scripts/release_notes.py lint`), which reads the notes as prose and needs no history. CI checks out full |
| A `grep` finds nothing in a file where the string is plainly visible | An invisible character, e.g. a zero-width space (`U+200B`), sits inside the match | `task agents:audit` scans for hidden Unicode. `apm audit --strip` removes it |

## Data and correctness

| Symptom | Cause | Do this |
|---|---|---|
| `toISOString is not a function` on a value `tsc` says is a `Date` | A raw ``sql<Date>`max(...)` `` fragment is a compile-time assertion only. Drizzle decodes column values only for direct column references | Coerce at the repository boundary (`new Date(row.x)`, `Number(row.x)`). See [code-conventions.md](code-conventions.md) |
| A composite foreign key silently permits a bad row | Composite FKs are MATCH SIMPLE, so the check is skipped when **any** column of the key is NULL | Add a CHECK asserting the columns are populated together. `documents_folder_requires_project` is the worked example. MATCH FULL is the reflex fix and is wrong |
| Cached project context comes back belonging to another tenant | `getCached` returns before the loader runs, so a key without the organization serves whatever the first caller populated, never entering the tenant scope | Put the organization in the cache key. `lib/project-profile/prompt-view.ts` is the pattern |
| A tenant-scoped query returns rows it should not | The `WHERE organization_id` was lost, widened by a join, or written as a raw fragment | Row-level security is the backstop, not the plan. Check the table joined the boundary via `grid_secure_table` |

## On a phone

| Symptom | Cause | Do this |
|---|---|---|
| A region of a page swallows every swipe — the finger moves, the page does not, but taps still work | Something in the ancestor chain sets `touch-action` to a value that refuses the vertical pan, usually a third-party stylesheet claiming a gesture. React Flow's `.react-flow__pane` did exactly that to the whole reasoning graph, for pan and zoom the graph had already disabled in its props | The browser intersects `touch-action` over the touched element **and every ancestor**, so reading the computed style of the thing you touched tells you nothing — walk outward. `task fe:touch-audit` reports these as `SCROLL TRAP`. Scope the override to a class the component opts into, so a component that really does own the gesture keeps the default |
| `truncate` does nothing and a list scrolls sideways instead | The cell is in a `table-layout: auto` table, where a column is sized to its content's **minimum** — and a filename does not wrap, so the minimum is the whole name | `table-fixed` plus a declared width on every column but one. Hiding columns at `sm`/`md` does not help: it removes the columns that were not the problem |
| Tapping a control does something, but not the thing under the finger | Two `touch-target` catchments overlap, and the later element in the DOM takes the tap | The utility is for a control with room around it. Stacked rows and inline neighbours must GROW (`pointer-coarse:py-*`) instead. `frontends/ui/src/features/grid-cards/components/card-rows.ts` explains the split |
| iOS zooms into the page when a field is focused and never zooms back out | A text field under 16px. The primitives carry `text-sm … pointer-coarse:text-base`; a hand-written `<input>` inherits none of it. The floor is on the POINTER axis: built out of a breakpoint (`text-base … md:text-sm`) it is not a floor at all, because a coarse-pointer tablet past `md` renders 14px and zooms anyway | `frontends/ui/src/components/ui/mobile-affordances.spec.ts` fails on this now. Use the primitive, or carry the same floor |
| A control is invisible on a phone but present in the DOM and focusable | `opacity-0 group-hover:opacity-100` with no touch escape — a touch device generates no hover | Add `pointer-coarse:opacity-100`, or invert to `md:opacity-0` so it is visible below the breakpoint. Also guarded by `frontends/ui/src/components/ui/mobile-affordances.spec.ts` |

## Documentation and agent setup

| Symptom | Cause | Do this |
|---|---|---|
| A skill that exists on disk never loads | Ten entries under `.claude/skills/` and `.agents/skills/` were committed as **text files containing a path** (git mode `100644`) rather than symlinks (`120000`), so nothing resolved | Fixed structurally: `skills/` is the one source and apm publishes it to every harness. Never commit into `.claude/` or `.agents/` |
| apm rejects `agents` as a target | `agent-skills` is the manifest name for the shared `.agents/skills/` path; `agents` appears only in the CLI's `--target` help | Use `agent-skills` in `apm.yml` |
| A relative link passes your local check and CI still calls it dead | You verified against your working tree, where gitignored paths like `.claude/` still exist. CI checks out fresh, where they do not | Resolve links against `git ls-files`, not the filesystem. A link into a generated directory is dead for every reader |
| `task verify` fails at `infra:types` right after `task setup` on a fresh clone | `setup` installed `deploy/pulumi/policy` but not `deploy/pulumi` itself, so the program's own TypeScript and Vitest were missing | Fixed in `Taskfile.yml`: `setup` now installs both |
| Per-turn LLM cost grows with the size of a project | Something builds a prompt block by iterating documents, bindings or memories with no bound. It is paid on every turn, including chit-chat | Carry the shape, not the list: one line per category with a count, and a route to the members. `buildDocumentRolesSection` and the folded Basiswissen shelf in `render_inventory_block` are the worked examples. A constant corpus is the clearest case: it is identical on every turn, so retrieval reaches it and the prompt need only say how many |
| The agent answers a "which files do I have" question confidently and wrongly | A cap shortened the list on its way into the prompt, and the block presented the remainder as the whole shelf. Listing turns route to `intent="meta"`, which binds no search tools, so there is no retrieval to fall back on | A cap says so in the text the model reads, per group, not only in the operator's log. `render_inventory_block` is the worked example |
| The frontend validates a card field you already removed from the Pydantic model | `shared/cards/schemas.json` and `frontends/ui/src/shared/cards/generated.ts` are generated and committed, and a stale generated module type-checks perfectly, so nothing local objected | Closed by the `card-schemas` pre-commit hook, which runs both generators and fails if either changes anything. To regenerate by hand: `uv run python scripts/generate_card_schema.py`, then `npm run generate:cards` in `frontends/ui`. See [patterns-in-use.md](../architecture/patterns-in-use.md#generated-artifacts-guarded-by---check) |
| A Tailwind colour class renders with no fill and nothing warns | The class used a slash-opacity modifier (`bg-warning/15`) against a **static** Tailwind v4 `@utility`, which matches literally, so the class matches no rule and is dropped | `node scripts/check-static-utility-modifiers.mjs`, wired into `bun run lint` |
| A doc contradicts the Taskfile | The doc predates `task verify` and still prescribes a throwaway Docker image or `.venv/Scripts` paths | The Taskfile is the source of truth for commands. Fix the doc in the same change |
| The user had to say "keep going" | The agent stopped at a boundary to ask permission for reversible work that was already agreed | Predict the answer before asking. If it is "yes", proceed and report instead. See [working-style.md](working-style.md#finish-the-task) |
| `task: command not found` on a fresh clone or a new container | Nothing in the repo installs go-task, and `task setup` cannot install the thing that runs it | `npm i -g @go-task/cli`, then `task setup`. Both are the first block of [`AGENTS.md`](../../AGENTS.md#setup) |
| The agent ignores a rule that is plainly written in `AGENTS.md` | Claude Code reads `CLAUDE.md`, never `AGENTS.md`, and bridges them with an `@AGENTS.md` **import**. Written without the `@` it is prose naming a filename, the guide never loads, and `/context` still shows a memory file | Check the bridge is exactly `@AGENTS.md`. Closed by `scripts/check_agent_docs.py` in `task lint:repo`; this was the root bridge's state for its whole life |
| A scoped `AGENTS.md` did not apply until halfway through the session | Claude loads a nested `CLAUDE.md` only after it **reads a file** in that directory, and never for a question answered without opening one | Open the scope's guide yourself rather than waiting for the harness: `ls */AGENTS.md`. See [`AGENTS.md`](../../AGENTS.md#where-the-scoped-guides-are) |
| A change under `sources/` merged with its own tests never run | `be:test:ci` covers `tests/` only; the `pytest` hook that covers `sources` is `stages: [push]`, and CI's repo-lint job SKIPs it | Run `pytest sources -q` yourself. See [`sources/AGENTS.md`](../../sources/AGENTS.md) |
| A change under `packages/` passed every gate without being checked | `Taskfile.yml` names no `packages/` target and `ci.yml` has no `packages/**` paths filter | Run the suites by hand; see [`packages/AGENTS.md`](../../packages/AGENTS.md) |
| Two ADRs share a number, or the index disagrees with the file | The next number was taken from the README index, which lags the directory | `python3 scripts/check_adrs.py --next`. Closed by `scripts/check_adrs.py` in `task lint:repo` |
| `AGENTS.md` is growing again | Project knowledge is being written where only ways of working belong | Give it a home under `docs/contributing/` and leave a one-line pointer. See [documentation.md](documentation.md) |

## Adding an entry

Add one the moment a failure costs you more than a few minutes, while you still
remember the symptom string. Three columns, and the symptom column is written as
what you would have searched for, not as a tidy summary after the fact.

Then ask the ratchet question: can this be closed rather than documented? A
CHECK constraint, a lint rule, or a failing test beats an entry here, and an
entry here beats nothing. When you do close it, keep the row and say what closed
it, so the next person meeting the old symptom in an old branch still lands
somewhere useful.
