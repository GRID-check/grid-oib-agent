# Piloti

Piloti is the workspace for architects: an Austrian planning office runs its
work in it, every project and every process, and Piloti, the agent, is a
colleague in that office who does part of the work, with a source for every
claim. Building law is one of the things it knows, not the frame around it
([`VISION.md`](VISION.md)). This file is its domain language: what the words mean, in the product and
in conversation about it. The engineering vocabulary (tenancy helpers, CI,
deploys, tooling) is in [`docs/glossary.md`](docs/glossary.md).

Product copy is German, so many terms are German. The English gloss follows the
term.

## The office and its work

**Piloti**:
The product, and the colleague persona that works in it. The name users see.
_Avoid_: GRID in anything a user reads; GRID is the repository's and the code's name.

**Organization** (Büro):
A planning office, and the boundary nothing crosses: its documents, memory,
projects and members are never visible to another organization.
_Avoid_: tenant, in product copy.

**Project** (Projekt):
One building project inside an organization, with its own documents, intake
facts and members, who are a subset of the organization's people.

**Platform**:
The operator level above every organization, which sets the defaults each
organization inherits unless it overrides them.

**Entwurfsverfasser** (design author):
The planner of record who signs the submission. Piloti supports this person and
never replaces them.

**Behörde** (building authority):
The authority that decides on a submission and issues the Bescheid. Piloti does
not stand in for it.

**Wert / Schätzung / noch offen** (value / estimate / still open):
The three answer modes of a project intake question. A Wert becomes a fact, a
Schätzung an unconfirmed assumption, and noch offen an open question Piloti asks
about when an answer depends on it.

**Gebäudeklasse** (building class):
The OIB classification of a building that many requirements depend on. Piloti
asks for it when an answer turns on it.

## Sources

**OIB-Richtlinie** (OIB guideline):
One of the Austrian Institute of Construction Engineering's technical
guidelines (Richtlinie 1 to 6, with 2.1 to 2.3), the binding text most answers
rest on.

