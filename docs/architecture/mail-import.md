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
  hold yet, three at a time, retrying a failed part; a send that broke off is
  resumed by choosing the same file again (`GET …/[importId]` lists the held
  parts). Closing the dialog does not stop a send; leaving the page does.
- **Reading.** `aiq_api.mail_archive` opens the staged object through
  `RangeFile`, a file object over presigned range GETs with a 64 MiB block cache.
  Items are numbered depth-first over the mail tree, so a position is a cursor.
- **Filing.** `lib/mail-import/job.ts` runs on the BFF job queue as the person
  who started the import, 150 s of filing per slice. `filing.ts` files one mail:
  its folder, its attachments through `uploadDocument` at `bulk` ingest
  priority, then the note. The cursor moves past a mail only after it is filed.

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

**Not filed, and named in the import's list:** items that are not mail
(appointments, contacts, tasks), attached mails (a forward's original), files
the upload path refuses (type, size), and a mail's inline pictures (signature
logos, which are not counted).

## Endings

| Ending | When | What the person sees |
|---|---|---|
| `completed` | The cursor passed the last item | Inbox: imported, linking to the folder |
| `failed` | Not an archive; quota full; the person lost write access or left; the job's last attempt failed; the sweep found it stalled | Inbox: stopped (emailed if unread after 30 min); the dialog words the reason (`error_code`) |
| `cancelled` | The person (or an org project administrator) cancelled; a send unfinished after 48 h | The dialog |

Each ending deletes the staged archive. What was filed before a failure stays.

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
