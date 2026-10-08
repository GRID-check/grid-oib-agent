# Sensitive data and quarantine

What an office can keep out of Piloti, and what happens to a file that
matches. The decision behind this is ADR-0086 (screening and quarantine).

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
   layer, a photo) is **checked by name only**.

## The quarantine

**Organisation → Quarantäne.** A quarantined file shows which terms or checks
matched, never the matched text beyond a masked sample. Organization admins,
the project's admins and, for the Büroablage, its curators can:

- **Release** it. Piloti then reads it like any other upload. The release
  applies to exactly these bytes: uploading a changed version screens it again.
- **Delete** it.
