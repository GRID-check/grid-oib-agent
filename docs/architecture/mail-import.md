# Outlook archive import

A member imports an Outlook archive (`.pst`, or the `.ost` Outlook caches from
Exchange) into a project's Dateien, and every mail in it becomes a folder with
its attachments and a note holding its text. Why it is built this way:
[ADR-0085](../adr/0085-outlook-archives-are-read-by-range-and-filed-as-the-person-per-mail.md).

## The flow

```text
browser                     BFF (frontend)                     object store         backend (api)            BFF (bff-jobs)
  │ POST mail-imports  ──────▶ flag, write access, quota,
  │                            CreateMultipartUpload ─────────▶ staged upload
  │ PUT parts/1..n (32 MiB) ─▶ exact size? UploadPart ─────────▶ parts
  │ POST complete ───────────▶ ListParts, Complete ────────────▶ one object
  │                            enqueue mail_import ────────────────────────────────────────────────────▶ slice:
  │                                                                               ◀── POST messages ─── page from cursor
  │                                                            ◀── range GETs ─── libpff walks
  │                                                                               ◀── POST attachment ─ per file
  │                                                                                                     open upload batch
  │                                                                                                     uploadDocument ×n
  │                                                                                                     advance cursor
  │                                                                                                     … until done:
  │ inbox: imported / stopped ◀─────────────────────────────────────────────────────────────────────── seal batch, delete staging
  │ inbox: what arrived       ◀── reconciliation / sweep, once every filed document has been read
```

- **Upload.** `lib/mail-import/client.ts` sends the parts the server does not
  hold yet, three at a time. A failed part is retried for fifteen minutes,
  waiting while the browser is offline, so a Wi-Fi roam or a closed lid does
  not end a send of hours. The send is held by the tab, not the dialog
  (`features/documents/lib/mail-import-send.ts`): the person can go on working
  in Piloti, and only closing the tab stops it, after the browser asks. A send
  that broke off is resumed by choosing the same file again (`GET …/[importId]`
  lists the held parts); a file whose modification time changed since is
  refused, because its parts would not fit the ones already sent.
- **Reading.** `aiq_api.mail_archive` opens the staged object through
  `RangeFile`, a file object over presigned range GETs with a 64 MiB block cache.
  Items are numbered depth-first over the mail tree, so a position is a cursor.
  The folder tree and each folder's message count are read once when the
  archive opens (`Archive._folders`, `total` in `mail_archive/reader.py`), so
  they cost no message reads; no route returns them yet. A slice reads pages of
  20 messages, and one read of the archive (a page, an attachment) may take
  90 s (`MAIL_IMPORT_PAGE_SIZE`, `MAIL_ARCHIVE_READ_TIMEOUT_MS` in
  `lib/mail-import/config.ts`).
- **Filing.** `lib/mail-import/job.ts` runs on the BFF job queue as the person
  who started the import, 120 s of filing per slice, checked before every
  attachment. `filing.ts` files one mail: its folder, its attachments through
  `uploadDocument` at `bulk` ingest priority, then the note. The cursor moves
  past a mail only after it is filed. A retried mail files into the folder it
  had, under the same names, so each file is the same document again (a new
  version, or `unchanged` once indexed), never a second one. Every upload
  carries the import's upload batch (below). A file it filed that the content
  gate still holds or has quarantined (ADR-0086) counts as filed and is not
  uploaded again, since a quarantined file refuses every re-upload. A held file
  somebody else put under that name is never replaced: the mail takes the next
  free name (`… – Plan (2).pdf`).
- **Folder access (ADR-0087, ADR-0088).** Every slice first checks that the
  person may write the archive's folder, or, before it exists, the
  `E-Mail-Import` root folder (found by name, so one with its own access list
  is judged as it is). A refusal ends the import `failed` with `access` at once,
  instead of a refused folder creation per slice until the streak runs out. The
  action is offered only to a reader whose project-root access is `write`
  (`projectRootAccess`), because the import files its folder at the root.
- **Retries.** A passing failure hands the import to a fresh job that waits 1,
  5, 15, 30, 60, then 120 minutes; filing a mail resets the streak. The
  background-work sweep (`sweepStaleMailImports`) gives an import that has made
  no progress for 30 minutes and has no live job a new one, counted on the same
  streak; past the sixth the import ends `failed` with `stalled`. These retries
  are the import's own (`mailImportHandler`, `handOn` in `job.ts`): the failed
  job ends `done` and a new one is queued, so the queue never spends an attempt
  on them.
