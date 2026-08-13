# File-native work objects — design

Date: 2026-08-13
Status: proposed (awaiting review)
Branch: `feature/document-ownership` (worktree `.worktrees/document-ownership`)

Related: [ADR-0032](../../adr/0032-shareable-resource-model.md),
[ADR-0035](../../adr/0035-notification-model-and-inbox.md),
[ADR-0045](../../adr/0045-ifc-models-as-a-queryable-building-not-a-document.md),
[ADR-0047](../../adr/0047-assignment-is-not-access.md) (proposed),
[adding a shareable resource type](../../architecture/adding-a-shareable-resource-type.md),
[collaboration spec](../../design/collaboration-sharing-and-inbox-spec.md) Phase 3,
[citation pipeline](../../architecture/citation-system-audit-2026-07.md).

## Problem

A project file is evidence the agent can retrieve, quote, draw, and (for IFC)
query. The Files page does not know that. It is a library: upload, folders,
preview, tags, rename, delete. `createdBy` is written at upload and never
shown. There is no responsible person, no “ask about this document”, no way to
walk up to a colleague from the file.

Two further mistakes would make this worse rather than better:

1. **Treat the uploader as the owner.** Bulk upload makes that a lie. A file
   can have nobody on the hook, or several people. Unassigned is a fact.
2. **Bolt a document type onto the collaboration substrate as it stands.**
   ADR-0032 promised a second consumer would cost a registry entry.
   [`adding-a-shareable-resource-type.md`](../../architecture/adding-a-shareable-resource-type.md)
   measured the promise: mentions, events, cleanup, orphan sweeps, routes, and
   ~20 “generic” strings are still conversation-shaped. A visibility write on a
   new type silently no-ops and leaves a truthful-looking audit row. Shipping
   documents on top of that is not YAGNI. It is a second consumer that makes
   the substrate’s defects load-bearing.

## Principle: YAGNI forbids unused features, not known defects on the path

YAGNI still applies to *product* scope: no PDF pin-comments, no RACI matrix, no
compliance board, no Drive clone, no live co-editing.

YAGNI does **not** apply to a substrate whose own audit says the next consumer
will silently mislabel events, never clean up, or lie in the audit trail.
That is not strategic debt. Strategic debt is *unrelated* work, or *expansion*
of a working primitive. Correlated debt — the thing you would have to work
around, switch on, or leave unread in a descriptor — is in the change that
tripped over it, as its own atomic commits.

This is the same rule as “fix causes, not symptoms” and “never dismiss
pre-existing breakage”, specialised to extension points. It is now an
obligation in `AGENTS.md` and the closing section of the shareable-type doc.

## Decisions

1. **A file is three things:** bytes (library), a **subject** of a conversation
   (utilization), and a **place** with people (assignment + later sharing).
2. **People are three relations.** Do not collapse them.
   - *Provenance* — who put the bytes here (`createdBy`). Keep. Never render as
     “verantwortlich”.
   - *Access* — who may open or manage this (project membership today;
     shareable-resource grants when we need private drafts).
   - *Assignment* — who is on the hook. 0..n people. Empty is valid and
     visible (“Unvergeben”).
3. **Assignment is not the `owner` share role.** Owner means “can change the
   roster” and the last-owner invariant forbids empty. Responsibility must be
   allowed to be empty — that is the bulk-upload state and a project-health
   signal. See ADR-0047.
4. **Assignment is polymorphic from day one**, same key as shares and inbox:
   `(resource_type, resource_id, subject_user_id)`. Documents are the first
   consumer. A later compliance lane is a registry entry, not a second table.
5. **`document` is the second shareable-resource consumer.** Default visibility
   stays `project` (today’s everyone-on-the-project-can-see). Private drafts
   become possible once the type is registered; they are not the first UI.
6. **The substrate lifts in
   [`adding-a-shareable-resource-type.md`](../../architecture/adding-a-shareable-resource-type.md)
   §3.1–§3.10 are in this change.** None are deferred. They land as their own
   commits, *before* the document descriptor is more than a registry entry.
   Bolting the descriptor on first and “cleaning up later” is the failure mode
   this spec exists to forbid.
7. **Utilization uses machinery that already exists.** `?ask=` prefill (IFC
   elements and applicable standards already do this). `include_file_names` is
   the twin of the existing `exclude_file_names` filter. `view_knowledge_image`
   already renders a plan page. The citation model already groups at
   `(collection, filename)` with loci at page. We add doors, not a second
   intelligence stack.
8. **First vertical is project files.** Archiv assignment and org-container
   *product* behaviour can wait. The substrate still grows a real container
   probe (§3.10) so Archiv does not inherit a lie.

## The two planes

