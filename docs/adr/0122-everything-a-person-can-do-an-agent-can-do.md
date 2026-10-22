---
status: accepted
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Everything a person can do, an agent can do: one MCP server, every agent a client

## Context and Problem Statement

A planning office will not only work in Piloti. Its architects already work in
Claude, Cursor or ChatGPT, and they want those agents to file a document, assign
a mark or start a task in the office's workspace. Today none of them can.

The numbers, from a scout of the code in October 2026:

- The UI offers about 150 capabilities, spread over 313 route methods in
  `frontends/ui/src/app/api`.
- Piloti, the in-product agent, reaches about 15 of those capabilities through 28
  Python tools. Each tool was added when a turn needed it, so the set follows
  the turns we thought of, not the workspace.
- No external agent has any access. There is no token an outside client can
  obtain, and the only credential that reaches a route is the AuthKit cookie.

ADR-0055 said that a workspace primitive is one HTTP route with a typed client
and that every consumer is a client of it. It bound what was added. It did not
say which primitives an agent gets, so the agent's reach grew by accident and
stopped where the last tool stopped.

PostHog faced the same question and answered it with one MCP server in front of
its product API, built so that the API is the product and the UI one client of
it ("headless first, then wire up the UI"). Its handbook is the reference for
this record.

## Decision Drivers

- A person who can do something in Piloti expects their agent to be able to do it,
  and not to be told "the agent can't do that" for a button that exists.
- An agent acts for a person and never above them. Its writes pass the gate a
  person's pass: permission check, rate limit, tenant slot, body schema, audit.
- Two doors drift. A rule true at one and missing at the other makes the
  one that holds look safe (the argument of ADR-0055).
- The person says yes or no to what an agent changes, whichever agent it is.
- Reach has to stay true as the product grows. A list of tools somebody
  remembers to extend is the status quo again, one level up.
- Buy, don't build: MCP is the protocol every agent client speaks, and WorkOS is
  already our identity provider.

## Considered Options

1. **Keep the status quo**: Python tools for Piloti, nothing for anyone else.
2. **A private agent API for Piloti, plus a separate door for external agents.**
   Two surfaces, each with its own idea of what an agent may do.
3. **One MCP server that wraps the routes the UI already calls, and every agent
   a client of it.**
4. **Generate the tools from an OpenAPI spec first.** The spec would be the
   catalog, and the tools would follow.

## Decision Outcome

Chosen option: **3**.

**Everything a person can do in Piloti, an agent can do on that person's
behalf, through one MCP server at `/api/mcp`.** The UI is one client of the
workspace. Agents are others. The long form, with the how-to, is
[`../architecture/agent-surface.md`](../architecture/agent-surface.md).

### The surface

Each MCP tool is an **operation**: an entry in
`frontends/ui/src/lib/agent-api/catalog/` that names a BFF route the UI already
calls (`method` + `path`), says in words a model can act on when to call it, and
states its input as zod. The catalog is not a new door. It makes an existing one
findable.

The dispatcher (`lib/agent-api/dispatch.ts`) runs that route's exported handler
in-process, as the person. The handler's factory then does what it does for a
browser: it resolves the session, checks the `authz` declaration, charges the
rate limit, opens the tenant slot and parses the body with the route's own
schema. Nothing is restated, so there is no second gate and no second contract.
This extends ADR-0055 from "every primitive added" to "every capability".

The handlers learn who is asking from one function, `getGridSession()`. It has
one extra answer: the acting session of the call in flight, bound by
`runAsActingSession` in `lib/agent-api/acting-session.ts` to the async execution
of that call. Only the dispatcher enters it.

ADR-0055 allowed `publicApiRoute` for routes with no session, and `publicApiRoute`
needs an ADR. This record covers its use for the OAuth protected-resource
metadata documents (RFC 9728) that an MCP client reads before it has a token.

### Identity

Every agent is a client of the same server. Two doors are built, two more are
planned. None has a path to a route except the dispatcher.

