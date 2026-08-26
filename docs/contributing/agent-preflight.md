# The agent preflight

`task setup` is the first line of [`AGENTS.md`](../../AGENTS.md), and until now
nothing made it happen. This page is the machinery that does, why it is shaped
this way, and what it does not cover.

## The failure it removes

An agent that starts editing before setup runs is working in a checkout where
`task` is not on PATH, `.venv/` does not exist, `node_modules/` is empty and
`.claude/skills/` was never published. Nothing announces this. What the agent
notices is that `task verify` is not a command, that `pytest` cannot import
`aiq_agent`, that `bun run lint` has no lint. So it debugs the environment
instead of the task — or it decides the checks are broken here and pushes a
change it never verified.

The instruction alone did not hold, because a written instruction competes with
the task for the same attention, and the agent has no symptom to connect it to
until it is already several edits in.

## One script, every harness

[`scripts/agent-preflight.sh`](../../scripts/agent-preflight.sh) is the single
definition of "this checkout is ready". It is plain bash and knows nothing about
any agent.

| Invocation | What it does |
|---|---|
| `scripts/agent-preflight.sh` | Provision if needed, then verify. Idempotent, and a no-op in about 50 ms once provisioned |
| `scripts/agent-preflight.sh --check` | Verify only. Exit 1 and print each missing piece, naming the install step that did not run |
| `scripts/agent-preflight.sh --print-env` | Emit the `export` lines for this checkout — `eval "$(scripts/agent-preflight.sh --print-env)"` |

Provisioning is `task setup` plus the two things around it that `task setup`
cannot do for itself:

- **Bootstrapping go-task.** `task setup` cannot install the tool that runs it,
  and nothing else in this repo installs go-task either. When `task` is absent
  the script installs a pinned `@go-task/cli` into `.tools/` (gitignored) and
  puts it on PATH — locally, never a global prefix an agent may not own.
- **Installing the git hooks.** [`CONTRIBUTING.md`](../../CONTRIBUTING.md) calls
  `pre-commit install` the most important setup step and `task setup` leaves it
  out. Skipping it is how repo-wide lint debt is re-discovered in CI.

`--print-env` puts `.venv/bin` first on PATH and sets `PYTHONPATH=src`, so
`pytest`, `ruff` and `pre-commit` behave as the docs describe without anyone
remembering to activate anything, and the
[`PYTHONPATH` footgun](gotchas.md) cannot fire.

### What "ready" means

Two independent conditions, because either one alone lies:

1. **Markers exist** — `.venv/`, the four `node_modules/` trees, `.claude/skills/`.
   A missing marker names the step that did not run, rather than reporting a
   generic failure.
2. **The stamp matches the lockfiles.** `.agent-preflight.stamp` holds a hash of
   `uv.lock`, `apm.lock.yaml`, `bun.lock` and the three `package-lock.json`
   files. This is `AGENTS.md`'s "after any pull that moves a lockfile",
   mechanised: pull a lockfile change and the checkout stops being provisioned
   until setup runs again.

## How Claude Code is wired

Two hooks, both committed, registered in `.claude/settings.json`:

| Hook | Fires | Does |
|---|---|---|
| `SessionStart` | Session start, resume, `/clear` | Runs the preflight synchronously, then appends `--print-env` to `$CLAUDE_ENV_FILE` so `task` and the venv are on PATH for the whole session |
| `PreToolUse` on `Edit\|Write\|MultiEdit\|NotebookEdit` | Every file edit | Exits 2 — which blocks the call and hands Claude the reason — when `--check` fails |

**`SessionStart` is the mechanism; `PreToolUse` is the backstop.** The normal
path is that setup has already finished before the first turn, and the guard
never fires. It exists for the session where setup failed, and its job there is
to stop an unverifiable edit rather than to make anyone re-run a command.

It is deliberately **synchronous**. A hook that provisions in the background
gives a faster session start and reintroduces exactly the race it was written to
remove: the agent runs `task be:test` while `uv sync` is still resolving.

Three files under `.claude/` are therefore **source**, not generated:
`settings.json` and the two hooks. Claude Code reads hooks from
`.claude/settings.json` and nowhere else, so a gitignored copy would reach
nobody who clones this repo. `.gitignore` un-ignores exactly those three;
everything else under `.claude/` is still apm's output and still ignored, and
apm only ever writes `.claude/skills/`. See [agent-skills.md](agent-skills.md).

### What it does not cover

Say this plainly rather than trusting a gate that has holes:

- **The `Bash` tool is not gated.** An agent can write a file with `sed -i` or a
  heredoc. Gating `Bash` would also block the command that fixes the problem.
  This costs little in practice because `SessionStart` has normally already
  provisioned the checkout — the guard is not what makes the environment
  correct, it is what refuses to pretend when it is not.
- **Project hooks need workspace trust.** Claude Code asks before running hooks
  from a repository the user has not trusted. An untrusted checkout gets no
  preflight and no guard.
- **Other harnesses get the instruction, not the gate.** They are covered by the
  line in `AGENTS.md` and by CI, which runs the same tasks and fails on the same
  things. Wiring one properly is one entry in that harness's own config, calling
  the same script — the script is why that stays a one-liner.
- **Windows** needs a bash (Git Bash is enough). Without one the hooks do not
  run and nothing is enforced.

## The escape hatch

`GRID_AGENT_PREFLIGHT=skip` disables both hooks for a session. It exists because
a gate that can strand you is a gate people delete, and because the preflight
needs a network it will not always have.

Two things are exempt from the guard even without it, so a bug in this machinery
is never a lockout: `scripts/agent-preflight.sh` and everything under
`.claude/hooks/`.

## Adding a harness

The wiring points, in the order they are worth doing:

1. Point the harness's own startup or pre-edit hook at
   `scripts/agent-preflight.sh`. That is the whole integration.
2. Nothing else. Do not restate what setup installs in a second place — the list
   lives in `Taskfile.yml`'s `setup` task, and a copy of it in a harness config
   is one more thing to keep true.

The devcontainer's `postCreateCommand` is the worked example.
