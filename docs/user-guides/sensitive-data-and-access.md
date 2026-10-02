# Sensitive data, quarantine and folder access

What an office can keep out of Piloti, what it can keep from some of its own
people, and how an uploader learns what became of an upload. The decisions
behind this are ADR-0077 (screening and quarantine) and ADR-0078 (folder
access).

## The sensitive-data list

**Organisation → Sensible Daten.** Admins with the organization-settings
permission decide what must not be uploaded:

- **Terms for file and folder names**, with exceptions. „Rechnung" matches
  „Schlussrechnung 03.pdf" and a folder „Rechnungen"; the exception
  „Berechnung" keeps „Statische Berechnung.pdf" in. Case, umlauts and the way
  a Mac spells „ä" do not matter.
- **Terms for the content**, such as „Lohnzettel" or „Honorarvereinbarung".
- **Checks for numbers**: IBANs, Austrian social security numbers and card
  numbers, each validated by its check digit, so a plan number that merely
  looks like one does not match.

An office that never saved a list works with Piloti's suggested one. The list
can be switched off.

## What happens to an upload

1. **Before anything leaves the computer**, the upload dialog shows which files
   the name terms hold back and why. Those files are never sent. A single file,
   such as a Bauvertrag in a folder called „Verträge", can be released with one
   tick; the release is recorded in the audit log. The server checks the names
   again, so a browser that skips the dialog is refused the same way.
2. **On Piloti's own server, before any language model sees the file**, its text
   is read locally and checked against the content terms and number checks. A
   match ends there: the file is stored, read by no model, and waits in
   quarantine.
3. A file whose text cannot be read locally (a scan, a plan without a text
   layer, a photo) is **checked by name only**. The summary says so, so nobody
   takes „nothing found" for „nothing there".

What Piloti drops on its own: system files a folder carries along, such as
`.DS_Store`, `Thumbs.db` and Office lock files (`~$Vertrag.docx`).

## The quarantine

**Organisation → Quarantäne.** A quarantined file shows which terms or checks
matched, never the matched text beyond a masked sample. Organization admins,
the project's admins and, for the Büroablage, its curators can:

- **Release** it. Piloti then reads it like any other upload. The release
  applies to exactly these bytes: uploading a changed version screens it again.
- **Delete** it.

Reviewers get an inbox notice when files wait for them. It names no file.

## What arrived: the upload summary

When everything an upload brought in has been read, the uploader gets an inbox
notice. It opens a summary of that upload: what arrived and where it was filed,
what each file is (its document type and summary), which files the screening
kept on the computer and for which terms, what is in quarantine, and what
failed and why. While files are still being read, the summary updates itself.

**Project settings → Uploads** lists every upload into the project, newest
first, with who uploaded it and what became of its files. Each person opens
the file-by-file summary of their own uploads only.

## Your office's own roles

**Organisation → Personen & Zugriff → Eigene Rollen.** People who may manage
people and roles create roles such as „Geschäftsführung" or „Buchhaltung",
choose the permissions each carries, rename them and delete them. The roles
live in WorkOS, where Piloti's own roles live; you assign them to people on the
**Personen** tab.

- A role can only carry permissions its editor holds.
- A role can be deleted once nobody holds it.
- Until your Piloti installation lets a person hold several roles, everyone
  holds exactly one. A role you use for folders must then also carry the
  permissions its holders work with.

## Restricting a folder

In a project's Files, a project admin opens a folder's **⋯ → Zugriff …** and
chooses **Alle im Projekt** or **Nur bestimmte Rollen**. A restricted folder
carries a lock that names its roles.

Someone is cleared for a folder if they hold one of its roles, and, for a
folder inside another restricted folder, one of that folder's roles too.
Organization admins see every folder. For everyone else a folder they are not
cleared for is **absent**, not greyed out:

- it is not listed, and neither is anything in it or below it, including files
  uploaded there later;
- Piloti's search and answers do not draw on it, because its documents are kept
  in their own search index that only cleared people's chats search;
- its documents do not open from a link, the inbox or a share.

Saving a change moves the folder's documents into the right index and reads
them again; for a large folder that takes a few minutes, and the documents show
„Wird gelesen" meanwhile.

**A chat that draws on a restricted folder stays with the person who asked.**
It cannot be shared, and Piloti writes nothing from such a chat into the
project's memory. A file name used in a restricted folder cannot be uploaded a
second time elsewhere in the project.

**Building models (IFC) stay in open folders.** A model's building data is
kept per project, not per folder, so a restriction could not protect it.
Piloti therefore refuses an IFC model in a restricted folder: uploading one
there, moving one there, moving a folder that holds one under a restricted
folder, and restricting a folder that holds one all fail with a message
saying why. A model that was already in a restricted folder before this check
existed is hidden from everyone not cleared for that folder, in the model list,
the viewer and the download, and Piloti's model questions do not reach it; its
summary may still be found by Piloti's search, so move such a model to an open
folder.

**Not yet covered:** a role withdrawn from someone takes effect on their next
connection, not in a chat they already have open.
