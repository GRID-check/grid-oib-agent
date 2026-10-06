# Sensitive data, quarantine and folder access

What an office can keep out of Piloti, what it can keep from some of its own
people, and how an uploader learns what became of an upload. The decisions
behind this are ADR-0077 (screening and quarantine), ADR-0078 (folder
access follows WorkOS roles) and ADR-0079 (read and write per role).

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

## Chat messages

The **content terms and number checks** apply to what people type into the chat
as well; the file-name terms do not. When a message contains one, the composer
does not send it. It says what it found, for example „Enthält eine IBAN
(Sensible Daten). Piloti sendet sie nicht an das Modell.", and offers two
choices:

- **Maskiert senden** sends the message with each match replaced, so Piloti
  reads „Bitte überweise an [IBAN entfernt]". The placeholders are
  `[IBAN entfernt]`, `[SV-Nummer entfernt]`, `[Kartennummer entfernt]` and
  `[Begriff entfernt]`.
- **Bearbeiten** sends nothing and leaves the text as you typed it.

There is no way to send the message unmasked. An answer to a question Piloti
asked is checked the same way, and so is a plan you edit before approving it,
and so are messages to colleagues in a shared chat. A message that reaches
Piloti some other way is masked on the server without asking, and the stored
chat keeps the masked text: your messages and your answers to Piloti's
questions. In Piloti's own answers only numbers are masked (IBAN,
Sozialversicherungsnummer, Kartennummer); an answer that names a term from the
list, such as „Es gibt keine Honorarvereinbarung", reads the same after a
reload. The name of the file you ask
about („Frage zu …") is masked the same way before Piloti reads it.

The same list masks, without asking, what you write elsewhere that Piloti
later reads:

- **notes** you add or edit in the Projektspeicher or the Organisationsgedächtnis,
  and the notes Piloti keeps itself;
- the **comment on a thumbs-down**.

Masking a term hides the word, not what stands around it: „Honorarvereinbarung
über 12.400 €" becomes „[Begriff entfernt] über 12.400 €". A change to the list
applies to an open chat once the page is reloaded.

**Not checked** against the list, so keep sensitive data out of them yourself:

- the standing instructions under **Organisation → Anweisungen**, and the
  instructions of a **Skill**, which Piloti reads when it answers;
- the **project profile** you fill in with the intake wizard;
- the comment a reviewer writes when sending a draft back („Änderungen
  anfordern"), which the chat that wrote the draft reads;
- the instruction of a **scheduled task**, and a research job started through
  the API;
- anything stored before the list applied to it: older chats, notes and
  comments keep the text they were saved with.

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
- A role can be deleted once nobody holds it. If folders name it in their
  access list, Piloti shows which folders (organization admins see their
  names, other role managers how many) and asks you to confirm. After the
  deletion those lists match nobody: only organization admins can read the
  folders until someone sets a valid role, and the project's settings list them
  under **Ordner ohne gültige Rolle**, with a link to each. Renaming a role
  changes nothing for folders: they follow its identifier, not its name.
- Until your Piloti installation lets a person hold several roles, everyone
  holds exactly one. A role you use for folders must then also carry the
  permissions its holders work with.

## Who may read and edit a folder

(Which downloads and openings of such a folder are recorded, and who may read
that record: [the download log](download-log.md).)

In a project's Files, a project admin opens a folder's **⋯ → Zugriff …** and
chooses one of two answers. Only someone who both manages the project and may
**edit that folder** can do this: a project admin who may only read a folder
cannot change who may read or edit it, so they cannot give themselves
„Bearbeiten". An organization admin can always:

- **Wie der übergeordnete Ordner**: the folder has no list of its own. A
  folder at the top of the project follows the project, so everyone keeps what
  their project permissions allow.
- **Eigene Zugriffsrechte**: the folder has its own list. Each entry is one of
  your office's roles, or **Alle Projektmitglieder**, with **Lesen** or
  **Bearbeiten**. A role that is not on the list gets nothing: for its holders
  the folder is absent. An own list names at least one entry.

A folder with its own list carries a lock that names the entries. Three rules
decide what someone may do in it:

- **A subfolder can only narrow.** Someone may do in a folder the least of what
  every list above it, and its own, allows them. A list inside a folder that
  only Geschäftsführung may read cannot open it to Buchhaltung.
- **„Bearbeiten" never goes beyond the project.** It lets someone upload,
  rename, move, delete and file into the folder as far as their project
  permissions already allow; a project reader with „Bearbeiten" still only
  reads.
- **Organization admins may read and edit every folder.** Whether someone is an
  organization admin is read from your organization's people settings at most a
  minute ago, like their roles: an admin who is demoted stops reaching every
  folder within a minute, not when they next sign in.

Someone who may only read a folder sees it marked **Nur lesen**: they can open
and search its documents, and there is no upload, new folder, rename, move or
delete in it for them. A folder they may not read is **absent**, not greyed
out:

- it is not listed, and neither is anything in it or below it, including files
  uploaded there later;
- Piloti's search and answers do not draw on it, because its documents are kept
  in their own search index that only the chats of people who may read it
  search;
- its documents do not open from a link, the inbox or a share.

A list with **Alle Projektmitglieder** on it keeps the folder readable by
everyone, so its documents stay in the project's own index; such a list only
decides who may edit. Every other own list moves the folder's documents into
their own index and reads them again when it is saved; for a large folder that
takes a few minutes, and the documents show „Wird gelesen" meanwhile. Changing
only who may edit moves nothing.

Who holds which role is read from your organization's people settings at most a
minute ago, so a role taken from someone stops opening a folder within a
minute.

**Moving a folder** needs „Bearbeiten" on it and on the folder it goes into. A
move that changes which folder lists apply to it (out from under a folder with
its own list, or under one) also needs project admin rights, and is refused
unless you may read every folder inside it: otherwise it would change who may
read folders you cannot see. Ask an organization admin to move such a folder.

**Review rounds** are offered only to people who may edit the project and may
read the folder the document is in, so nobody is asked to review something
they cannot open. A change of a folder's access shows in Piloti's project
context (the list of documents with a role, such as the Bebauungsplan) right
away, and the projects overview counts only the documents you may read.

**Deleting a folder** moves its documents and subfolders into the folder above,
as before. The folder keeps its access list out of sight, so what Piloti
recorded from it, in a chat or in its memory, stays visible only to the people
who could read it.

**A chat that draws on a folder not everyone may read is shared per person.**
It can be shared with someone who may read every such folder it drew on, and
with nobody else. It counts as drawing on a folder once content from it reached
Piloti's answer: a search hit, an opened document, an image, a remembered note.
Being able to search the folder is not enough, and until then Piloti does not
list the folder's files, suggest their names or say that one exists; it finds
them by searching. If the chat is shared with someone who
may not read the folder, Piloti stops searching that folder in the chat from
the next question on. A file name used in such a folder cannot be uploaded a
second time elsewhere in the project.

**Sharing such a chat shows only people who qualify.** In the share dialog,
colleagues who may not read every folder the chat drew on appear greyed out
with „Hat keinen Zugriff auf einen Ordner, aus dem dieser Chat stammt“, without
naming the folder (you may not be allowed to read it either). Piloti still
refuses the invitation on its own check.

**When access changes after sharing.** A chat whose folders someone may no
longer read (their role was taken away, or the folder was narrowed) stays in
their list as **Geteilter Chat**. Opening it says „Ihnen fehlen inzwischen die
Rechte, um diesen Chat zu sehen“, and shows no title, message, card or
attachment. Whoever shared it sees the person marked **Hat keinen Zugriff
mehr**. This applies to whoever started the chat, too. It is decided each time
the chat is opened or listed, within a minute of the role change, and nothing
is deleted: when the person gets the role back or the folder is opened again,
the chat is whole again. Their inbox does not show the chat's title either.
Anything they copied or downloaded earlier stays with them.

Nothing from such a chat goes where the whole project reads it, so Piloti does
not offer, and refuses with a message saying why:

- a Tiefenrecherche or an Auftrag started from it (this stays so for now, even
  for a chat whose folders everyone may read again);
- a change to the project context („Projektkontext aktualisieren");
- filing a draft or a diagram from it into a folder that is not inside every
  folder the chat drew on. Piloti files these into „Berichte", so they stay in
  the chat unless they are moved there by hand.

Whether a chat drew on such a folder is decided against the folders' lists as
they are now: when a folder is opened to everyone, the chats and notes that
drew on it are no longer held back by it; when a list is narrowed, they are
shown to fewer people. The project context can still be changed by hand, in
the project intake.

**What Piloti remembers from such a chat is restricted too.** Piloti keeps
notes from it in the project's memory as it does from any chat, but a note that
draws on a folder not everyone may read is shown, under Projektspeicher, only to
people who may read that folder now, with a lock that names it, and only their
chats are given it. Everyone else does not see the note at all. A note meant
for the whole organization that draws on such a folder is kept in the project
instead.

**Building models (IFC) stay in folders everyone may read.** A model's
building data is kept per project, not per folder, so a list could not protect
it. Piloti therefore refuses an IFC model in a folder not every member may
read: uploading one there, moving one there, moving a folder that holds one
under such a folder, and giving a folder that holds one such a list all fail
with a message saying why. A list that includes **Alle Projektmitglieder** is
fine. A model that was already in such a folder before this check existed is
hidden from everyone who may not read that folder, in the model list, the
viewer and the download, and Piloti's model questions do not reach it; its
summary may still be found by Piloti's search, so move such a model to an open
folder.
