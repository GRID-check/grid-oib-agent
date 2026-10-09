# Lifecycle matrices

One matrix per heavy surface: every phase, every edge including the irregular
ones, every event, and for each row the expected behaviour, the fixture that
shows it and the check that holds it. The method, and why most surfaces should
not have one: [`../../contributing/lifecycle-matrix.md`](../../contributing/lifecycle-matrix.md).

| Target | Owner area | Fixture routes | Last QA pass |
|---|---|---|---|
| [Chat turn](chat-turn.md): question, Herleitung, streamed answer, settle, post-answer stages | `frontends/ui/src/features/chat/` | `/dev/stream-socket?scenario=…`, `/dev/turn-outcomes?scenario=…`, `/dev/herleitung`, `/dev/chat-turn`, `/dev/shared-thread` | 2026-10-09 (fixtures and checks reconciled; no full harness pass yet) |

## The bar for adding one

A new row here needs a surface that meets all four entry criteria in the method
doc: asynchronous inputs over time, motion, several owners of the same pixels,
and irregular exits at more than one phase. A form, a dialog or a list page does
not qualify; its component spec and `/dev` preview already cover it.

To add one, copy [`_template.md`](_template.md) to `<target>.md`, fill it, and
add the row above in the same PR. Update "Last QA pass" whenever you run the
harness and recordings over every scenario.
