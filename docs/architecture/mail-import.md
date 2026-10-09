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
- **Filing.** `lib/mail-import/job.ts` runs on the BFF job queue as the person
  who started the import, 120 s of filing per slice, checked before every
  attachment. `filing.ts` files one mail: its folder, its attachments through
  `uploadDocument` at `bulk` ingest priority, then the note. The cursor moves
  past a mail only after it is filed. A retried mail files into the folder it
  had, under the same names, so each file is the same document again (a new
  version, or `unchanged` once indexed), never a second one. Every upload
  carries the import's upload batch (below).
- **Folder access (ADR-0087, ADR-0088).** Every slice first checks that the
  person may write the archive's folder, or, before it exists, the
  `E-Mail-Import` root folder (found by name, so one with its own access list
  is judged as it is). A refusal ends the import `failed` with `access` at once,
  instead of a refused folder creation per slice until the streak runs out. The
  action is offered only to a reader whose project-root access is `write`
  (`projectRootAccess`), because the import files its folder at the root.
- **Retries.** A passing failure hands the import to a fresh job that waits 1,
  5, 15, 30, 60, then 120 minutes; filing a mail resets the streak. The
  background-work sweep gives an import whose job vanished a new one.
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

**Not filed, and named in the import's list:** attached mails (a forward's
original), files the upload path refuses (type, size, and the office's name
screening,
[ADR-0086](../adr/0086-uploads-are-screened-locally-and-matches-wait-in-quarantine.md),
which reads the Outlook folder path as part of the name), files into a folder
that turned read-only for the person under the import (`access`), a name another
document claimed between the probe and the upload (`name_taken`), and messages
or attachments damaged in the archive. The import never releases a screened
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

## Endings

| Ending | When | What the person sees |
|---|---|---|
| `completed` | The cursor passed the last item | Inbox: imported, linking to the folder; later, the upload summary |
| `failed` | Not an archive; quota full; the person lost write access (to the project, or to the `E-Mail-Import` or archive folder) or left; passing failures through every backoff with no mail filed; a job that kept vanishing | Inbox: stopped (emailed if unread after 30 min); the dialog words the reason (`error_code`) |
| `cancelled` | The person (or an org project administrator) cancelled; a send unfinished after 48 h | The dialog |

Each ending seals the upload batch and deletes the staged archive. What was
filed before a failure or a cancel stays, and gets its upload summary.
The archive is staged under the project's prefix, so deleting the project
mid-import erases it with the project, and the purge aborts an upload still open
there (`purger/storage.js`, `abortMultipartUploads`).

## Switching it on

1. The deployment: `grid-oib:mailImportEnabled` (Pulumi) or
   `GRID_MAIL_IMPORT_ENABLED=true` (Compose) while flag enforcement is off; with
   enforcement on, create the `mail-import` WorkOS flag OFF and turn it on per
   organization ([`workos-provisioning.md`](../deployment/workos-provisioning.md)).
2. Data protection, before the first organization: an archive is the
   correspondence of everyone who wrote to the mailbox. The organization's Art. 28
   notice and the Art. 30 record have to cover imported correspondence; the
   notes and attachments are ordinary documents afterwards and are deleted the
   way documents are.

## Known limits

- An attached mail is skipped, not unpacked into its own folder.
- The BFF carries the archive's bytes; twenty gigabytes is twenty gigabytes
  through the frontend pods.
- `libpff-python` is pinned to its first cp314 release and is labelled alpha
  upstream; `GRID_PST_FIXTURE_DIR` runs `test_mail_archive_reader.py` over real
  archives when it moves.
