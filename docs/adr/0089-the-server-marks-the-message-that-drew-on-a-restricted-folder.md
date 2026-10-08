---
status: accepted
date: 2026-10-08
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The server marks the message that drew on a restricted folder, and the mark outlives the chat

## Context and Problem Statement

ADR-0084 and ADR-0085 keep a conversation that drew on a folder some project
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
* Deleting a chat deletes its record. Migration 0119 copied the fact onto the
  vote when the record went, matched by that same client-sent id.
* Votes, reports, lessons and lesson events written before the filter stayed as
  they were; an owner's edit had kept a withdrawn lesson's old text in
  `platform_lesson_events.detail.previousContent`.
* A revision task opened while its draft sat in an open folder stayed listed to
  the whole project after the draft moved into a restricted one, and so did its
  thread.
* The staff profiler listed and searched the titles of such conversations.

## Decision Drivers

* The fact must come from the server's own record of the turn, never from
  anything a client sends.
* It must survive the chat's deletion, because the votes and lessons derived
  from it do.
* It must be keyed by what readers hold: a vote names its answer by message id.
* What was derived before the fix must be withdrawn, and the migration must say
  what it cannot find.
* Access to what a person can open stays judged at read time (ADR-0085), not
  stored.

## Considered Options

* **A database trigger marks the message; readers key on the mark by message id** (chosen).
* Mark at admission, from the agent, by the id of the answer it is writing.
* Keep the conversation key and validate the vote's `conversation_id` against the message at vote time.
* Store the mark as a column on `messages`.

## Decision Outcome

Chosen option: a trigger-written mark keyed by (organization, message id), in a
table of its own with no foreign key, because it is the only option that is
written by the server, outlives the chat and is keyed the way every reader
looks things up.

**The mark.** `message_restricted_use (organization_id, message_id,
conversation_id, marked_at)`, migration 0122. A trigger on `messages` inserts a
mark when a row is INSERTED, or its `content` rewritten, while its conversation
holds a `conversation_restricted_folders` record. The record is written when the
BFF admits restricted content into a turn, before the model reads it; the answer
is persisted after the turn, and a run's report is written into its message
after the run. So the answer of the turn that drew on the folder is marked, and
so is every later message of the conversation, whose turns carry that content in
their history. Questions and answers written before the first admission are not.
No foreign key: deleting the chat deletes its messages and its record, and the
mark stays. It holds ids and a time, no content. The runtime role may insert and
read marks in its own tenant and may neither update nor delete one, so no
tenant-path bug can lift a mark. Any record counts, including one for a folder
since opened: these readers are cross-tenant and the safe direction is to show
less.

**The readers.** `OUTSIDE_RESTRICTED_USE` (`lib/feedback/repository.ts`) is
`not exists` a mark for the vote's `(organization_id, message_id)`. The staff
drill-in and its export, the digest's sample and the distiller's input read the
answer, its question, the title and the topics through the voted MESSAGE's own
conversation in the vote's organization; the vote's `conversation_id` is never
used for content or for this question. Migration 0119's `restricted_source`
column and its trigger are folded into marks and dropped. The digest caches are
versioned again (`feedback:digest:v3`, `platformlessons:digest:v3`).

**The backfill and withdrawal (0122).** Every message of a conversation with a
record is marked, the ones before its first admission included, because when
that was cannot be recovered (`messages.created_at` can be client-supplied).
Every vote 0119 marked marks its message id. Then, as 0118 did by conversation:
a report whose vote's message is marked loses its `canonical_summary`, a lesson
created from one is retired (with an event, if it was live) and its text
replaced, and every withdrawn lesson's events lose `previousContent`, 0118's
included. The migration header states what cannot be recovered: votes whose
conversation and record were deleted before 0119 reached them, votes on answers
that were never persisted, and reports whose vote was retracted.

**Revision tasks are judged when read, like shared chats.** Listing a project's
runs, opening one (`getRunView`), acting on one (cancel, write now, hand it a
document), reviewing one, and reading its definition or run history ask whether
the reader may read the folder the task's document is in NOW
(`lib/tasks/subject-access.ts`); the answer for one they may not read is the
404 an unknown task gets. The thread a revision task writes into is read as a
conversation that drew on that folder (`listRecordedSourceFolders` adds the
subject documents' current folders), so the shared-chat lock
(`lockedConversationIds`), the sharing check and every egress refusal apply to
it. Nothing is stored: moving the document or giving a role back opens both
again. A document that is gone has no current folder and is judged as the
project's, as it was when the task was opened.

**The profiler.** A conversation with a record or a marked message is listed
with its title withheld (`titleWithheld`, „Titel zurückgehalten") and is not
found by a search of its title; its id still finds it.

### Consequences

* Good, because every cross-tenant reader asks one question of one table, and the client's ids are no longer part of the answer.
* Good, because deleting a chat no longer changes what staff can read about it.
* Good, because the revision task and its thread follow the folder as it is now, with nothing to rewrite when access changes.
* Bad, because the backfill marks the messages of a recorded conversation from before its first admission too; their votes leave the staff views. Counts are unaffected.
* Bad, because a vote on an answer that was never persisted (the client dropped and the backend's persist failed) has no message to mark and is judged unmarked.
* Bad, because a message whose content is rewritten after its conversation first drew on a restricted folder is marked even if that edit added nothing restricted; that errs on the side of hiding.
* Neutral: a revision task whose document was deleted is shown as before; the draft text it quotes was the project's when the task was opened, since ADR-0084 refuses a task for a draft in a restricted folder.

### Confirmation

`lib/feedback/restricted-feedback.integration.spec.ts` on real Postgres: the
answer of the restricted turn is marked and an earlier answer is not; votes on it
stay out of the drill-in and the lessons input; the mark and the exclusion
survive deleting the chat; a vote naming another conversation is judged by its
message and shows its own conversation's question and title; a run report
written after the admission is marked; the runtime role cannot delete or change
a mark; the profiler withholds the title and its search. `lib/tasks/subject-access.integration.spec.ts`:
a revision task leaves the list, answers 404 and locks its thread for a member
who may not read the document's new folder, and comes back when the document
moves back. `scripts/rls-test-db.sh` checks 0122's backfill, withdrawal,
trigger, grants, down and re-apply on a seeded database.

## Pros and Cons of the Options

### Mark at admission, from the agent

* Good, because it would mark exactly the turn that drew on the folder.
* Bad, because the agent does not know the id of the answer it is writing: the browser mints it and persists the answer after the turn.

### Validate the vote's conversation id at vote time

* Good, because it keeps one table.
* Bad, because it still dies with the chat: the record goes and the vote stays.
* Bad, because every reader would still have to remember that the vote's column is only trustworthy when validated.

### A column on `messages`

* Good, because no join.
* Bad, because `messages` rows are deleted with their conversation, which is exactly when the mark must remain.

## More Information

* [ADR-0084](0084-folder-access-follows-workos-roles-and-a-restricted-folder-is-its-own-collection.md), [ADR-0085](0085-folder-access-is-read-write-per-role.md).
* [`docs/architecture/platform-failure-learning.md`](../architecture/platform-failure-learning.md), [`docs/database/schema.md`](../database/schema.md).
