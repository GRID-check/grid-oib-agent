# Audit and feedback run logs

Frozen working files from agent loops that have finished. They are kept for
provenance: several accepted specs cite them as the evidence behind a decision,
by item id. Nothing here is live — do not append to these files, and do not
treat an open item in one as work that is still queued.

| File | What it recorded | Period |
|---|---|---|
| [`feedback-backlog.md`](feedback-backlog.md) | Colleague feedback triage, verified against the code (`FB-*` ids) | from 2026-07-14 |
| [`ux-system-audit.md`](ux-system-audit.md) | UX system audit, rounds 0–8 | from 2026-07-10 |
| [`overnight-run-log.md`](overnight-run-log.md) | Overnight run cycles, one entry per cycle | from 2026-07-05 |

Who cites these:

- [`../design/click-dummy-overhaul-spec.md`](../design/click-dummy-overhaul-spec.md)
  draws its scope from `feedback-backlog.md` (FB-2/4/6/8/9/10/11/12) and `ux-system-audit.md`.
- [`../../plans/2026-07-16-ris-catalog-index-design.md`](../../plans/2026-07-16-ris-catalog-index-design.md)
  cites `feedback-backlog.md:106`.
- [`../architecture/rag-system-audit-2026-08.md`](../architecture/rag-system-audit-2026-08.md)
  cites `feedback-backlog.md` and `overnight-run-log.md`.

The live loop state is [`backlog.md`](../../backlog.md) in the repo root; that
one is still worked and is not archived here.