| Client | Authenticates with | Status |
|---|---|---|
| External agents (Claude, Cursor, ChatGPT) | OAuth 2.1. WorkOS AuthKit is the authorization server (MCP specification 2026-07-28); Piloti publishes RFC 9728 protected-resource metadata; tokens are audience-bound to the MCP URL; clients register by Client ID Metadata Document (CIMD), with dynamic client registration (DCR) for older clients | Built |
| Piloti, in-product | The same server, echoing the turn's signed request-context envelope. Python echoes the envelope and never signs one (ADR-0054 §4, ADR-0108) | Built |
| Scripts and jobs | WorkOS API Keys | Later |
| Piloti outside a browser turn | WorkOS Agent Auth (user-delegated tokens), when it leaves early access | Later |

A WorkOS access token carries no permissions. The person's live membership, role
and permissions are resolved on every call with `resolvePinnedRequesterSession`
(ADR-0108), so a role change or a removed member takes effect within a minute
(the external door's membership lookup is cached at most that long) and not when
a token expires. The per-change table is in `agent-surface.md`, "How long a
revocation takes".

External agents are off by default. A WorkOS feature flag, `agent-mcp`, gates
them per organization; an organization admin turns it on.

### The person says yes or no

The agent acts for a person, and the person decides what changes.

- **External clients** confirm writes through MCP tool annotations. Every
  operation states `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` explicitly (an absent `destructiveHint` means "destructive" in
  the specification, which would make every write look like a delete). The client
  asks its user before a call the annotations mark as a write.
- **Piloti in-product never applies a write itself.** Every write it attempts
  becomes an `operation` proposal, a server object the person accepts, which runs
  as the accepting person, or dismisses (ADR-0105). A read runs at once when
  what it names lies in the conversation audience's reach (ADR-0094, below).
  A proposal may only name what the person whose
  turn it is may read: otherwise a member's Piloti could put a change to a
  project the member cannot see in front of an admin, whose click would apply
  it. Piloti never files the person's own decisions: applying or dismissing
  a proposal and undoing a change it made are hidden from it and refused at
  the click (`PILOTI_HIDDEN_OPERATIONS`; since 2026-10-21 `piloti: false` in
  the exposure config and the applier's `PROPOSAL_DECISION_OPERATIONS`), so one card can never accept
  another. Only a reader who may read every target may decide the card:
  another's `canDecide` is false and their apply is refused with the card left
  open. The card names each target for its reader and shows every input whole;
  „Apply“ waits until each value shown in part has been unfolded, so nobody
  accepts text they were not shown.

#### Reads in a conversation

*Amended 2026-10-21, product owner.* This section held a rule of its own for
reads in a conversation: a solo conversation refused any read naming another
project, a shared one refused every read. That was a second rule for something
[ADR-0094](0094-the-agent-searches-other-projects-as-the-conversations-audience.md)
already decides, and the door now follows it with the lookups' own code:

- what a read names (`operation-targets.ts`) must lie in the conversation
  audience's reach, computed by the function `project_lookup` uses
  (`audienceReachAmong` in `lib/cross-project/audience-reach.ts`);
- the read is recorded through `recordCrossProjectHandOut` before it runs,
  under the audience lock, and refused when the audience changed: the other
  projects it touches and the restricted folders it may carry. The
  conversation's own project keeps the record of its restricted folders;
- in a shared conversation only a read whose answer is what every reader of
  the place reads runs (`AUDIENCE_READS`: a document's content, a project's
  facts), never of a restricted folder; a write is still proposed, unless it
  names a project outside the reach.

A read whose answer spans the office's projects (`spansProjects`) is still
refused in a project's conversation, and one naming something the lookup cannot
place everywhere. The rule in full, and what each read records:
[`agent-surface.md`](../architecture/agent-surface.md#reads-in-a-conversation).

### Sensitive operations

An operation may carry `sensitivity: 'access' | 'secret' | 'control'`. `access`
widens who may do what: sharing grants, folder access, project roles, custom
role definitions. `secret` touches the organization's credentials: LLM provider
keys, and the audit-log Admin Portal links, which hand out a credential.
`control` turns a security or compliance control down or off: zero data
retention, the upload screening policy (the office's and a project's), letting a
held file through screening, lifting a legal hold, and how long the download log
and a purged folder's derived content are kept.

`control` is its own class, not `access`, because it is a different decision for
an office to delegate: an office may let its agents share and grant project
roles and still keep its privacy and retention settings to people, and one
opt-in per class is how it says so. Web search is one: switching it on sends
the members' questions to a web search provider (ADR-0022). Budgets are not:
a budget limits what the office spends, not where its data goes or what it
keeps as evidence, and one operation sets a limit either way (`null` is
unlimited), so marking it would put routine tightening behind the opt-in to
catch loosening. A loosened budget is recoverable, audited, and confirmed by
the person like any write. Each of these switches is one a person can
flip in the UI, so under the product owner's rule an agent may flip it too,
behind the same guards as the other classes.

They are reachable, with guards a plain operation does not need. The product
owner decided (2026-10) that an agent may do everything a person can, as long as
the person says yes or no to each such call; the guards are how that holds:

- the organization opted in a second time, per class: the WorkOS entitlements
  `agent-mcp-access`, `agent-mcp-secrets` and `agent-mcp-controls`, all off by
  default and read per
  organization when the token is verified (`SENSITIVE_OPT_IN_FLAGS`,
  `principal.ts`). Without its class's flag an operation is absent from
  `tools/list`, search and describe, and a call names an unknown operation; a
  search it would have topped says only that a matching change of access, a
  credential or a control is not offered, and that the person makes it;
- the client holds a step-up OAuth scope, and a call without it answers
  `403 insufficient_scope` so the client can ask the person to grant it. Until
  WorkOS defines that scope and grants it only on the person's step-up consent,
  the scope is ignored and no external agent sees a sensitive operation;
- the person confirms every call: `destructiveHint` is true on every sensitive
  operation, the one sensitive read (`organization-llm-credential-list`)
  included;
- Piloti in-product neither sees nor proposes them: one click on a card the
  agent worded is not the confirmation they need. It does not see the `platform`
  domain at all. Applying an `operation` proposal checks both again, so an
  operation that became sensitive or hidden after it was proposed is not run;
- a secret is write-only and never returned: the key list answers a masked
  hint (the last four characters) and a fingerprint, and `secret-operations.spec.ts`
  holds every result, refusal and telemetry event of the key operations free of
  the key.

**Built.** (Since the amendment below, most of these are withheld: of the
`control` class only `document-quarantine-allow` and `hold-release` are on the
door, and no `secret` operation is.) Twenty-five route methods are catalogued with a sensitivity, and
`agent-reachability.spec.ts` (`SENSITIVE`) holds each to exactly its class and
nothing else to one: folder access, sharing visibility and grants (add, change,
revoke), project roles (add, remove) and custom roles (create, change, delete)
as `access`; the LLM provider keys (list, connect, revoke, verify, mode) and the
two audit-log portal links as `secret`; zero data retention, the two upload
screening policies, letting a held file through, lifting a hold, download-log
retention, the deleted-folder content policy and web search as `control`. Web
search is a switch of its own route (`PUT /api/organization/web-search`): the
generic settings save merged it unmarked, and refuses the key now, as it does
every key a dedicated route owns. The routes stay the gate: each still runs its own `authz` and feature
gate as the person. Until the scope is enforced in WorkOS no external client sees
any of them, whatever the organization switched on.

### Search and tools mode

MCP has no standard tool search. With about 300 operations, listing them all in
`tools/list` costs a client tens of thousands of tokens on every conversation.
PostHog's `exec` and Cloudflare's search-and-execute are the industry answer.
The server has two modes:

- `search` (default; `discovery` until October 2026, still accepted): four
  meta-tools, `search-operations`, `describe-operation`, `call-operation` and
  `report-missing-operation` (`report-missing-capability` until then). The
  agent searches the catalog, reads one operation's schema, then calls it. The
  annotations that `call-operation` cannot carry per operation are answered by
  `describe-operation` and enforced at the call.
- `tools`: one MCP tool per operation, with its own annotations, for clients and
  models that handle a long list.

### What deserves a tool

Three layers, as in PostHog.

1. **Atomic operations**, one per route method, catalogued. This is the layer
   that makes the rule "everything a person can do" checkable.
2. **Task-shaped tools**, written by hand where an agent needs more than CRUD:
   Piloti's retrieval, IFC and canvas tools. `knowledge_search`, `read_passage`,
   `list_files`, `view_knowledge_image`, `ifc_query`, `ifc_measure` and
   `ris_lookup` are Python-only reads. In phase 2 they are served through the
   same MCP server by an internal backend endpoint, so an external agent
   searches the office's documents with the retrieval Piloti uses.
3. **Skills that teach composition**, served as MCP prompts. Later.

A new workspace capability is a BFF route and an operation. It is not a new
Python tool. Python tools are for reasoning that has no route.

### What stays out

Some routes are not something a person does. `NOT_AN_AGENT_CAPABILITY` in
`agent-reachability.spec.ts` lists them with a category and a reason each:
transport (the SSE stream, the realtime channel, the proxies), browser sign-in
plumbing (the AuthKit callback and redirect), and typing indicators. An entry
needs a sentence a reviewer can disagree with. What a person does but an agent
is not offered is a different thing, and the amendment below decides it.

### Amendment: the door offers what only Piloti has

*2026-10-21, product owner.* "Web search is a core feature, not something we
want to expose. Why would we want some other agent to use our web search? They
already have a tool for it, and web search is an external service. And there is
lots of stuff like this."

"Everything a person can do" was the right rule for **finding** capabilities
(every route has an operation, so nothing is forgotten) and the wrong rule for
**offering** them. A calling agent comes to Piloti for what it cannot get
elsewhere. So the office door (`/api/mcp`, the A2A door, and Piloti's own
workspace door) offers:

- **the office's workspace**: its projects, documents, folders, reviews,
  annotations, tasks, conversations, people, memory and the skills the office
  writes, and access administration behind the `access` guard;
- **Piloti's domain knowledge**: the legal corpus (`knowledge-search`,
  `passage-read`, `law-lookup`), BIM/IFC analysis of the office's models
  (`ifc-*`, `bim-*`), the office's files (`files-list`);
- **Piloti itself**: `piloti-ask`.

Domain features that make an office artifact with Piloti's knowledge stay on the
door: `project-summary-generate`, `project-consistency-check` and
`project-experience-extract` each write or check the office's own record, which
no other agent can do.

It does not offer, in four categories:

| Category | Why not | Operations |
|---|---|---|
| `external-service` | A service we only proxy or switch; the caller has its own tool, and we would be reselling another vendor | `organization-web-search-set`, `address-search`, `ris-document-get`, `widget-token-get`, `organization-audit-portal-link-create` |
| `product-config` | How Piloti itself works for the office: set by a person in Settings, never by another agent | settings get/update, standing instructions get/set, model configuration (get, set, model search, versions, activate), zero data retention, LLM keys (list, connect, revoke, verify, provider mode), budgets (get, set, remove), usage and its notice, an answer's cost, upload screening (the office's and a project's, get and set), the deleted-folder content policy (get, set), download-log retention, curated skills on or off |
| `model-compute` | Model work the caller can do itself, whose result is no office artifact | `conversation-title-generate`, `citation-format`, `skill-review` |
| `ui-state` | This person's own screen or device | push devices (list, remove) and preferences (get, update), the preference bag (get, update), `conversation-read-mark`, inbox read and unread marks, unread anchors |

Standing instructions are product configuration: they shape every answer Piloti
gives, and Piloti already reads them; an outside agent setting them would be
configuring the product for everyone. Budgets and usage are spend on our
service; when a budget stops work, the refused call says so. The settings read
goes with its write: no office operation depends on a product setting.

**Withheld, not deleted.** The product owner may change his mind, so an excluded
operation stays fully described in the catalog with one field,
`withheld: { category, reason }`. A withheld operation is not listed,
searchable, describable, callable or proposable on any door, and an old
proposal of one is refused at apply, exactly as an unknown name is. One rule
decides it, `isOnDoor` in `policy.ts`, and every path goes through it; the
OpenAPI document leaves withheld operations out too. **Offering one again is
deleting its `withheld` entry** (and its line in the spec's `WITHHELD` list);
its `sensitivity`, if any, applies again from that moment, which is why the
`secret` and `control` classes and their opt-in flags stay as they are.

**The operator console has a door of its own.** The `platform` domain is GRID's,
not an office's. It is off the office door for everyone, platform staff
included, and is planned as a second MCP server for platform staff
(`/api/platform/mcp`) that offers exactly that domain. The visibility rule is
per door (`DOOR_DOMAINS`), so that server adds a door and changes no operation.
(Built the same day: ADR-0126.)

The ratchet, in `agent-reachability.spec.ts`: every exemption carries a category
(`external-service | product-config | model-compute | ui-state | other`); the
withheld set must equal the spec's `WITHHELD` list, so withholding or offering
one shows in review; an offered operation on a product-configuration path
(`/api/organization/settings`, `/model-config`, `/llm-credentials`,
`/web-search`, `/upload-screening`, `/budgets`, `/usage`, `/instructions`,
`/api/platform/…` and the others in `CONFIG_PATH_PREFIXES`) fails unless
`OFFERED_ON_CONFIG_PATHS` gives the reason; every `/api/platform` operation is
the `platform` domain and only those; and no offered operation's text names a
withheld one, so no description sends an agent to a door that reads as unknown.

Consequences: an external agent is offered 216 tools in `tools` mode instead of
304 (214k characters instead of 281k), Piloti 203 instead of 238. The UI keeps
every one of these settings; only the agent door drops them. The `control`
class now has two reachable operations, `document-quarantine-allow` and
`hold-release`, which are the office's own compliance acts; every other
`control` and every `secret` operation is withheld or on the platform door.

### Amendment: one file decides who sees each capability

*2026-10-21, product owner, approved design.* The decision "who sees this"
had grown five homes: a `withheld` field on the operation, the policy's
`PILOTI_HIDDEN_OPERATIONS`, `DOOR_DOMAINS`, the `sensitivity` checks and the
read tools' own visibility. A reviewer could not answer "what does Piloti see,
what does an outside agent see" from one place, and hiding a door operation from
Piloti because it has a native tool for the job had no home at all.

**One config.** `frontends/ui/src/lib/agent-api/exposure.config.ts` has one
entry per catalog operation and per read tool:
`{ external, piloti: true | false | 'native:<tool>', platform?, withheld?, reason? }`.
It `satisfies Record<OperationName | BackendOperationName, Exposure>`, so a
misspelled name or a missing entry does not compile, and its spec fails an
operation without an entry: there is no default. One function reads it,
`isExposedTo(audience, name)` (`exposure.ts`), and `canSee`, search, describe,
call, OpenAPI, the A2A door and the platform door all go through it. The
`withheld` field, `PILOTI_HIDDEN_OPERATIONS` and `DOOR_DOMAINS` are deleted;
each value moved into the config verbatim, and nothing left the catalog, so
re-exposing stays a one-line change. The config is exported as
`frontends/ui/tests/fixtures/exposure.json` for the docs and for Python.

**`native:<tool>` is visibility only.** It hides the operation from Piloti's
door (listing, search, describe, call) because Piloti does the job with that
native tool, so the model no longer weighs two tools for one act. It does not
make a proposal Piloti already filed fail to apply: the applier keeps its own
reasons (an ask, a decision on a proposal, a sensitive operation, an operation
off the door). A Python test checks every `native:<tool>` against Piloti's tool
list in `configs/config_oib_openrouter.yml`.

**`sensitivity` stays on the operation.** It is a property of the act, and
whether a caller may see a sensitive operation is decided per call from the
organization's opt-in flags and the token's step-up scope, which a static file
cannot know. The config records the ceiling (`external: true` behind those
guards, `piloti: false`), and its spec fails an entry that offers Piloti a
sensitive operation.

**Initial values: today's behaviour,** except the consultant's steps 1 to 5
(native tools against the door, 2026-10-21), approved as direction: the memory
writes go to `remember`, `bim-model-query` to `ifc_query`, `document-search` and
`office-shelf-document-search` to `knowledge_search`, `task-create` and
`task-run-commission` to `create_task`, and the four annotation writes to the
canvas tools (`canvas__mark`, `canvas__update`, `canvas__delete`,
`canvas__reply`). Outside agents keep every one. The workspace set of the answer
suite gained rows that check each job is done with the native tool.

**Both paths stay for files and drafts.** `propose_file_change` refuses a chat
in no project, where the door is the only way to move, rename or file.
`file_draft` and the version operations (`document-version-content-replace`,
`…-submit`, `…-fork`) also keep both.

**Decided (2026-10-21): `file_draft` with `submit` goes straight to review; it
does not become a proposal.** A submit publishes nothing. It asks a named
reviewer, and that reviewer's approve and the publish after it are the person's
yes. The tool submits only when the person's own words in the turn ask for it
(`submit` defaults to `False`, and a reviewer without it is refused), so a
proposal would ask the same person twice for one decision. The door's version
operations still propose when Piloti calls them, because they act on a
project document the turn did not draft, and the rule for those is the door's:
a write needs the person's yes.

### Amendment: the person confirms in their own chat

*2026-10-22, product owner.* MCP 2026-07-28 lets a server ask the person
through the client in the middle of a tool call (elicitation on the
multi-round-trip flow, `inputRequired`). When an outside agent's client
declares it, the door asks the person before an outside agent's destructive
write runs, and **a client-side elicitation answer counts as the person's
yes**: on accept with `confirm: true` the call runs as the person, and the
decision is audited as theirs (`agent.operation.decided`, `decisionSource:
elicitation`). Nothing is removed: every other client, Piloti and every
2025-era request keep the rules above unchanged.

Why it is safe:

- **It only stops calls, never starts one.** The question is asked only where
  the door would run the call today (`callDecision` is `run`, the operation is
  visible to this caller). The yes runs the second round through the same
  path, so visibility, the sensitive-operation rule, the read gate and the
  route's own `authz` decide again; an operation that may never run for an
  agent is refused as before, and Piloti, whose writes are proposals, is never
  asked.
- **The answer is no stronger than the client that carries it.** The client is
  the one the person authorized with OAuth, and it could already run the call
  without asking by not declaring elicitation; trusting its relay of the
  person's answer gives it nothing it lacked. What the person gains is that
  the question is worded by the server from the call itself (the operation's
  summary and the names of what it touches), not by the agent.
- **The call cannot be swapped.** The operation and its input travel in
  `requestState`, HMAC-signed with a key derived from the internal secret,
  bound to the person, the organization and the client, valid for five
  minutes; the second round must repeat the same call. An unsigned, altered,
  expired or foreign state is refused by the SDK before any handler runs, and
  an answer without a state is not an answer.

### Amendment: a decision only the person makes

*2026-10-22, product owner, from the red team of the project mail work (RT-S5).*
The amendment above trusts a client not to ask: one that declares no
elicitation runs a destructive write without a question, because it could
always have done so. That holds for an act the person delegates to their agent.
It does not hold for a decision the product promises only a person makes, such
as filing a mail that arrived from outside into a project: an outside agent
that reads injected text in that mail and lacks elicitation would make the
decision itself, and the promise would hold only for well-behaved clients.

**An operation may be marked `requiresPersonConfirmation`**
(`frontends/ui/src/lib/agent-api/operation.ts`). For an outside agent, a
marked call runs only on the person's yes:

- where the request can carry the question (2026-07-28, form elicitation
  declared, a signing key), it is asked, as above, whether or not the
  operation is otherwise destructive;
- where it cannot (a 2025-era request, a client without form elicitation, no
  key), the call is **refused and never runs**. The refusal
  (`structuredContent.decision: 'person_required'`) carries `url`, the app
  page where the person makes the decision themselves, which the operation
  names for the call's input (`requiresPersonConfirmation.decideAt`).

Piloti in-product is unchanged: its write is a proposal, and the person's
acceptance of the card is the yes. The mark sets `destructiveHint`, so a client
that asks its user from the annotations asks for it too. It is for writes only
(`confirmation.spec.ts` holds the real catalog to it), because Piloti runs a
read without a card. Every operation without the mark is answered exactly as
before.

Considered and not taken: answering with MCP URL-mode elicitation
(`URLElicitationRequiredError`). That mode sends the person to a page and then
lets the client retry the same call; here the page is where the person makes
the decision, so nothing is left for a retry to do, and a retry carrying the
agent's input would be the agent's decision again. A plain refusal with the
link, which every client relays, says exactly that.

### The app is a client of the same routes

"One way of working" is held on the server: a capability has one route, one
handler, one gate and one schema (a `lib/**/*-wire.ts` module the route and the
catalog both import, kept pure by `lib/api/wire-modules.spec.ts`). The browser
already calls those routes, so it is a client of the same API, not a second one.

Two moves that look like more of the same were weighed and refused:

- **A generic browser client generated from the catalog**, with every raw
  `fetch('/api/…')` in `features/` migrated onto it. The duplication it removes is
  a URL string; the cost is a new abstraction and churn across 80 call sites.
  A feature with enough calls to earn a typed client gets one, as ADR-0055 says.
- **Server actions for mutations.** A server action is an RPC door outside
  `apiRoute`: no `authz` declaration, no rate limit, no reachability ratchet, and
  no agent can call it. It is exactly the second surface this record exists to
  prevent. Server components keep reading through repositories, which is not a
  door anyone else needs.

### Consequences

* Good, because an agent's writes go through the gate a person's go through.
  There is no agent-only code path to review.
* Good, because the product's reach is a checked property. A new route without
  an operation or an exemption fails a test in the commit that adds it.
* Good, because one server serves Claude, Cursor, ChatGPT and Piloti, so a
  capability added for one is there for all.
* Good, because the catalog's descriptions are the first place a missing
  capability becomes visible: `agent_operation_missing` says what agents asked
  for and could not do.
* Bad, because in-process dispatch couples the MCP server to the Next route
  modules. A route that moves breaks its operation; the `load` check in the spec
  catches that, and a route that cannot be imported outside a request would block
  its operation.
* Bad, because the acting session is a second answer of `getGridSession()`. Code
  that reads the session by another route (the cookie directly) would not see
  it. The rule that only the dispatcher enters the seam, and that nothing a
  request carries can, is what keeps it from becoming a bypass.
* Bad, because catalog descriptions can go stale. The route changes and the
  sentence telling a model what it returns does not. Review is the only check,
  and the operation sits beside the change in the same commit to make that
  review easy.
* Bad, because the first release has a baseline: routes that predate the rule are
  listed in a file and uncovered. The claim "everything" is true by direction,
  and the file says by how much it is not yet.
* Neutral: the catalog emits an OpenAPI 3.1 document of the same operations
  (`GET /api/openapi`, `lib/agent-api/openapi.ts`), because OpenAPI is the
  standard for an HTTP contract. It describes; it is not a door. Its paths accept
  the app's signed-in session cookie and say so (`securitySchemes.sessionCookie`),
  and the document names `/api/mcp` as where an agent calls them. The operator
  console's operations are in it for platform staff only.

Option 4, tools generated FROM OpenAPI, was deferred, not rejected. It needs
response schemas, which the routes do not declare. The direction is the other
way round today: the catalog is the source and OpenAPI one of its outputs, so
the day the routes declare their responses the document can carry them.

Option 2 is the one that rebuilds the problem. A private agent API for Piloti and
a separate external door would each decide what an agent may do. They would drift
the way the three consumers of ADR-0055 did.

### Confirmation

- `frontends/ui/src/lib/agent-api/agent-reachability.spec.ts` walks every
  `app/api/**/route.ts`. A person-facing route method without an operation or an
  entry in `NOT_AN_AGENT_CAPABILITY` fails. Routes that predate the rule sit in
  `agent-reachability-baseline.json`, which only shrinks: a covered or removed
  route must leave it, and `UPDATE_FIXTURES=1` rewrites it so the diff is the
  review. The spec also checks every operation: unique `<entity>-<verb>` name, a
  description of at least 40 characters, a `load` that imports the route its
  `path` names, params that match the path's segments, and schemas the JSON
  Schema export can describe.
- The principal and policy specs under `lib/agent-api/` cover who may call (the
  `agent-mcp` flag, scopes, audience) and what the client must confirm.
- `read-gate.spec.ts` walks the real catalog and the backend operations: in a
  shared conversation no read outside `AUDIENCE_READS` reaches the dispatcher,
  and none reaches the backend.
- `read-only-writes.spec.ts` lists every non-GET operation that claims
  `readOnly`, each with the reason its service writes nothing; a new claim fails
  until it has one, and no sensitive operation may claim it.
- `/api/mcp` charges `mcp-request` (`lib/limits/rules.js`) once per request,
  and refuses a JSON-RPC batch (400), so one request is one call;
  `app/api/mcp/route.spec.ts` holds both.
- `read-gate.integration.spec.ts` and `operation-proposals.integration.spec.ts`
  run ADR-0094's reach and record for reads (solo and shared, a share racing a
  read, the same record as `project_lookup` for one document), and the
  proposal's tenant scope, confused-deputy refusal and reach in a shared
  conversation, against Postgres (`task db:test:rls`).
- PostHog events, through the collector (ADR-0119): `agent_operation_called`
  (operation, client, status) and `agent_operation_missing` (that an agent
  found no operation, by the length of what it wanted, never its words).
- Langfuse (ADR-0089): every MCP tool call is an `agent-tool-call` trace with
  one `TOOL` observation (`lib/langfuse/tool-call-trace.ts`), so the agent
  door is observable where the rest of the product is.
- `exposure.config.ts` does not compile without an entry for every operation;
  `exposure.config.spec.ts` fails a missing reason, a `platform` entry off the
  `platform` domain, an entry offering Piloti a sensitive operation, an ask or a
  proposal decision, and a stale `tests/fixtures/exposure.json`;
  `tests/aiq_agent/tools/test_exposure_config.py` fails a `native:<tool>` that is
  not in Piloti's tool list (amendment of 2026-10-21).
- Nothing enforces that a description is true. Review is the gate.

## Follow-ups

The October 2026 terminology pass made everything an agent reads English, with
one word per concept and the standard's word where one exists (AGENTS.md,
"Industry standard first"; the terms are in
[`../glossary.md`](../glossary.md#agent-surface-and-standard-terms)). It renamed
the operations (`job-*` to `task-*`, `run-*` to `task-run-*`, quarantine
`release` to `allow`), the mode (`discovery` to `search`), the missing-operation
tool and event, the principal's `kind: 'person' | 'piloti'` to RFC 8693's actor
(`external_agent` | `piloti`, the person being the subject), and the inbox types
`job.*` to `task_run.*` (migration 0177). Left for their own changes, each
because it reaches persisted data or another wave's code:

- **Run status on A2A's task states.** A task run's status is stored in four
  vocabularies (the `task_runs` column, the run ledger, the run block, the
  backend job store). Map them onto A2A's `submitted`, `working`,
  `input-required`, `completed`, `failed`, `canceled` with one migration and one
  mapping module, instead of a fifth translation.
- **`?session=` to `?conversation=`** in the app's URLs and the BFF's query
  parameters, with a redirect for one release: "session" is the auth session's
  word.
- **`AnswerKind` `handoff` to `escalation`**: the answer envelope's kind for a
  question handed to deep research, persisted in stored answers and the
  envelope schema.
- **The `file_operation` proposal payload's `operation` field to `action`**: it
  collides with the agent surface's "operation" (in an `operation` proposal the
  same key names the catalog operation) and is stored in
  `proposed_changes.payload`. Left out of the security fix wave because it is
  not contained: the key is read by the CHECK `proposed_changes_office_shelf_move`
  (0146, 0176), by Python's `propose_file_change` and its JSON Schema fixture,
  by the notice variants and by the file cards, some sixty files. One migration
  rewrites the stored payloads and the CHECK, and the agent's side changes in
  the same commit; the `operation` kind keeps `operation`.
- **`AGENT_REFUSAL_LOCALE` to English**: the internal routes Piloti's native
  tools call still refuse in German, because two person-facing paths fall back to
  that constant without naming their reader. Give each caller an explicit reader,
  as the MCP dispatcher now has, then flip it. Part of the core-agent wave, with
  Piloti's native tool descriptions and its prompt's `<auftraege_aus>` block.
- **`/api/projects/[id]/jobs` to `…/tasks`**: not renamed, because
  `/api/projects/[id]/tasks` already serves the project's task runs. Move the
  runs to `…/task-runs` first, then the definitions to `…/tasks`.
- **`/api/documents/[id]/quarantine/release` and `…/request-release`** to
  `…/allow` and `…/request-allow`: the operations say "allow", the paths do not
  yet.

## More Information

- [ADR-0055](0055-api-first-workspace-primitives.md): one HTTP route per
  primitive, every consumer a client. This record extends it to every capability.
- [ADR-0105](0105-piloti-works-on-shared-objects.md):
  proposals, the person decides.
- [ADR-0108](0108-background-runs-act-as-the-person-who-commissioned-them.md):
  `resolvePinnedRequesterSession`, echo the envelope and never sign.
- [ADR-0119](0119-every-metric-goes-to-posthog-through-the-collector.md): the
  events.
- How to add an operation, connect a client, and set up WorkOS:
  [`../architecture/agent-surface.md`](../architecture/agent-surface.md).
- The contributor rule: [`../contributing/headless-first.md`](../contributing/headless-first.md).
- PostHog, [implementing MCP tools](https://posthog.com/handbook/engineering/ai/implementing-mcp-tools).
- MCP [specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28).
- WorkOS [AuthKit for MCP](https://workos.com/docs/authkit/mcp).
- **Revisit when** the permission decision on sensitive operations is made, when
  Piloti moves to WorkOS Agent Auth, or when the routes declare response schemas
  (then generate from OpenAPI).
