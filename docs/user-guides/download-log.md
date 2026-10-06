# The download log

Who took which document out of Piloti, and who opened one in a folder the office
gave its own access list. This page says what is recorded and why, how long it
is kept, who sees it, and what an office with a works council should settle
before it relies on it. The decision behind it is ADR-0079 and its plan,
[`plans/2026-10-06-folder-access-lifecycle.md`](../../plans/2026-10-06-folder-access-lifecycle.md)
(decision 4).

## What is recorded

One entry each time Piloti hands a document's bytes to a person:

| What the person did | Recorded | Shown in the log as |
|---|---|---|
| **Downloaded** a file (the download button) | Always, wherever the file is filed: a project folder, the Archiv, a chat attachment | `Download` |
| **Opened** a file in the viewer (preview, PDF viewer, text preview, a version from the version list, the 3D model) | Only when the file is in a folder with its own access list, or in a folder below one | `Vorschau`, `Im Viewer geöffnet`, `Textvorschau`, `Version geöffnet`, `3D-Modell geöffnet` |

Each entry holds: the person (their WorkOS user id), the organization, the
project, the document and the name it had, the version when there is one, the
folder it was filed in at that moment, whether that folder had its own access
list, the time, and which of the above it was. Names and email addresses are
not copied into the log; the page looks them up when an admin reads it.

Not recorded: thumbnails (they are not the file), what Piloti's agent reads
while answering (that is use of a folder, which has its own record), the
platform's shared knowledge base, exports of a chat answer, and the opening of
documents in ordinary folders. That last one is a decision, not an oversight:
the preview link of an ordinary folder is a link to the whole file, so a person
who wants a copy can take one from the viewer without pressing „Download". The
log answers "who downloaded", and for the folders an office marked as sensitive,
"who looked".

**If an entry cannot be written**, a download from an ordinary folder still
works (the failure is logged for the operator). A download or opening from a
folder with its own access list is **refused** with a message saying the access
could not be recorded: for those folders the log is the control, and "nothing
left the personnel folder unrecorded" has to stay true when the database is
unwell.

## Why

Security and accountability, and nothing else: to find out, after the fact, who
took a contract out, and to let an office say with a straight face that access
to a restricted folder is not only limited but also traceable. It is not an
activity report. The page shows a list of events, newest first, filtered by
person, document and day. There is no total per person, no ranking and no chart,
and nothing in Piloti evaluates how much anyone downloads.

## How long

**12 months, then it is deleted.** An organization can shorten that, down to 30
days: **Organisation → Übersicht → Aufbewahrung des Download-Protokolls**, whole
days from 30 to 365. It cannot be made longer; a longer time would be a decision
for a new ADR, not a setting. Piloti's scheduler deletes what is past its time
once a day, in small batches, so a shortened time takes effect at the next run.
Rows cannot be changed, and only that daily purge can delete them.

Backups keep deleted rows until they rotate out; the retention in the data
processing agreement should say so.

## Who sees it

Holders of the permission **`org:downloads:view`**. Organization admins hold it;
a custom role can be given it under Organisation → Personen & Zugriff → Eigene
Rollen. The audit-log permission does not open it, because this is data about
what staff opened. The page is **Organisation → Download-Protokoll**.

**Reading the log is recorded too.** Every request for a page of the log writes
an entry in the organization's audit trail first (`download_log.viewed`: who
looked, and the filters they used, not what they found), and the page shows
nothing when that entry cannot be written. Changing the retention is audited as
`download_log.retention.updated`, with the value before and after.

## Before you rely on it: works council (Austria, Germany)

A record of what individual employees downloaded or opened can be a control
measure that needs the works council's agreement, however it is meant: in
Austria § 96 ArbVG (control measures that touch human dignity, in particular
§ 96 Abs. 1 Z 3), in Germany § 87 Abs. 1 Nr. 6 BetrVG (technical devices
suitable for monitoring behaviour or performance). Whether yours does depends on
the case and on your counsel's reading; this is a prompt to ask, not legal
advice. What Piloti does to make an agreement easy to reach, and what to write
into it:

- **Purpose limitation.** Security and accountability only (see above), written
  into the agreement as the only purpose. The product has no per-person
  statistics, and an agreement can say that none will be built.
- **Data minimisation.** Who, what, when and from which folder; no content, no
  IP address, no names copied into the log.
- **Short, fixed retention.** 12 months at most, which the organization can
  shorten; deleted automatically.
- **Narrow access, itself logged.** One permission, held by admins unless the
  office decides otherwise; every read is in the audit trail, which an office can
  stream to its own SIEM.
- **Folders that matter most are covered most closely.** Opens are recorded only
  in folders the office gave their own access list, and a failure to record
  blocks access there.

The data processing agreement template should name the log, its purpose, the
retention, the roles that can read it and the backup rotation window.

## For admins: finding something

**Organisation → Download-Protokoll.** Pick a person, type part of a document's
name (or paste its id), narrow by day or by what happened, and press „Anzeigen".
Older entries load with „Ältere Einträge anzeigen". A person who has left the
organization is shown by id. The project and folder names are today's, so a
deleted project or folder shows up as gone.

Developers: the one writer is `recordDocumentAccess`
(`frontends/ui/src/lib/download-log/service.ts`), and
`download-log/coverage.spec.ts` fails when a new function reads or presigns an
object, or a new route reaches one, without being classified there. Table and
purge: [`database/schema.md`](../database/schema.md#document_access_log-migration-0110-adr-0079);
routes: [`api/bff-routes.md`](../api/bff-routes.md).