**Punkt** (point):
A numbered clause of an OIB-Richtlinie, and the unit Piloti cites ("OIB 2 Pkt.
3.5.2").

**RIS** (Rechtsinformationssystem):
The Austrian federal legal information system, the source for exact pointers
into laws and ordinances.

**Source kind**:
The coarse family every source belongs to, which decides how it is shown:
*Baurecht & Richtlinien* (building law and guidelines), *Büroarchiv* (the
office's own standards, details and experience), *Projektwissen* (this project's
documents, Bescheide and uploads) and *Web*. A *Modellmessung* (a value measured off
the project's BIM model) is shown beside them but is never a source for a legal
verdict.

**Shelf**:
Where a document lives, which decides who may read it and what a search reaches:
the *Büroablage* (the organization's shelf, formerly „Archiv"; the code keeps
`archiv`), a project, a single chat, or the shared OIB base every organization
sees. The Büroablage can hold norms an office uploaded itself (ÖNORMEN,
Weisungen) that the OIB base does not carry.
_Avoid_: folder; folders organise documents within a shelf, a shelf decides who sees them.

**Dokumentart** (document type):
What a document is (an OIB-Richtlinie, a law, a standard, a Grundriss, a
Gutachten…), set by a person and always trusted over a guess from the file name.

**Fassung** (revision):
One state of a document: a later Fassung replaces an earlier one as the basis,
and the earlier one stays readable on request. Offices mark it in the file name
with an index or a date (*Stand*); Piloti reads that as a suggestion a person
confirms.
_Avoid_: Plan, Planstand, for any file. A name with an index says a file has
Fassungen, not that it is a drawing; only its Dokumentart says what it is. Say
Dokument, Datei, Fassung or Stand.

**Piloti-Dokument**:
A document Piloti wrote and a person approved and published, which then counts
as office knowledge. Its *Herkunft* (origin) names who wrote and who approved it.

**Fundstelle** (locus):
The exact place a statement is pinned to: a Punkt, a section, a page.

## An answer

**Turn**:
One question and everything Piloti does to answer it, from the first step to the
settled answer.

**Herleitung** (derivation):
The visible trace of a turn above its answer: what Piloti searched, what it
found, where it checked.

**Belegt durch** (backed by):
The row of source chips under an answer, one per document that backs its claims.

**Citation**:
A pointer from a claim to a document and a place in it. A quote that does not
match the source word for word is marked *nicht wörtlich in der Quelle belegt*
(not verbatim in the source) and lowers the answer's confidence.

**Confidence** (Sicherheit):
How far an answer can be relied on: high, medium or low. A legal answer without
verified citations cannot be high, and a model measurement alone caps it at
medium.

**Answer kind**:
The shape of an answer: *direct*, *walkthrough*, *ruling* or *handoff*. Only a
ruling has a verdict.

**Verdict** (Urteil):
The short, copyable result of a ruling, at the head of the answer.

**Takeaways** (Kernaussagen):
Two to five key points, earned only by a long answer.

**Callout** (Hinweis, Achtung, Frist, Tipp):
The one highlighted note an answer may carry: a remark, a warning, a deadline or
a tip.

**Card**:
A structured piece of an answer drawn as its own element (a table of values, a
document, a proposal to confirm) because prose cannot carry it. An *interactive
card* asks the reader for a decision that cannot be taken back.

**Repair**:
The correction of a misquoted passage after the answer has settled, in place,
without adding or removing a source.

**Follow-ups**:
Suggested next questions offered after an answer, produced after it is
delivered and never holding it up.

**Memory** and **knowledge**:
Memory is the briefing Piloti carries into every turn (what the office and the
project have told it). Knowledge is the library it searches on demand.

## Research

**Shallow research**:
The ordinary answer to a chat question, researched and cited within the turn.

**Deep research** (Tiefenrecherche):
A commissioned research run that works through many documents in the background
and delivers a report with findings, not a chat answer. Piloti proposes it, with
a reason, when a question needs it.

**Rechercheplan** (research plan):
What a deep research run will do and which documents it will read, shown for
approval before it starts.

**Grundlage / Ausgeschlossen / Rahmen** (basis / excluded / frame):
How a research plan treats documents: a Grundlage is read in full, an
Ausgeschlossen document is never used, and the Rahmen is which kinds of source
the run may draw on at all.

**Befund** (finding):
One requirement checked: *erfüllt* (met), *nicht erfüllt* (not met), *offen*
(open) or *nicht anwendbar* (not applicable), with its Fundstelle. The
*Befundmatrix* is the table of all of a report's findings.

**Abdeckung** (coverage):
Whether the sources a search found answer the question. *Abdeckung:
unzureichend* says they do not, without hiding what was found.

## Delegated work

**Aufgabe** (task):
Work handed to Piloti to carry out, such as a *Soll-Ist* check (target against
actual), an *Einreichcheck* (submission check), a document or a revision.
_Avoid_: job; a job is a recurring prompt, which is something else.

**Run** (Lauf):
One commissioned piece of long work (a deep research or an Aufgabe), which lives
as a single message in the thread that asked for it.

**Laufblock** (run block):
The element in the thread that shows a run: *angelegt* (created), *läuft*
(running), *wartet* (waiting), *fertig* (done), *fehlgeschlagen* (failed),
*abgebrochen* (cancelled) or *unterbrochen* (stopped early, with a report from
what was there).

## Sharing and keeping

**Share** (Freigabe):
Access to one resource (a project, a chat, a document) granted to a person, as
*viewer*, *collaborator* or *owner*.

**Spectator**:
Someone watching a shared turn live without taking part in it.

**Soft delete**:
Deletion that waits out a grace period, during which the item can be restored:
seven days for a project, fourteen for an organization, none for a document or a
chat.

**Legal hold**:
A hold that keeps deleted data from being purged, for as long as it is active.
