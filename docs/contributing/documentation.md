# Documentation obligations

Updating documentation is part of the change that alters behaviour, not a
follow-up. A change is not done until the docs it invalidates are correct.

## What to update when

| You changed | Update |
|---|---|
| Architecture, a data flow, a subsystem, a cross-cutting mechanism | `docs/architecture/backend-deep-dive.md` and the specific subsystem doc |
| A significant or hard-to-reverse decision (new subsystem, transport, storage, provider model, security boundary) | Add an ADR under `docs/adr/`, copying `0000-template.md` with the next number |
| An environment variable, config key, or default | [`../deployment/environment-variables.md`](../deployment/environment-variables.md) |
| An API route, WebSocket message, or tool contract | `docs/api/` |
| A database schema or migration | `docs/database/` |
| User-facing behaviour | the relevant `docs/user-guides/` page |
| Setup, containers, or the run and verify flow | `README.md` and [`testing-and-verification.md`](testing-and-verification.md) |
| A shareable-resource, inbox or mentions substrate leak you lifted or found | `docs/architecture/adding-a-shareable-resource-type.md`, §1 for paid debt and §3 for new leaks |
| A way of working, or a quirk that cost you an hour | this directory. See [README.md](README.md) |

The last row is the one people skip, and it is why `AGENTS.md` used to grow
without limit. A quirk that lives only in a reviewer's head gets rediscovered by
everyone, one at a time.

## Rules of thumb

- Prefer updating an existing doc over adding one.
- Delete a doc a change makes wrong rather than leaving it stale.
- Keep `docs/architecture/` and the ADR log as the source of truth for how the
  system works; keep this directory as the source of truth for how we work.
- If a change is significant enough to explain in a pull request, it is
  significant enough to document in the repo.

## Link hygiene

`markdown-link-check` runs in CI, so links must resolve on disk. Use
repo-relative paths rather than guessed ones, and match GitHub's heading slugs
(lowercase, spaces to hyphens). Details in
[`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
