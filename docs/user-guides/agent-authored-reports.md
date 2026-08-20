# Reports Piloti Writes

A deep-research run used to end as a long chat message. The report existed as a
file for a few minutes inside the run and was then thrown away with it — so the
only way to keep it was to copy it out, and the only place it could live was
your Downloads folder.

Now the finished report is **filed into the project**, as an ordinary file, in a
folder called **Berichte**. It behaves like every other file you have: you can
find it, preview it, assign it, share it, download it and delete it. What is
different is what it *says about itself*, and this guide is about that.

---

## Where the report goes, and when you are told

You are told **before** it exists, not after.

While a deep-research run is starting, the banner in the chat carries one quiet
line under the usual "this may take several minutes":

> Der fertige Bericht wird in diesem Projekt unter „Berichte“ abgelegt.

That line is on the *starting* banner deliberately. It is the moment the run can
still be stopped, which is the only moment at which knowing the destination is
worth anything. There is no dialog and no "are you sure": a confirmation asked
after a twenty-minute run is only ever answered yes, so it would be a receipt
rather than a decision.

It matters more than it looks, because a deep-research run does not always begin
because you asked for one. Piloti escalates a question to deep research by
itself when a short answer would not hold, and when it does it says so on the
line above the banner ("Eskaliert zur Tiefenrecherche: …"). In that case nobody
ordered a report — so the destination line is the whole of what you were told,
and it is there in both cases.

When the run finishes, the success banner names the file and offers a second
action:

> Im Projekt abgelegt: fluchtweglaengen-gk4-2026-08-20.pdf
>
> **Bericht anzeigen** · **Im Projekt öffnen**

Two actions, two places: *Bericht anzeigen* opens the research panel beside the
chat, *Im Projekt öffnen* opens the file in the project's Dateien.

**If nothing was filed, the banner says nothing about a file.** Filing is
skipped or refused in ordinary situations — a chat that is not inside a project,
an organization that does not grant its members the right to write documents, a
full storage quota. In none of those is the report lost; you still get it in the
research panel. The banner simply does not claim a file that does not exist.

---

## What you see in Dateien

The report is a normal file in the **Berichte** folder, with three marks on it.

**A byline: „Von Piloti erstellt".** A quiet line under the file name, on the
card and in the preview. It says who *wrote* it. It is deliberately not a face
and never appears in the assignment row, because a face on a file means
something else entirely — see below.

**A neutral status badge: „Abgelegt".** Not green, not red. Green would promise
that the file is searchable, which it is not; red would say something went
wrong, which nothing did. The bytes are here and indexing was deliberately
skipped, and *Abgelegt* is the word for exactly that.

**„Unvergeben" in the footer.** Nobody is responsible for this report yet, and
that is the correct state, not a gap someone forgot to fill. Piloti cannot carry
professional responsibility for a document; only a person can. Until somebody
clicks **Zuweisen** (or **Mir zuweisen**), the report is a draft nobody has put
their name to.

Two filters find these files, and they combine:

- **Unvergeben** — the same chip a project lead already uses to clear the
  unclaimed files before an Einreichung. A generated report shows up there like
  any other unassigned file, which is the point: it joins a ritual that already
  exists instead of needing a new one.
- **Von Piloti** — everything Piloti has written for this project, regardless of
  which folder it sits in. Moving or renaming *Berichte* later would not break
  it, because this filter never asked about the folder.

### Taking responsibility

**Zuweisen → Mir zuweisen.** That is the whole promotion step. Nothing about the
document changes except who is on the hook for it — which is the entire point of
the gesture. There is no separate "approve" or "publish" action, because being
answerable for the content *is* the approval.

---

## Why it is not in the knowledge base

Ask Piloti about a generated report and the action is **disabled**, with the
reason on it:

> Von Piloti erstellt — nicht in der Wissensbasis

This is a design decision, not a missing feature and not a wait. A report Piloti
wrote is never indexed, so no searchable passages of it exist anywhere.

The reason is worth knowing, because it protects you. If a generated report were
searchable, Piloti could retrieve its own earlier draft and cite it back to you
as evidence — with the same green *Projektwissen* badge as a stamped Gutachten,
and no way for you to tell the two apart. A claim it made on Tuesday would come
back on Friday looking like a source. Not indexing the report makes that
impossible rather than merely unlikely.

The file is still a file: you can search for it **by name** in Dateien, preview
it, and read it. It is only the *retrieval* layer that has never heard of it.

---

## Handing it to somebody outside the office

Download the report and the marking travels with it. This is the part that
matters most, because the chat window stays inside your office and the document
does not.

- **On page one, in the document itself:** a block headed
  **„KI-generiert — nicht geprüft"**, saying that Piloti wrote it, that no human
  has reviewed it, and that it is a draft rather than a Nachweis. It is printed
  content, not screen chrome — it survives printing, forwarding, and being
  attached to an e-mail.
- **In the file's properties:** `AIGenerated`, `AIGenerator`,
  `AIHumanReviewed` and the run id. A records system can detect the document as
  machine-written without anyone reading it. In the filed **PDF** they sit in
  the document's `Keywords` field, with „Piloti" as the *Creator* and the
  headline repeated as the *Subject* — the three fields a viewer's
  document-properties panel shows. A PDF has no place for named custom
  properties the way a Word file does, so the marking uses the closest fields
  it has rather than none.

The marking is in both places on purpose: the block is for the person who opens
it, the properties are for the system that files it.

**Why a PDF.** The report is filed as a PDF so that it previews inside Dateien
— a Word file has no in-app preview and can only be downloaded, which is the
wrong shape for the one document in the project nobody has read yet — and
because an Einreichung attachment is a PDF. Exporting a *saved answer* from a
chat still gives you a `.docx`: that one is meant to be edited into a Befund,
and this one is meant to be read and handed on.

---

## Deleting it

Exactly like any other file. Deleting the report removes the row, the stored
object, the thumbnail, its sharing and its assignments. Nothing about a
generated report is harder to erase than an uploaded one — it was designed that
way rather than discovered to be so.

---

## Related

- [Documents](documents.md) — uploading, ingestion, the Files workspace
- [Chat](chat.md) — the research panel and the deep-research banners
- [Projects](projects.md) — project access and membership
