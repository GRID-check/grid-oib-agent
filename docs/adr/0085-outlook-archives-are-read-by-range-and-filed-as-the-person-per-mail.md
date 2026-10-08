---
status: proposed
date: 2026-10-08
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Outlook archives are read by range and filed as the person, one folder per mail

## Context and Problem Statement

A planning office keeps years of correspondence with authorities, clients and
consultants in Outlook, and when a project's correspondence has to move it moves
as an archive: a `.pst` exported by Outlook, or the `.ost` it caches from
Exchange. One archive is one file, routinely several gigabytes and up to twenty.
The product could not take it. The upload path holds one file of at most a
hundred megabytes in memory and writes it as one object; nothing in the BFF, the
backend or ingestion could read an archive's contents; and a mail body in any
form other than an attachment's own format was not indexable.

The project mail inbox (#831, unmerged) files mail that arrives one message at a
time, as RFC 822 bytes. An archive is not that: a PST is MAPI's own B-tree of
items, not a sequence of `.eml` files, so the inbox's parser does not apply.

## Decision Drivers

* The archive must never be held whole: not in a request, not in memory, not on
  a pod's disk.
* Filing must survive a restart in the middle of a twenty-gigabyte archive, on
  any worker, without filing a mail twice.
* Everything filed must pass the same gates as a person's upload: type, size,
  quota, project permission, audit actor.
* Buy the parser. MAPI's format is decades of edge cases (ANSI and Unicode
  layouts, compressed RTF, OST variants).

## Considered Options

* **Parser:** `libpff-python` (libyal, Python, LGPL-3.0-or-later) / `pst-extractor`
  (Node, MIT) / `readpst` (libpst CLI, GPL-2+) / write one.
* **Transport:** browser to object storage with presigned multipart URLs /
  browser to the BFF in parts, written through to S3 multipart / one request.
* **Where the reading runs:** the BFF job worker / the Python backend.

## Decision Outcome

1. **The archive is staged as an S3 multipart upload, sent through the BFF.**
   The browser sends 32 MiB parts to `PUT /api/projects/[id]/mail-imports/[importId]/parts/[n]`;
   the BFF checks the person and the part's exact size and writes it as one
   part, under the project's prefix so the project purge erases it (and aborts
   an upload left open there). The store's CORS and its public endpoint stay out of the design, and
   every byte is behind the project permission. A send that breaks off resumes
   from the parts the store holds (`ListParts`).
2. **The backend reads it where it lies, by range.** `libpff-python` opens a
   file object, and `aiq_api.mail_archive.remote_file.RangeFile` is one over a
   presigned GET, serving libpff's many small reads from a cache of aligned
   1 MiB blocks. A failed range request is remembered, because libpff reports
   any read error as damage to the archive: the backend answers 502 (retry) for
   the store's failure and 422 only for a file that really is not an archive.
   It is the only candidate that reads ANSI, Unicode and OST
   archives from a file object and exposes plain, HTML and RTF bodies; the
   spike against the pst-extractor corpus read both fixtures completely.
   `pst-extractor` opens a path only, so a slice would first download the whole
   archive to a pod's disk; `readpst` converts to files on disk the same way and
   would need an apt package in the release image.
3. **Messages are numbered, and the number is the cursor.** One depth-first
   order over the person's mail tree (the mailbox's `IPM_SUBTREE`, the PST's
   personal folder tree) gives every item a position that depends only on the
   archive. Non-mail items (appointments, contacts) keep their number and are
   counted as skipped.
4. **The BFF job queue files it (ADR-0079), as the person, a time budget per
   slice.** `mail_import` reads a page from the cursor and files each mail
   before it moves the cursor past it, with a conditional update. The mail being
   filed is recorded on the row the moment its folder exists (and the record is
   the fence: a slice that is no longer the import's files nothing), so a slice
   that dies resumes into that folder; everything before it is never touched
   again. The budget is checked before every attachment, so a slice ends well
   inside the runner's request timeout instead of running on beside its retry.
5. **Retries are the import's own, not the queue's.** The queue spends attempts
   per job and never gives them back for progress, so three passing outages
   hours apart would end a long import. A slice that fails for a passing reason
   hands the import to a fresh job held back by a backoff (1, 5, 15, 30, 60,
   120 minutes) and ends; `failure_streak` counts failures since a mail was last
   filed, and only a streak through every backoff ends the import. The
   background-work sweep gives an import whose job vanished a new one on the
   same streak. A refusal (403/404), an unreadable archive and a full quota end
   it at once; a damaged message or attachment is skipped and named.
6. **One folder per mail, under `E-Mail-Import/<archive>/<Outlook folder>/`,
   named `<date time> – <sender>`.** Never the subject: a folder name and a
   filename become storage keys, audit targets and titles, and the subject is
   the one header that carries content. A filename is unique per project, not
   per folder, so every file of a mail is prefixed with its folder's name and
   numbered when it still collides.
7. **The mail itself is filed, as a Markdown note.** Its headers (subject,
   from, to, cc, dates, Outlook folder, the attachments filed) and its text, from
   the plain body, else the HTML, else the RTF (`striprtf`). `.md` is indexed
   today, so the correspondence is searchable and citable; the inbox (#831)
   files attachments only, which is right for a stream of incoming files and
   wrong for an archive of correspondence. Inline pictures (logos, signatures)
   and attached mails are not filed; every other refusal is named.

### Consequences

* Good, because a twenty-gigabyte archive costs the bytes a slice touches, on
  any replica, and an interrupted send or slice resumes rather than restarts.
* Good, because filing reuses the upload path whole, so quota, type gates,
  ingest (at `bulk` priority) and audit behave as for a person's upload.
* Bad, because a native, LGPL dependency enters the backend image. It arrives
  as a manylinux wheel (no compiler), is used unmodified as a library, and its
  only cp314 release is the one pinned. Its own README calls it alpha.
* Bad, because the BFF carries the upload's bytes. Twenty gigabytes through the
  frontend pods is the price of keeping the store private.
* Neutral: an attached mail (a forward) is skipped in this version, not unpacked.
* Neutral: the import is behind the `mail-import` WorkOS flag, or
  `GRID_MAIL_IMPORT_ENABLED` without enforcement, off by default. An archive is
  the correspondence of everyone who wrote to the mailbox; switching it on for
  an organization is a decision about that data, so the operator makes it.

### Confirmation

`frontends/aiq_api/tests/test_mail_archive_*.py` pin the walk, the cursor, the
range reader and the body conversion; `GRID_PST_FIXTURE_DIR` runs the walk over
real archives. `frontends/ui/src/lib/mail-import/*.spec.ts` pin the part
arithmetic, the slice (resume into the in-flight folder, an advance refused when
another slice moved the cursor, the endings) and the naming.

## More Information

The flow, the routes and the operator steps: `docs/architecture/mail-import.md`.
