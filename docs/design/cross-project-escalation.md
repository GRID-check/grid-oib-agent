# Searching beyond the project: an escalation ladder

Status: built, 7 Oct 2026. The decision record is ADR-0094.

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
| this project, restricted folder | members cleared for that folder (ADR-0088) |
| **closed** project, open folder | **every office member** (ADR-0090) |
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

The model climbs on its own and the BFF decides how high this chat may go.
Nobody is asked: the product owner's correction of 7 Oct was that a user should
not have to ask, or approve, for Piloti to look in past projects.

| Rung | Scope | Who decides | What the user sees |
|---|---|---|---|
| 0 | this project | as today | as today |
| 1 | **office reference**: closed projects, open folders, ranked by similarity | the model, unasked, in **any** chat | status „in anderen Projekten", chips „Datei · Projekt" with „Abgeschlossenes Projekt" |
| 2 | active projects **everyone in this chat** may open (a solo chat: the asker's), and in a solo chat the restricted folders the asker may read | the model, unasked | the same, plus the composer notice naming the running projects and what they close |
| 3 | folders not everyone in the chat may read | never | nothing |

**Why no prompt anywhere.**
- **Rung 1 cannot narrow anything.** A label whose readers are all office
  members restricts no one.
- **Rung 2 cannot expose anything to a current reader.** It searches only what
  everyone already in the chat may open. What it does change is who may join
  later, and that is said where it matters: the composer notice, and the share
  dialog's refusal naming the reason.
- **Asking would cost more than it protects.** An approval clicked on every
  answer is confirmation fatigue, which FIDES, CaMeL and RTBAS all warn
  against. The guarantees here are automatic.

**Search as the audience, not as the asker.** Each rung searches only what
every current reader may read. That is the intersection the code already
computed for restricted folders (`drawableRestrictedCollections`), lifted to
projects in `lib/cross-project/audience-reach.ts`. Because the transcript never
holds anything a current member cannot read, a later widening only has to be
checked against the record, which it already is.

## The catalog: knowing what to look at

This follows the pattern of a skills catalog (Claude Skills, Cursor rules,
Devin Knowledge). Each entry has one short description that the model always
sees, and the content is fetched only when it is relevant.

- **What the model sees.** Every turn shows it the closed projects most like
  this one, at most 12 (`lib/cross-project/reference-brief.ts`, rendered as
  `<referenzprojekte>`).
- **What each line holds:**
  - name and id
  - years
  - Bundesland, Gebäudeklasse, Bauweise, uses, kind of work
  - what the project shares with this one
  - a short summary
- **No recording needed.** It names only closed projects, which every office
  member reads, so it is safe in any chat.
- **When the model fetches.** The prompt tells it to use `project_lookup`
  without being asked when:
  - the question is comparative or about experience;
  - a reference project may have made the same decision (Fluchtweg,
    Brandschutzdetail, Abweichung, Gutachten, Behördenauflage, Konstruktion);
  - the project's own sources do not answer.

  It does not fetch for pure norm text or definitions.
- **How it presents what it finds.** Cite precedent as precedent, with project
  and year. Say when the rules may have changed since. When the references held
  nothing comparable, say so in one sentence.
- **Similarity.** The Bundesland outweighs any single trait, because it
  decides the OIB edition and the Bauordnung. Gebäudeklasse comes next, and a
  neighbouring class still counts a little. A project matching in class,
  construction and use in another Land still outranks one that only shares the
  Land. The weights are set by hand. They should be learned from which
  references readers open.

## When the model climbs

The model climbs when one of the catalog's triggers fires. `scope: similar`
is the default; `closed` walks only the closed projects in the same
most-alike order (what the turn's precedent prefetch searches), and `all`
(newest first) and `named` remain available. The budgets
stay: 8 projects per call, 4 at a time, a 900-character passage, and
per-project attribution.

## What changed against the first build

| Kept | Changed |
|---|---|
| The BFF records at hand-out, under the conversation lock | The solo check is replaced by **searching as the audience**, and by an audience-unchanged check under the lock |
| `conversation_source_projects`, migration 0125 | A closed project **restricts nobody** while it stays closed (`listRestrictingSourceProjects`, read by every judge) |
| Citations with project, the notice, the status line | Doors shut only for content that narrows the readers: a running project or a restricted folder. The notice names only running projects |
| One tool, `project_lookup` | It is offered in every chat, gains `scope: similar` as default, and its description says to look unasked |
| — | **New**: the reference catalog in every turn |

## Open for the product owner

1. **Restricted folders in shared chats.** A shared chat never searches another
   project's restricted folders, even when every reader may read them. Asking
   per hit and per person was deferred.
2. **Memory written while a project was closed.** It stays after a reopen: it
   was readable by everyone when it was written. Should it carry the source
   project, so a reopen can flag it?
3. **A visible "searched N reference projects" step.** The status line shows
   the search while it runs. An answer that cites nothing from the references
   says so only in prose.