```
                    ┌─────────────────────────────────────────┐
                    │            A project file               │
                    └───────────────┬─────────────────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           ▼                        ▼                        ▼
    Plane A — utilize         Plane B — people         Library (exists)
    the agent we have         on the file              upload / preview /
                                                       tags / folders
    • Ask Piloti              • Assignment 0..n
    • Document focus          • Unvergeben state
    • Docked preview          • Ask Anna (mention +
    • Citation → ask again      inbox → file as subject)
    • Activity (cited-by)     • document on SHAREABLE_
                                REGISTRY (access, later)
                                    │
                                    ▼
                    Substrate must be generic first
                    (§3.1–§3.10 paid down, atomic commits)
```

The thin vertical that proves both planes on one object: open a file → it can
have nobody or several responsible people → **Piloti dazu fragen** (subject +
filename focus) and **Kollegin fragen** (assignment + mention + inbox, landing
on the same subject).

## Plane A — utilization work pieces

Each piece is a function with one job.

| # | Piece | What already exists | What we add |
|---|---|---|---|
| A1 | `documentQuestionHref` | `elementQuestionHref`, `askGridHref`, `?ask=` consumption in `project-chat-client` | Same shape for a document. Preview primary action + file-card action. |
| A2 | Document focus | `exclude_file_names` on knowledge retrieval; `available_documents` inventory; `view_knowledge_image` | `include_file_names` (or equivalent metadata `$in`). Conversation subject = document id. Composer chip “Frage zu …”. Retrieval and image-view prefer that file. Inventory still lists the rest; this file is the subject. |
| A3 | File-docked chat | PDF viewer already highlights a cited passage; preview pane already exists | Preview stays open beside the thread when the conversation has a subject file. Chrome, not a new agent. |
| A4 | Citation → ask again | “Belegt durch” opens the page | “Weiterfragen” on that locus, same `?ask=` + focus. |
| A5 | File activity | Citation-events pipeline (platform dashboard) | Project-side “which threads cited this file”. Read-only first. |

A1+A2 are in the first vertical. A3–A5 ship on the same primitive once A2
exists; they must not invent a parallel “chat about file” flag.

## Plane B — people work pieces

| # | Piece | Notes |
|---|---|---|
| B1 | `resource_assignments` table + registry | Polymorphic. RLS via `grid_secure_table`. Assign / release audited. No implicit write on upload. |
| B2 | Faces + Unvergeben | Card, list, preview. Filter: mine / person / unassigned. Bulk-upload tray offers “zuweisen”, never “you own these”. |
| B3 | Ask the person | Reuse `MentionPicker`. Inbox type `document.assigned_to_you` (assignment) and mention-on-document (question). Deep link opens the file as subject (A2) with the person addressed. |
| B4 | `document` shareable descriptor | `visibility` column on `documents`, default `project`. Probe, `setVisibility`, `describeRef`, `exists`, `listIdsInProject`, `deepLink` to `/files?doc=`. Allowed visibilities `private \| project` (same phase-1 withhold of org-wide as chat). |

B1 is not a grant. A grant raises access. An assignment names accountability.
A project-visible file needs no grant for colleagues to open it, and still
needs assignment so Anna is the person you go to.

## Substrate lifts — all of §3, none deferred

These are defects in a promised generic platform. They land **before** the
document descriptor does anything a user can click. Each row is one (or a
tight pair of) conventional commits. Conversation behaviour is unchanged:
existing tests stay green; new tests fail if a second type is not honoured.

| § | Defect | Lift | Commit sketch |
|---|---|---|---|
| 3.1 | Visibility write switches on type and silently no-ops | `setVisibility` on `ShareableDescriptor`; delete the switch | `refactor(sharing): visibility writes go through the descriptor` |
| 3.2 | `MentionResourceType = 'conversation'` | Delete the alias; use `ShareableResourceType`; gate on `supportsMentions` | `refactor(mentions): mentions are resource-typed` |
| 3.3 | `resolveSubjectLine` is a chat query | `describeRef(id, orgId)` on the descriptor | `refactor(sharing): describeRef renders any resource` |
| 3.4 | Events carry `conversationId`; `publishAwaiting` always emits `conversation.awaiting` | `resource.awaiting` / `resource.presence` keyed on `(resourceType, resourceId)`. Leave `conversation.message` / `conversation.turn` alone — those are chat-turn events. | `refactor(events): awaiting and presence are resource-shaped` |
| 3.5 | Cleanup hardcodes `'conversation'`; purger duplicates the cascade in CommonJS | Entry points take `(resourceType, resourceId)`. One resource-type-parameterised source of the three delete statements both runtimes can consume (SQL text / plain JS the purger can import). | `refactor(collaboration): cleanup is per resource type` |
| 3.6 | Orphan sweeps are `resource_type = 'conversation'` | `exists(ids)` on the descriptor; sweep every registered type | `refactor(collaboration): orphan sweeps walk the registry` |
| 3.7 | Mention / awaiting / presence routes live under `/api/conversations/…` | Mount under `/api/resources/[resourceType]/[resourceId]/…`; conversation paths become one-line delegations | `refactor(api): resource routes are type-parameterised` |
| 3.8 | ~20 “generic” strings say chat | Neutralise; interpolate `descriptor.labelKey`. Inbox untitled fallback is not `untitledConversation`. | `fix(i18n): sharing and inbox copy is resource-neutral` |
| 3.9 | `defaultVisibility`, `supportsMentions`, `labelKey` are unread | Every declared field is read at the site that currently hardcodes the equivalent | folded into 3.1 / 3.2 / 3.8 — no leftover unread field |
| 3.10 | `ResourceProbe.projectId` + `requireProjectAccess` | `container: { kind: 'project' \| 'organization', id }` and a per-kind resolver. Project documents use `project`. Archiv *can* declare `organization` without a product UI yet. | `refactor(sharing): container is declared, not assumed` |

