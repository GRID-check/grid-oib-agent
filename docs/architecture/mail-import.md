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
  │                                                                                                     uploadDocument ×n
  │                                                                                                     advance cursor
  │                                                                                                     … until done:
  │ inbox: imported / stopped ◀─────────────────────────────────────────────────────────────────────── delete staging
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
  version, or `unchanged` once indexed), never a second one.
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
so a name that is still taken is numbered (`… – Plan (2).pdf`).

**Not filed, and named in the import's list:** attached mails (a forward's
original), files the upload path refuses (type, size), and messages or
attachments damaged in the archive. Counted but not named: items that are not
mail (appointments, contacts, tasks). Not counted: a mail's inline pictures
(signature logos).

## Endings

| Ending | When | What the person sees |
|---|---|---|
| `completed` | The cursor passed the last item | Inbox: imported, linking to the folder |
| `failed` | Not an archive; quota full; the person lost write access or left; passing failures through every backoff with no mail filed; a job that kept vanishing | Inbox: stopped (emailed if unread after 30 min); the dialog words the reason (`error_code`) |
| `cancelled` | The person (or an org project administrator) cancelled; a send unfinished after 48 h | The dialog |

Each ending deletes the staged archive. What was filed before a failure stays.
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