- **Sharing the job pool.** An import runs for hours, so its claim yields its
  slot every ten minutes between slices (`workers/jobs/runner.js`), and the
  fair claim lets other organizations' work in before it continues.

## What a mail becomes

```text
E-Mail-Import/
  Postfach Bauleitung 2025/            ← the archive's name (" (2)" for a second import)
    Posteingang/Behörde/               ← the Outlook folder path
      2025-03-12 14.05 – Statik Huber/ ← one folder per mail: date, time (Vienna), sender
        2025-03-12 14.05 – Statik Huber.md             ← the note: subject, headers, text
        2025-03-12 14.05 – Statik Huber – Plan.pdf     ← each attachment, prefixed
```

The subject is in the note, never in a name. A filename is unique per project,
across all its collections (a folder with its own access list keeps its own),
so a name is probed project-wide (`findProjectCollectionsHoldingFilename`) and
one held anywhere but the mail's own folder is numbered (`… – Plan (2).pdf`).
The import never supersedes a document it did not file into that folder.

**The note is text, not Markdown the sender wrote.** Its frame (the subject
as its one `#` heading, the labelled headers, a rule, the body) is the only
structure in it: the subject, every header value and the body pass through
`escapeMarkdown` (`lib/text/markdown-escape.ts`), and each header is folded
onto one line. The knowledge layer cuts a `.md` into one section per `#`
heading outside a code fence, and a section is what an answer cites, so a body
line such as `## 14.10.2026 · MA 37` would otherwise be a section of the note
under a heading the Behörde never sent, and an unclosed fence in a body would
hide everything after it. The escape counts a line start where the chunker
does, after every terminator Python's `splitlines()` honours (a form feed, a
NEL, `\u2028` among them), not only where JavaScript's `^` does.

**Not filed, and named in the import's list:** attached mails (a forward's
original), files the upload path refuses (type, size, and the office's name
screening,
[ADR-0086](../adr/0086-uploads-are-screened-locally-and-matches-wait-in-quarantine.md),
which reads the path of the project folder the file goes into; those folders
mirror the Outlook folders and the mail's own folder, so a term in either
counts), files into a folder
that turned read-only for the person under the import (`access`), a name another
document claimed between the probe and the upload (`name_taken`), and messages
or attachments damaged in the archive. The backend reader's status becomes the
reason (`lib/mail-import/archive-client.ts`): `422` ends the import as an
unreadable archive, `413` skips an attachment as too large, `409` skips one as
unreadable. An item the archive cannot read is named by its position (`#412`),
and the row keeps the first 20 names (`SKIPPED_SAMPLES_KEPT`); the counts are
exact. The import never releases a screened
file: that release is a person's per-file decision in the upload dialog, and a
job has no person to ask. Every such refusal is a skip, never a failed slice: a
refusal left to throw is retried until the import ends `stopped`. Counted but
not named: items that are not mail (appointments, contacts, tasks). Not counted:
a mail's inline pictures (signature logos).

## What the person is told

