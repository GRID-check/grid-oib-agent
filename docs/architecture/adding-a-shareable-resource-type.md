# Adding a second shareable resource type

ADR-0032 promises that sharing is **a platform capability, not a chat feature**:
"any current or future resource inherits it by declaring itself shareable", and
anything a second consumer has to change *outside* its own registry entry is a
substrate defect, not a cost of the new type.

Today `conversation` is the only consumer, so that promise has never been tested.
This document is the honest state of it, measured against the code in
2026-07: **what you get for free, what you legitimately write, and what is still
leaking that you would have to fix on the way through.**

Read it before adding a type — and if you add one, update it, because the third
consumer is the one that proves the second consumer paid the debt down.

---

## 1. What is genuinely generic

These carry no knowledge of conversations and need nothing from you beyond a
registry entry.

**Storage.** `resource_shares`, `mention_requests` and `inbox_items` all key on a
polymorphic `(resource_type text, resource_id text)` with matching indexes, and
none of them has a foreign key to `conversations` (the one FK in
`drizzle/0027_collaboration.sql` is on `conversation_reads`, a chat-only table
outside the substrate). **A new type needs no migration on these three tables.**

**Effective access.** `lib/sharing/access.ts` — tenancy → container → strongest
of (visibility, grant, creator) — contains no conversation reference at all.
This is the security core and it is clean.

**Sharing mutations and their HTTP surface.** `getSharingState`,
`grantResourceAccess`, `changeResourceRole`, `revokeResourceAccess`,
`escalateToOwner`, `resolveParticipants`, the roster cap, the rate limit, the
last-owner invariant, the audit records and the `resource.access.changed`
publishes are all parameterised on `resourceType`. The four routes under
`app/api/sharing/[resourceType]/[resourceId]/**` validate the path segment
against the registry and pass it through, so a new type gets read, visibility,
grant, revoke, role-change and the candidate picker **with no new route files**.

**The inbox read path.** `lib/inbox/service.ts` has no conversation literal in
435 lines. Emission, read-time re-authorization, redaction, projection and the
deep link all resolve through the registry.

**Authorization.** There are no per-resource-type permissions in
`lib/authz/catalog.ts` to add — resource authorization is the `RESOURCE_ROLES`
ladder plus one container check.

**Presentation.** `AccessChip`, `AccessOverview`, `ShareDialog`, `InboxItemRow`,
`InboxList`, `InboxBadge`, `MentionPicker`, `useSharing`, `useShareCandidates`
and the event hub all take the type as data.

## 2. What you legitimately write

1. A member in `SHAREABLE_RESOURCE_TYPES` and one `ShareableDescriptor` in
   `lib/sharing/registry.ts`.
2. On your own table: a `visibility` column, a tenancy read and a visibility
   write.
3. Per inbox item type: the schema union member, two registry entries
   (`INBOX_TYPE_DEFINITIONS`, `INBOX_TYPE_PRESENTATION`) and its copy in both
   dictionaries.
4. Your surface's own toolbar/composer wiring, and hooking your delete path into
   the cascade in `lib/collaboration/cleanup.ts`.

## 3. What is still leaking

Each of these is a substrate defect by ADR-0032's own definition. They are listed
worst-first, with what it costs to lift them. **Fix the one you touch** rather
than working around it, or the second consumer pays and the third pays again.

### 3.1 A visibility change on a new type silently does nothing

`lib/sharing/service.ts` switches on `resourceType` to apply the write, and the
switch returns `void`. Widening the union therefore **compiles**, falls through,
writes a truthful-looking `resource.visibility.changed` audit record, publishes
`resource.access.changed`, and returns the *unchanged* visibility. This is the
single worst leak: it fails silently and leaves a misleading audit trail.

*Lift:* a `setVisibility` member on `ShareableDescriptor`; delete the switch.

### 3.2 Mentions are typed to conversations

`type MentionResourceType = 'conversation'` in `lib/mentions/service.ts` narrows
nine signatures, and there is a `as MentionResourceType` cast that silently
mislabels a row loaded from the database. The repository beneath it is already
generic. `descriptor.supportsMentions` exists for exactly this gate and is read
by nobody.

*Lift:* delete the alias, use `ShareableResourceType`, gate on
`supportsMentions`.

### 3.3 There is no way to render a reference to a resource

`resolveSubjectLine` switches on the type and calls `findConversationInOrg` —
a chat query inside the mentions notification path. Spec SH-7 asks the registry
to declare "how to render a reference to it — title, icon, subtitle"; the
descriptor has no such member, so there is nowhere for a new type to put it.
Because the return type is explicit, widening the union is a compile error —
the good failure mode — but the only cheap "fix" is `default: return null`,
which lands every row of the new type on the untitled fallback.

