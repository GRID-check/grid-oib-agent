# Sensitive data and the AI Act

A short note for offices: which parts of the sensitive-data features are
automated, which of them use a language model, where a person decides, what the
audit log records, and how Piloti marks what it generates. The features
themselves are described in
[Sensitive data, quarantine and folder access](sensitive-data-and-access.md).

Piloti is classified as an AI application with limited risk (see its
**KI-Transparenzhinweis**, `/legal/ai-transparency`). It decides nothing about
buildings, permits or people, and it is not a high-risk system under Annex III
of the AI Act. Logging and human oversight are therefore not legal duties for
Piloti. It provides both anyway, as described below.

## What is automated, and what is a model

| What | How it decides | A model? |
|---|---|---|
| **Upload screening** of file and folder names | Matches your office's term list, with its exceptions | No. Fixed rules |
| **Content screening** of an upload, on Piloti's server before any model sees the file | Matches the text against your content terms, and checks numbers (IBAN, Austrian social security number, card number) by their check digits | No. Fixed rules. A file whose text cannot be read locally is checked by name only, and the summary says so |
| **Chat screening** of what people type | The same content terms and number checks | No. Fixed rules |
| **Quarantine** of an upload | Follows from a content match | No. A rule match, never a model's judgement |
| **Who may read a note Piloti keeps** from a chat that could see a restricted folder | When the chat read the folder, the note is restricted to it. When the chat could only list the folder's documents, a **language model (the memory judge)** decides whether the note draws on them. If the judge gives no usable answer, the note is restricted to every restricted folder in the chat | **Yes**, for the memory judge |
| **Answers, research reports, notes Piloti keeps, drafts and diagrams** | Language models | **Yes** |

The screening is deterministic: the same file and the same list give the same
result every time, and every verdict names the rule that matched.

## Where a person decides

- **Quarantine release.** A quarantined file stays unread until an organization
  admin, a project admin or (for the Büroablage) a curator releases or deletes
  it under **Organisation → Quarantäne**. Piloti never releases a file itself.
- **A name match in the upload dialog.** The uploader can release a single file
  that a name term held back, such as a Bauvertrag in a folder called
  „Verträge".
- **Chat masking.** When a message contains a match, the person chooses
  **Maskiert senden** or **Bearbeiten**. There is no way to send it unmasked.
- **Folder access.** People decide which folders are restricted, and for which
  roles. The memory judge only decides about a note's readers within those
  restrictions, and it can only add restrictions, never remove one a read set.

The memory judge has no human check at the moment it decides. If it answers
that a note does not draw on a restricted folder, the note is open to the
project. That is the accepted risk of keeping memory in restricted chats
(ADR-0087), and it is why each of its verdicts is in the audit log. A
restricted note the judge helped decide on says so beside its lock in the
Projektspeicher („von KI mitbestimmt"), and the lock's tooltip names its
folders. A note the judge left open carries no such mark: its readers may not
know that a restricted folder exists, and the mark would tell them. That
verdict is in the audit log only.

## What the audit log records

People with the audit-log permission open it under **Organisation →
Compliance → Audit-Logs ansehen**. It records only when your Piloti
installation has the audit log switched on.

| Event | When | Recorded as acting |
|---|---|---|
| `org.upload_screening.updated` | Someone changes the sensitive-data list. Counts only, never the terms | The person |
| `document.screening_overridden` | An uploader releases a file a name term held back. The terms that matched | The person |
| `document.quarantined` | The content screening quarantines a file. Which file, its project, whose upload it was, the kinds and terms that matched (`term:Lohnzettel,iban`), whether the whole text could be checked, and the screening run that decided. A file in a folder not every project member may open is recorded without its name, as for every event that names a file. Once per decision, at the time of the decision: if the audit log cannot be reached, Piloti keeps the decision and sends it again within minutes, even if the file was deleted meanwhile. Piloti's own copy is deleted once the audit log has it, and after seven days at the latest | `system:upload_screening` |
| `document.quarantine_released` | A reviewer releases a quarantined file. The kinds and terms it was held for | The person |
| `project.memory.restriction_judged` | The memory judge decides about a note. Which note (by id), its project, the verdict (`drawn`, `none` or `failed`), the folders it was asked about, the folders it named, the folders the note is restricted to, and the chat it came from. Also when the note was meant for the whole organisation and your installation does not let Piloti store those itself (the default): then the event names the organisation instead of a note (`outcome: refused`), because the judge's verdict decided that Piloti offered it to you to save, unrestricted | `system:memory_judge` |

None of these events holds a file's content, a matched number, or a note's
text. A detector's masked sample stays on the quarantined file, where only its
reviewers see it.

Not in the audit log: the choice to send a chat message masked (the stored chat
keeps the masked text), and a chat or note that was screened without a match.
Who downloaded or opened which file is in [the download log](download-log.md).

## How Piloti marks what it generates

- **In the app.** The line under the message box reads „Piloti ist ein
  KI-System — Antworten können falsch sein; prüfen Sie sie anhand der zitierten
  Unterlagen." It is always shown. The **KI-Transparenzhinweis** page explains
  the system, its models and its limits.
- **In files Piloti produces.** A filed report or draft (PDF or Word), a
  diagram (SVG or PDF) and an answer exported as a Word document each carry a
  visible notice that Piloti generated them and no person checked them, and a
  machine-readable marking in the file itself (`AIGenerated`, `AIGenerator: Piloti`,
  `AIHumanReviewed`): see [Reports Piloti writes](agent-authored-reports.md).
- **Not yet marked.** Article 50(2) of the AI Act asks that generated text be
  marked in a machine-readable way. Answers and cards shown in the chat, and
  text copied from them, carry no such marking today; only the notice under the
  message box tells a reader they are generated. This is open, and tracked in
  [the compliance audit](../compliance/compliance-audit-2026-07.md).