Two inbox items, at two moments. `mail_import.completed` (or `.failed`) when
filing ends: what was filed and what was skipped. Filing ending is not reading
ending, so the files are still being screened and read then. The
`upload.completed` summary of an upload batch (ADR-0086, „Was ist
angekommen?") follows once everything the import filed has been read: what
each file became, and what the screening held back and why. The same summary a
dropped folder gets.

`lib/mail-import/upload-batch.ts` keeps the import's batch:

- **Opened** by the first slice, as the person who started the import, on the
  project's shelf, announcing no files (nobody knows how many yet).
- **Found again** by every later slice without a column on `mail_imports`: the
  batch id is a UUIDv5 of the import's id and a generation number, and the
  import's batch is the first generation that is not sealed. A job handed on
  after a failure, or requeued by the sweep, lands in the same batch.
- **Rolled over** when it holds `UPLOAD_BATCH_MAX_FILES` (10 000) documents:
  sealed, and the next generation opened. Each batch gives one summary.
- **Sealed** at every ending, completed, failed or cancelled, announcing the
  documents that carry it. A seal that fails is logged, not fatal: the upload
  sweep seals a batch no file has come into for 30 minutes. The same rule seals
  it during a backoff longer than that, and the next slice then opens the next
  generation.

**The list of imports** (`GET /api/projects/[id]/mail-imports`,
`mail-import-list`) is a keyset page, newest first: 20 by default, at most 50
(`MAIL_IMPORT_LIST_PAGE_SIZE`, `MAIL_IMPORT_LIST_PAGE_MAX` in
`lib/mail-import/types.ts`), with `nextCursor` for the next. The import dialog
reads the first page. Whether the person already has an import open is asked
on its own (`findOpenMailImportOf`), never read off a page, so an open import
older than a page of finished ones still refuses a second start with its id.

**Who may run it.** An outside agent on the office door can do everything the
dialog does. Piloti is offered only the list, the read and the cancel:
`mail-import-start`, `-part-upload` and `-complete` are `piloti: false`
(`exposure.config.ts`), because Piloti holds no archive and one 32 MiB part is
far past what a proposal may carry.

## Endings

| Ending | When | What the person sees |
|---|---|---|
| `completed` | The cursor passed the last item | Inbox: imported, linking to the folder; later, the upload summary |
| `failed` | Not an archive; quota full; the person lost write access (to the project, or to the `E-Mail-Import` or archive folder) or left; the import's folder went to the Papierkorb; passing failures through every backoff with no mail filed; a job that kept vanishing | Inbox: stopped (its type would mail it after 30 min unread, once the inbox has a sender, `lib/inbox/delivery.ts`; none does today); the dialog words the reason (`error_code`) |
| `cancelled` | The person (or an org project administrator) cancelled; a send unfinished after 48 h | The dialog |

Each ending seals the upload batch and deletes the staged archive. What was
filed before a failure or a cancel stays, and gets its upload summary.

**A folder of the import deleted mid-import.** Nothing is filed into a folder in
the Papierkorb: the database refuses it (`GFD01`, migration 0115). When the
folder deleted is the archive's own (`E-Mail-Import/<archive>`, remembered as
`root_folder_id`) or one above it, the import ends `failed` at once (`stopped`,
the detail naming the Papierkorb), checked when a slice starts and when one
fails. It is not made again: the mails before the cursor are in the bin, so a
new folder would hold only the rest, and deleting the import's folder is a
person's word on it. Restoring the folder brings back what was filed; starting
the import again files the archive whole (` (2)`). A folder deleted *inside*
the archive's (an Outlook folder, one mail's) is a passing failure: the next
slice makes the folder again and files the mail into it.

The archive is staged under the project's prefix, so deleting the project
mid-import erases it with the project, and the purge aborts an upload still open
there (`purger/storage.js`, `abortMultipartUploads`). The stage is
`org/<org>/project/<project>/mail-imports/<import id>/archive`, and
`mail-imports` is a reserved key segment (`RESERVED_DERIVED_SEGMENTS` in
`lib/s3.ts`): a person's folder of that name is stored as `_mail-imports`, so
no document ever sits under the stage. The archive is deleted by its exact
key; the reservation is what would keep a delete by prefix from reaching a
document.

## Switching it on

1. The flag: create the `mail-import` WorkOS flag OFF in both environments
   and turn it on per organization
   ([`workos-provisioning.md`](../deployment/workos-provisioning.md)). There is
   no env switch; where nobody signs in it is off, as every entitlement is.
2. Data protection, before the first organization: an archive is the
   correspondence of everyone who wrote to the mailbox. The organization's Art. 28
   notice and the Art. 30 record have to cover imported correspondence; the
   notes and attachments are ordinary documents afterwards and are deleted the
   way documents are.

## Known limits

- An attached mail is skipped, not unpacked into its own folder.
- Switching the `mail-import` flag off stops new imports and the completion of
  an upload (`requireEnabled` in `startMailImport` and
  `completeMailImportUpload`). An upload already started still receives parts
  and can be cancelled; it never completes, and the sweep cancels it
  (`upload_expired`) after 48 h.
- The To and Cc addresses are in the note, and so in the index.
- The preview draws a note with the answer renderer (`MarkdownRenderer`,
  through `/text`), whose math and answer-dialect plugins the escape leaves
  alone: `$5 und $10` in a body is drawn as a formula, and a `:::details`
  line as a dialect block. Only the preview; the chunker reads neither.
- The BFF carries the archive's bytes; twenty gigabytes is twenty gigabytes
  through the frontend pods.
- `libpff-python` is pinned to its first cp314 release and is labelled alpha
  upstream; `GRID_PST_FIXTURE_DIR` runs `test_mail_archive_reader.py` over real
  archives when it moves.
- The import emits no PostHog event and no Langfuse trace (it makes no model
  call). What happened is on the `mail_imports` row (counts, `skipped_samples`,
  `error_code`), in the inbox item, and in the `bff` queue meters, which count
  slices, not imports. The import requeues itself after a failure instead of
  throwing, so a failing import never reaches `grid.queue.dead_total`.
