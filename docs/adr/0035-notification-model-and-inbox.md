# ADR-0035: The notification model — a generic item frame, a type registry, and the database as the record

- **Status:** Accepted
- **Date:** 2026-07-29
- **Deciders:** Platform engineering
- **Related:** ADR-0011 (deletion pipeline), ADR-0012 (cards as the rich-UI layer),
  ADR-0020 (Dragonfly shared cache), ADR-0032 (shareable-resource model),
  ADR-0034 (mention hand-off), ../design/collaboration-sharing-and-inbox-spec.md (§8, §9)

## Context

The product has no notification of any kind: no inbox, no unread count, no mention, no
"something needs you" surface. The collaboration feature needs one, and the stated
product requirement is that it must be **extensible without redesign** — the first item
type is a mention request, and the tenth might be a document awaiting review, a failed
workflow run, a budget threshold, or a compliance lane assignment.

Two design forces pull against each other:

- A **typed** notification per kind (a table or a component per type) is clear but makes
  every new kind a schema change plus a UI change. That is the cost the requirement
  explicitly rules out.
- A **fully generic** bag ("here is some JSON, render it") is extensible but produces
  unrenderable rows, untranslatable copy, and no way to compute a count of "things that
  need me".

There is also a storage temptation. The product runs Dragonfly as a shared cache tier
(ADR-0020) with pub/sub already in use for chat, and notifications are the classic
pub/sub example. But that tier runs `cache_mode=true`, with **no persistence volume**,
and evicts under memory pressure; ADR-0020 states explicitly that nothing whose loss is
intolerable may live there. A notification the user never sees because a cache evicted
it is a lost request for help.

Finally, notifications are a **security surface**: an item quotes content from a
resource, and access to that resource can be revoked after the item is created.

## Decision

**We will store notifications as rows in `grid_app` with one fixed frame plus a typed
payload, drive all rendering from an exhaustive type registry, and use pub/sub purely
as an accelerator.**

1. **One table, one frame.** Every inbox item carries the same columns: recipient,
   organisation, type, target (resource type + id), actor, a grouping key, a JSON
   payload, a count, and lifecycle timestamps (`read_at`, `resolved_at`,
   `archived_at`, `inert_at`). Adding a type never changes the frame.

2. **One registry, exhaustive by construction.** Each type declares: actionable or
   informational, its icon, its localised title/body keys (German and English), its
   target resource type, its grouping strategy, and its retention period. A type that
   is not in the registry cannot be created, and the generic renderer can render every
   registered type from its entry alone. A custom renderer is an optimisation, never a
   requirement.

3. **Actionable versus informational is a first-class distinction.** Actionable items
   represent an outstanding request against the recipient, can be **resolved by domain
   events** (not only by being dismissed), and are what the badge counts. Informational
   items are read and archived.

4. **Grouping, deduplication and idempotency are one database constraint.** A unique
   index on `(recipient, group_key)` with an upsert that increments the count and
   touches the timestamp gives all three properties at once: twenty new messages in one
   thread become one row with a count of twenty; a retried emission is a no-op rather
   than a duplicate.

5. **The database is the system of record; the cache tier is an accelerator.** Item
   creation happens in the **same transaction** as the event that caused it, so if the
   mention was stored, the item exists. Live delivery may drop anything and lose nothing
   — a plain fetch on open, on focus, or on poll always yields the true state.

6. **Items are pointers, not copies — and access is re-checked at read time.** Any
   quoted snippet is a display convenience. An item whose target the recipient can no
   longer reach is hidden or redacted; it is never a working link. Revocation and
   deletion additionally mark items inert in the same operation, so the common case
   needs no filtering.

7. **Items are derivative data with retention**, purged on a per-type schedule and
   destroyed with their target through the existing deletion pipeline rather than a
   parallel mechanism of their own.

8. **The item is separated from its delivery.** Phase 1 delivers in-app only. Because
   "what happened" and "how the person was told" are distinct, email, push and digests
   are additive later, and per-type/per-channel preferences have an obvious home.

9. **Live fan-out is authorised at publish time, on a per-user channel.** The server
   resolves a resource's participants and publishes to each recipient's own channel, so
   a subscriber can only ever receive what was addressed to them. Browsers never
   subscribe to a resource channel and filter locally.

## Consequences

### Positive

- A new notification type costs a registry entry plus two translations. The requirement
  that motivated the whole design is met structurally, not by discipline.
- The badge is one indexed count over one table, cheap enough for every page render.
- Notifications cannot be lost by a cache eviction, and cannot be duplicated by a
  retry — both properties come from the database rather than from careful code.
- The inbox cannot become a loophole for revoked access, because access is re-derived
  when the item is read and revocation eagerly marks items inert.
- Per-user channels make the authorisation argument trivial: there is no shared channel
  to accidentally over-subscribe to.

### Negative

- **Read-time re-authorisation costs work per list render.** Bounded by capping the list
  and by batching the distinct targets, and softened because eager inert-marking means
  the filter usually finds nothing to remove.
- A denormalised `actionable` flag duplicates a fact the registry owns, in exchange for
  an indexable count. If a type ever changed kind, existing rows would need a backfill.
- Publishing to N participant channels is N publishes per event. Fine at present scale;
  it would need revisiting for very large participant sets.
- Emitting inside the causing transaction means a notification bug can fail a user
  action. Accepted deliberately: the alternative (fire-and-forget) trades a visible
  failure for a silent lost request, which is worse for this feature.

### Risks

- **The generic renderer degrading into per-type special cases**, defeating the point.
  Mitigated by requiring the registry entry to be sufficient, and by treating a type
  that needs bespoke rendering as a design smell to be justified.
- **Snippets outliving their access** if an inert transition is missed. Mitigated by
  double protection: eager inert-marking *and* read-time re-authorisation, so either
  alone is sufficient.
- **Notification spam** making the inbox worthless. Mitigated by grouping, by
  deduplication windows, and by rate limits on the actions that generate items.

## Alternatives Considered

- **A table per notification type.** Rejected: it makes every new type a migration plus
  a query plus a component, which is precisely the cost the requirement excludes.
- **Store notifications in Dragonfly and fan out over pub/sub.** Rejected outright:
  cache mode, no persistence, evicts under pressure (ADR-0020). A dropped mention
  request is a lost request for help.
- **Emit notifications asynchronously via a queue.** Rejected for phase 1: it adds a
  second failure mode and an at-least-once story for a volume that a same-transaction
  insert handles trivially. Revisit if fan-out to large participant sets becomes hot.
- **Copy the content into the item** so it renders without the target. Rejected: it
  turns every notification into an access-control leak that survives revocation.
- **Let the browser subscribe per conversation and filter client-side.** Rejected: it
  puts authorisation in the client and would send participants' content to
  non-participants.
- **Count actionable items by deriving the type set in SQL on every read** instead of a
  denormalised flag. Rejected: it prevents a straightforward partial index on the one
  query that runs on every page render.

## Open Questions / Follow-ups

- Per-type/per-channel preferences, digests and email (spec IB-11, IB-12) — the split is
  in place; the delivery work is deferred to phase 2.
- Retention enforcement runs on the existing deletion/purge worker cadence; the exact
  schedule per type is set in the registry and can be tuned once real volume exists.
- Reminders/escalation for unanswered actionable items (spec MN-17) reuse this model.

## References

- ../design/collaboration-sharing-and-inbox-spec.md — §8 (IB-1…IB-21), §9 (RT-1…RT-8)
- ADR-0020 (why the cache tier cannot be the store), ADR-0011 (deletion pipeline)