*Lift:* a `describeRef(id, orgId)` member on `ShareableDescriptor`.

### 3.4 Live awaiting and presence events are conversation-shaped

Four of the six `CollaborationEvent` variants carry `conversationId` rather than
`(resourceType, resourceId)`. `publishAwaiting` lives in the generic mentions
service and publishes `kind: 'conversation.awaiting'` regardless of type — so a
document mention publishes an event announcing itself as a conversation, with a
document id in a field named `conversationId`. Client filters compare
`event.conversationId`, so the new type's banner never updates live, and if ids
ever collide it updates the wrong surface.

*Lift:* `resource.awaiting` / `resource.presence` variants keyed on the resource.
Leave `conversation.message` and `conversation.turn` alone — those are genuinely
chat-turn events and belong to the chat domain.

### 3.5 Cleanup is conversation-only, and one literal is already wrong

`lib/collaboration/cleanup.ts` passes a hardcoded `'conversation'` into generic
repository functions in five places. One of them composes an inbox group key
from the literal instead of from `request.resourceType`, which is on the row —
so for any other type the key would never match and the item is never resolved.
The project-membership cleanup (`voidOpenRequestsForSubjectInProject`,
`markItemsInertForSubjectInProject`) filters on `'conversation'` and joins
`conversations`, so spec SH-13's "removed from the project" row would not hold
for a new type: a removed member's requests stay open forever and the new
resource waits on somebody who can never answer.

*Lift:* take `(resourceType, resourceId)` at the five entry points, and derive the
project-scoped variants from a `listIdsInProject` descriptor member.

### 3.6 Orphan sweeps skip anything that is not a conversation

All three sweeps are `resource_type = 'conversation' AND NOT EXISTS (… FROM
conversations …)`. A new type's rows accumulate forever while the sweep reports
zero and looks healthy.

*Lift:* an `exists(ids)` member on the descriptor.

### 3.7 The mention, awaiting and presence routes are mounted under the chat

`/api/conversations/[id]/{awaiting,mention-candidates,typing,live}` — only the
release endpoint is substrate-shaped. Client hooks hardcode the same paths.

*Lift:* mount them under `/api/resources/[resourceType]/[resourceId]/…`, keeping
the conversation paths as one-line delegations.

### 3.8 About twenty "generic" strings say chat

Keys in the resource-agnostic `sharing.*` namespace hardcode the noun —
`visibilityHeading`, `reasons.creator`, `leave`, `removeConfirmHint`,
`escalateHint`, `errors.lastOwner`, `errors.rosterFull`, the `narrowLoss` pair —
and the German is worse than the English. `inbox.untitledConversation` and
`inbox.bodyUnavailable` are rendered by the generic row, so a document row reads
"3 new items in *Chat ohne Titel*". The mechanism designed to fix this —
`descriptor.labelKey` and the `sharing.resourceTypes.*` dictionary block — is
declared, populated, and **read by nobody**.

*Lift:* neutralise the ~20 keys, and interpolate the resource label where a noun
genuinely helps.

### 3.9 Declared-but-unread descriptor fields

`defaultVisibility`, `supportsMentions` and `labelKey` are all on
`ShareableDescriptor` and consumed nowhere; the equivalent facts are hardcoded at
each site. Treat a field nobody reads as a promise the substrate is not keeping.

### 3.10 The container is assumed to be a project

`ResourceProbe.projectId` plus a `requireProjectAccess` gate. Fine if your type
also lives in a project; a hard block for an org-level resource. SH-7 asks the
registry to declare its container type and it does not.

*Lift (only if you need it):* widen the probe to
`container: { kind: 'project' | 'organization', id: string | null }` and put the
container check behind a per-kind resolver.

---

## 4. The number

For a second type that lives inside a project: roughly **3–5 days** of
legitimate per-type work, against **~9 days** of forced refactoring from §3.
For a type with a different container, add 1–2.

Doing §3.1, §3.2, §3.3, §3.5 and §3.6 first — about three days, and mostly three
new descriptor fields plus deleting two switches — takes most of that off, and
takes it off permanently: the third consumer then pays only §2.

## 5. The rule

If adding your type makes you edit a file under `lib/sharing`, `lib/inbox`,
`lib/mentions`, `lib/events` or `lib/collaboration` **for any reason other than
adding a registry entry**, you have found a substrate defect. Fix it there rather
than at your call site, and add it to §1 here when it is gone.
