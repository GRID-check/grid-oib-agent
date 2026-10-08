---
status: accepted
date: 2026-10-08
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The server marks the message that drew on a restricted folder, and the mark outlives the chat

## Context and Problem Statement

ADR-0086 and ADR-0087 keep a conversation that drew on a folder some project
members may not read away from everyone outside that folder's audience. The
fact lives in `conversation_restricted_folders`, one row per conversation and
folder, written when the BFF admits restricted content into a turn. Three repair
rounds on keeping such chats out of platform feedback, lessons and revision
tasks each found another hole, and they had one cause: the readers asked the
wrong thing.

* The cross-tenant readers of answer feedback (the staff drill-in, its CSV
  export, the digest's model, the lessons distiller) matched a vote's
  `conversation_id`. The client sends that id with the vote. A vote that named
  another chat, or none, passed with a comment quoting the folder, and the
  drill-in then showed the named chat's title and question.
* Deleting a chat deletes its record. Migration 0120 copied the fact onto the
  vote when the record went, matched by that same client-sent id.
* Votes, reports, lessons and lesson events written before the filter stayed as
  they were; an owner's edit had kept a withdrawn lesson's old text in
  `platform_lesson_events.detail.previousContent`.
* A revision task opened while its draft sat in an open folder stayed listed to
  the whole project after the draft moved into a restricted one, and so did its
  thread.
* The staff profiler listed and searched the titles of such conversations.

## Decision Drivers

* The fact must come from the server's own record of the turn. What a client
  sends (a vote's message id and conversation id) may add to the answer and
  never lift it.
* It must survive the chat's deletion, because the votes and lessons derived
  from it do.
* It must be keyed by what readers hold: a vote names its answer by message id.
* What was derived before the fix must be withdrawn, and the migration must say
  what it cannot find.
* Access to what a person can open stays judged at read time (ADR-0087), not
  stored.

## Considered Options

* **Database triggers mark the message; readers ask one database rule of each vote** (chosen).
* Mark at admission, from the agent, by the id of the answer it is writing.
* Keep the conversation key and validate the vote's `conversation_id` against the message at vote time.
* Store the mark as a column on `messages`.

## Decision Outcome

Chosen option: a trigger-written mark keyed by (organization, message id), in a
table of its own with no foreign key, and ONE database rule every writer and
reader asks, because it is the only option that is written by the server,
outlives the chat and is keyed the way every reader looks things up.

**The rule.** `grid_conversation_restricted_use(organization, conversation)`
(migration 0123): the conversation holds a `conversation_restricted_folders`
record, or it is the thread of a revision task whose document now sits where
not every member may read (below). The record is written when the BFF admits
restricted content into a turn, before the model reads it, and lives as long
as the conversation. `grid_feedback_restricted_use(organization, message,
conversation)` asks it of a vote: the vote's message id is marked, or the
voted message's conversation, or the conversation the vote names, answers yes.

**The mark.** `message_restricted_use (organization_id, message_id,
conversation_id, marked_at)`. Three triggers write it:

* on `messages`, a row INSERTED, or its `content` rewritten, while its
  conversation answers yes: the answer of the turn that drew on the folder is
  persisted after the turn, and a run's report is written into its message
  after the run;
* on `conversation_restricted_folders`, the first admission marks every
  message the conversation already holds and the message id of every vote
  naming it. A vote cast after the admission on an answer from before it, or an
  older vote edited after it, is typed by someone who has read the restricted
  content, and its comment can quote it;
* on `answer_feedback`, a vote written or rewritten while the rule answers yes
  for it marks its message id. That covers a vote whose message id names no
  row: `messages.id` is minted by the client, shallow turns are not persisted,
  and a persist can fail.

No foreign key: deleting the chat deletes its messages and its record, and the
marks stay. They hold ids and a time, no content. A mark's `conversation_id` is
a note that no rule asks, so a vote naming a restricted chat cannot make the
voted message's own chat read as restricted. The runtime role may insert and
read marks in its own tenant and may neither update nor delete one, so no
tenant-path bug can lift a mark. Any record counts, including one for a folder
since opened: these readers are cross-tenant and the safe direction is to show
less.

**The readers.** `OUTSIDE_RESTRICTED_USE` (`lib/feedback/repository.ts`) is
`not grid_feedback_restricted_use(...)` of the vote: the mark, and the rule
asked again at read time, which is what a revision thread needs since nothing
is written when its document moves. The staff drill-in and its export, the
digest's sample and the distiller's input read the answer, its question, the
title and the topics through the voted MESSAGE's own conversation in the
vote's organization. A vote in a conversation the rule answers yes for is not
returned at all, so no row carries a title the profiler withholds. Migration
0120's `restricted_source` column and its trigger are folded into marks and
dropped. The digest caches are versioned again (`feedback:digest:v3`,
`platformlessons:digest:v3`).

**The backfill and withdrawal (0123).** Every message of a conversation the
rule answers yes for is marked, as the trigger on the record now does at the
first admission. Every vote the rule answers yes for, and every vote 0120
marked, marks its message id. Then, as 0119 did by conversation: a report whose
vote's message is marked loses its `canonical_summary`, a lesson created from
one is retired (with an event, if it was live) and its text replaced, and every
withdrawn lesson, 0119's included, loses the vector embedded from its old text
(`embedding`, `embedding_model`, `embedded_at`) and its events lose
`previousContent`. The migration header states what cannot be recovered: votes
whose conversation and record were deleted before 0120 reached them, and
reports whose vote was retracted.

**Revision tasks are judged when read, like shared chats.** Listing a project's
runs, opening one (`getRunView`), acting on one (cancel, write now, hand it a
document), reviewing one, and reading its definition or run history ask whether
the reader may read the folder the task's document is in NOW
(`lib/tasks/subject-access.ts`); the answer for one they may not read is the
404 an unknown task gets. The thread a revision task writes into is read as a
conversation that drew on that folder (`listRecordedSourceFolders` adds the
subject documents' current folders), so the shared-chat lock
(`lockedConversationIds`), the sharing check and every egress refusal apply to
it. The inbox is a listing too: a `job.completed`, `job.failed` or
`job.waiting` row carries the task's title and a link into its thread, and its
target is the project, so the row is judged by the run it names on the same
rule (`unreadableRunIds`) and redacted like a revoked one. Nothing is stored:
moving the document or giving a role back opens all of them again.

The staff views cannot ask a person's clearance, so the database rule asks a
superset of it for a revision thread: the document sits in another project
than the task, or in a folder of a project that has any folder with an access
list of its own or any folder in the Papierkorb. Every folder `folder-access.ts`
calls restricted is in that set; a project with no custom folder, nearly every
project, keeps its revision threads' feedback. A document that is gone has no current folder and is judged as the
project's, as it was when the task was opened.

**The profiler.** A conversation the rule answers yes for is listed with its
title withheld (`titleWithheld`, „Titel zurückgehalten") and is not found by a
search of its title; its id still finds it.

### Consequences

* Good, because every writer and every cross-tenant reader asks one database rule, and the client's ids can only add to its answer.
* Good, because deleting a chat no longer changes what staff can read about it.
* Good, because the revision task and its thread follow the folder as it is now, with nothing to rewrite when access changes.
* Bad, because the messages of a recorded conversation from before its first admission are marked too, and their votes leave the staff views, as they did before this change. Counts are unaffected.
* Bad, because a client can keep its own organization's vote on any answer out of the staff views by naming a restricted chat with it. That only hides.
* Bad, because the staff views hide the revision threads of a project with an access list on any folder, whether or not the document's folder is the restricted one.
* Bad, because a revision thread deleted before its document moved is no longer found by the rule (`task_runs.conversation_id` is set null); its votes keep only the marks written while it existed.
* Bad, because a message whose content is rewritten after its conversation first drew on a restricted folder is marked even if that edit added nothing restricted; that errs on the side of hiding.
* Neutral: a revision task whose document was deleted is shown as before; the draft text it quotes was the project's when the task was opened, since ADR-0086 refuses a task for a draft in a restricted folder.

### Confirmation

`lib/feedback/restricted-feedback.integration.spec.ts` on real Postgres: the
first admission marks every message the conversation holds, so a colleague's
vote cast after it on an earlier answer stays out of the drill-in and the
lessons input, its comment and the chat's title with it; the marks and the
exclusion survive deleting the chat, an older vote edited after the admission
included; a vote whose message id names no row, written through the vote
service in a restricted chat, stays out before and after the chat is deleted; a
vote naming a restricted chat stays out without making its own chat read as
restricted; a run report written after the admission is marked; the runtime
role cannot delete or change a mark; the profiler withholds the title and its
search. `lib/tasks/subject-access.integration.spec.ts`: a revision task leaves
the list, answers 404, has its inbox rows redacted and locks its thread for a
member who may not read the document's new folder, and comes back when the
document moves back; its thread's vote and profiler title reach staff while the
document sits at the project's root and are withheld once it sits in the
restricted folder. `scripts/rls-test-db.sh` checks 0123's backfill, withdrawal
(vectors included), triggers, grants, down and re-apply on a seeded database,
and that a mark's conversation is never asked.

## Pros and Cons of the Options

### Mark at admission, from the agent

* Good, because it would mark exactly the turn that drew on the folder.
* Bad, because the agent does not know the id of the answer it is writing: the browser mints it and persists the answer after the turn.

### Validate the vote's conversation id at vote time

* Good, because it keeps one table.
* Bad, because it still dies with the chat: the record goes and the vote stays.
* Bad, because every reader would still have to remember that the vote's column is only trustworthy when validated.
* Bad, because refusing a vote whose message id names no row refuses the vote on every shallow turn, which is never persisted.

### A column on `messages`

* Good, because no join.
* Bad, because `messages` rows are deleted with their conversation, which is exactly when the mark must remain.

## More Information

* [ADR-0086](0086-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md), [ADR-0087](0087-folder-access-is-read-write-per-role.md).
* [`docs/architecture/platform-failure-learning.md`](../architecture/platform-failure-learning.md), [`docs/database/schema.md`](../database/schema.md).