**Done for the substrate** means §1 of
`adding-a-shareable-resource-type.md` lists every item above as generic, and
§3 is empty (or contains only newly discovered leaks). The third consumer then
pays only a registry entry.

**The purger is part of 3.5.** Widening the union will not fail `tsc` on
`frontends/ui/purger/purge-project.js`. A test that greps or imports the
generated cascade must exist, or the second implementation will drift again.

## Atomic commit sequence

One logical change per commit. The order is the dependency, not a suggestion.

1. Substrate 3.1 → 3.10 (table above). Each independently revertible. No
   document UI. Conversation specs remain the regression net.
2. `document` registry entry + `visibility` column + RLS + descriptor members.
   No new user-visible chrome yet — the type compiles and access resolution
   works. This is ADR-0032’s “exit criterion: marked shared and authorised,
   with no UI” applied to the second type.
3. `resource_assignments` + B2 faces / Unvergeben / filters / bulk assign.
4. A1+A2 Ask Piloti + document focus (`include_file_names`, subject chip).
5. B3 Ask the person (mention-on-document + inbox types + deep link).
6. A3–A5 as follow-on commits on the same primitive, not a new flag.

A PR may contain a contiguous prefix of this list. It may not contain step 5
without steps 1–2: that is the bolt-on.

## What YAGNI still excludes

These are unused *features*. They stay out until a later spec.

- Live co-editing, Figma-style comments, pins on a PDF page
- External sharing, client/authority portals
- RACI / version trees / transmittals (Aconex)
- Compliance board (vision doc) — it becomes a third assignment consumer
- Archiv assignment UI (substrate can express it; product does not yet)
- Org-wide visibility (same withhold as chat, SH-15)
- A second agent or a “files chatbot” that bypasses `knowledge_search`

## Testing

- Substrate: existing collaboration / sharing / mentions / inbox / cleanup /
  security specs stay green. Each lift adds a case with a *second* resource
  type (a test double descriptor is enough until `document` exists).
- Document descriptor: probe, visibility write, last-owner, deep link, cascade
  (including the purger path).
- Assignment: empty is valid; many people; no write on upload; bulk assign;
  RLS; audit.
- Utilization: `documentQuestionHref` contract (mirror `element-question.spec`);
  `include_file_names` filter unit test next to `exclude_file_names`; focus
  header reaches the retrieval call.
- UI: preview CTA, faces, Unvergeben, `/dev` preview + screenshots for every
  new user-visible surface.

## Documentation in the same change

| Changed | Update |
|---|---|
| Substrate becoming generic | `docs/architecture/adding-a-shareable-resource-type.md` §1/§3 (move paid debt to §1) |
| Assignment vs access | ADR-0047 |
| Second consumer | ADR-0032 addendum |
| Env / routes / schema | `docs/api/collaboration-routes.md`, `docs/database/schema.md`, `docs/api/bff-routes.md` as they grow |
| User-facing | `docs/user-guides/` for Files |
| The rule itself | `AGENTS.md` conventions (this spec’s principle) |

## Open questions (do not block the spec)

1. Subject-file persistence: a column on `conversations` vs. first message
   metadata. Prefer a column if we filter “chats about this file”; prefer
   metadata if it is only a first-turn hint. Decide in the A2 implementation
   plan, not here.
2. Whether “Ask Anna” requires the file to already have Anna assigned, or
   assigning *is* the ask. Prefer: you can mention anyone in the project; the
   inbox item is a question. Assignment is a separate, lasting fact. The UI
   can offer “zuweisen und fragen” as one gesture that does both.
