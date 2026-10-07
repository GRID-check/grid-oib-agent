# Searching beyond the project: an escalation ladder

Status: proposal, 7 Oct 2026. Revises ADR-0085 (cross-project lookups) once agreed.

## What the user should get

A planner asks „Wie haben wir die Fluchttreppe beim letzten GK4-Holzbau in
Niederösterreich gelöst?" in any chat, solo or shared, and Piloti answers from
the office's past projects without being told where to look. It cites each
passage with its project, and says where it looked. Nothing a colleague may not
open reaches that colleague, and the chat stays as usable as before: shareable,
able to remember, able to start a Recherche.

The first build (t3–t3d) does not deliver that. The search exists, but only in a
solo chat. And every passage it hands out marks the chat as confined: no
sharing, no memory, no Tiefenrecherche, no Auftrag. That holds even when the
passage came from a closed project that, since ticket 1, every office member
may read anyway. The confinement protects nobody there and costs the user the
feature.

## What others do (research, Oct 2026)

- **Every enterprise assistant trims retrieval to the asker.** This holds for
  M365 Copilot, Glean, Notion, Slack, Rovo, Gemini and ChatGPT company
  knowledge.
- **Microsoft also carries a label onto the output** ("the highest-priority
  label is inherited").
- **Teams group chats are the only product with an audience larger than the
  asker.** When an answer used sources that not every member can open, the
  asker gets a private preview with Approve/Reject.
- **Discoverability and access are separate switches.** SharePoint Restricted
  Content Discovery hides a site from search and Copilot, while direct access
  stays as it was.
- **FIDES** (Microsoft, arXiv 2505.23643) treats a label as a set of readers.
  Combining content intersects the sets, and a flow to recipients R is allowed
  only when R ⊆ readers. A consequential action may run only when its decision
  came from trusted input, so a planted instruction in a PDF cannot trigger it.
  **CaMeL** (DeepMind, 2503.18813) and **RTBAS** (2502.08966) apply the same
  idea, and all three warn about confirmation fatigue: ask only when the
  guarantee cannot be made automatically.
- **Escalation UX.** Claude Code widens scope explicitly
  (`/add-dir`, ask → allow, "don't ask again" for the session). MCP elicitation
  and the OpenAI Agents SDK pause for approval mid-run.
- **Retrieval routing.** Adaptive-RAG and Corrective RAG route by need and fall
  back to a wider search when what was retrieved is thin. Federated RAG selects
  its sources per query.

## The model: a conversation has a set of readers

Every source passage has a set of readers:

| Source | Readers |
|---|---|
| this project, open folder | the project's members |
| this project, restricted folder | members cleared for that folder (ADR-0081) |
| **closed** project, open folder | **every office member** (ADR-0082) |
| active other project, open folder | that project's members |
| any project, restricted folder | members cleared in **that** project |

- **The chat's label.** It is the intersection of the readers of everything the
  chat drew on. The existing record (`conversation_restricted_folders` plus
  `conversation_source_projects`) already holds it, and it is judged at read
  time.
- **One invariant replaces solo-only, confined mode and the per-door refusals.**
  A flow to a target T is allowed if and only if readers(T) ⊆ label. The flow
  can be sharing, a new member, project memory, a Recherche or an Auftrag (both
  read by the project), a profile patch, or filing into a folder.
  - A chat that only drew on closed projects passes for every target.
  - A chat that drew on an active project's open folders blocks only what that
    project's members cannot read.
  - Reopening a closed project narrows its readers again, and because the label
    is judged at read time the chat follows without a migration.

## The escalation ladder

The model climbs the ladder; the BFF decides how high this chat may climb; and
the user is asked only at the one rung where the label would narrow.

| Rung | Scope | Who decides | What the user sees |
|---|---|---|---|
| 0 | this project | as today | as today |
| 1 | **office reference**: closed projects, open folders, ranked by similarity | the model, silently, in **any** chat | status „Suche in Referenzprojekten …", source chips „Datei · Projekt · abgeschlossen" |
| 2 | active projects **everyone in this chat** may open, plus the folders all of them are cleared for | the model proposes, the **user confirms once per chat** | a consent chip: „In laufenden Projekten suchen? Danach lässt sich der Chat nur mit Mitgliedern von X teilen." |
| 3 | folders not everyone in the chat may read | never by escalation | the answer says how many hits it could not show; v2: the folder owner releases an excerpt |

Why the consent sits on rung 2 and nowhere else:

- **Rung 1 changes nothing anybody could lose.** Office content cannot narrow a
  label whose readers are all office members, so asking would be pure
  confirmation fatigue.
- **Rung 2 narrows who the chat can later reach.** That is a consequence for the
  user, not a security question for the model.
- **The consent is a click, never a tool argument.** This is FIDES's
  trusted-action rule: text retrieved from a document cannot grant it. A grant
  lasts for the chat, as Claude Code's "don't ask again" lasts for the session.

**Search as the audience, not as the asker.** In a shared chat each rung
searches only what every current member may read. That is the intersection the
code already computes for restricted folders (`drawableRestrictedCollections`),
lifted to projects. The transcript then never holds anything a member cannot
read. A later widening is checked against the label, as today.

## When the model climbs

These are routing rules in the prompt and tool description, not new machinery:

- **Comparative or historical questions climb straight to rung 1.** Examples:
  „wie haben wir …", „in früheren Projekten", „Referenz", „schon mal".
- **A thin answer falls back to rung 1.** If the project's own search returns
  nothing that answers the question (Corrective RAG), the model climbs to rung 1
  before saying it does not know.
- **„Similar" is the default scope.** It ranks projects by Steckbrief and profile
  facts: Bundesland first, because it decides the OIB variant, then
  Gebäudeklasse, Bauweise, Nutzung and period. "All" and "named" stay available.
- **Discovery comes before content.** `find` returns project, title, period and
  hit count; full passages come only from `search`. Only content and active
  project names are recorded.
- **Budgets.** At most 8 projects per call, 4 at a time, a 900-character
  passage, and per-project attribution in the merged result, as today.

## What changes against t3–t3d

| Keep | Change |
|---|---|
| BFF records at hand-out, under the conversation lock | the solo check becomes **search as the audience** |
| `conversation_source_projects`, migration 0116 | a closed project's open folders **restrict nobody** while it stays closed (read-time filter in `peopleWhoMayRead`, `lockedConversationIds`, egress) |
| citations with project, the notice, the status line | confined mode (prompt and BFF) becomes the **label check per target**: memory, Recherche, Auftrag and profile patch are allowed when the target's readers ⊆ the label |
| one tool `project_lookup` | it is offered in **every** chat; it gains scope `similar`; the BFF answers `consentRequired` for rung 2 |
| per-project clearance (ticket 1) | new: `conversation_scope_grants` (who, when, rung), written only by a UI route from a click |

## Open for the product owner

1. **Rung 2 consent: per chat, or per person?** The proposal is per chat.
2. **Memory from rung 1.** A lesson from a closed project may enter this
   project's memory under the label rule. Should it carry the source project as
   provenance, so a reopen can flag it?
3. **Rung 3 release by the folder owner.** It is deferred to v2. Is the "N hits
   you cannot see here" line wanted, or does the existence of such hits already
   say too much?
