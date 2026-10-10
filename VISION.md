# Piloti: the vision

**Piloti is the workspace for architects.** A planning office runs its work in
it: every project, every process, the whole organization. Piloti, the agent, is
a colleague in that office who does part of the work.

This is the one document that says what the product is. Every README, guide,
prompt and design note describes Piloti this way. When one of them reads like a
question-answering tool about building law, it is out of date, and fixing it is
part of the change that noticed it.

## Why it exists

An architect's work is spread across a file server, a document-exchange portal,
mail, CAD, a building model, spreadsheets, and the heads of the people who did
the last project. A building law sits behind every decision, and nobody keeps
it all in view. The office's knowledge exists, in hundreds of documents and
past projects, but nobody can find it when it would help.

Piloti puts the work in one place where an agent can read everything the office
holds, and lets that agent take part in the work. The value is neither the
storage nor the chat. It is a colleague who has read the whole project and
works in it.

## Who it is for

- **The organization:** an architecture or planning office, its projects, its
  people and roles, its Büroablage, its conventions. Nothing crosses from one
  organization to another.
- **The people in it:** architects, project leads, drafters, site supervision
  (ÖBA), office management, and the specialist consultants (Fachplaner) they
  work with.
- **Every phase of a project:** from the first facts through Entwurf,
  Einreichung, Ausführung and the project's close, and what the office learns
  from it for the next one. Today Piloti is strongest from the intake to the
  Einreichung. The direction is the whole life of a project.

## What Piloti does

Piloti helps wherever an architect spends the day. Building law is one of these
places, not the frame around them.

| The architect's work | What Piloti does there today |
|---|---|
| Starting a project | The Einrichtung asks for the facts that decide the rest: Bundesland, Gebäudeklasse, Bauwerke, uses, plot. Piloti derives which OIB-Richtlinien apply, keeps a Steckbrief of the people involved, and keeps the profile current as the project establishes new facts. |
| Files and the Büroablage | Folders, uploads of whole folders and ZIPs, Office files shown and cited page by page. Piloti reads every upload and says what it is, what it found, which of its Fassungen is current, and what is missing or could not be read. Sensitive uploads are screened before any model sees them. The Büroablage holds the office's own documents, on every project. An Outlook archive can be filed mail by mail. |
| The building model | IFC models in the browser: structure, quantities (Raumbuch), revisions, 3D with sections and measuring. Piloti reads and measures their elements, and a person's confirmations are recorded in the Prüfbuch. |
| Questions about the work | About a document, a folder, a decision, the model, the law. Answers come from the project's files, the Büroablage, the legal corpus and the web, whichever the question needs, with every claim cited and the derivation visible. |
| Handing over work | Aufgaben run on their own under the requester's permissions. Zeitpläne repeat them. A Tiefenrecherche plans, researches, checks and files a report. Skills hold the office's own procedures. |
| Writing | Piloti drafts Aktenvermerke, Protokolle, Checklisten, Flächenaufstellungen and reports into the project. A person releases them (Freigabe), Piloti revises them from a reviewer's comment, and a released document counts as office knowledge. Piloti proposes moves, renames and folders, and nothing changes until someone accepts. |
| Working as a team | Shared chats, mentions, an inbox, assignments ("Verantwortlich"), live presence, custom roles and folder access per role, a download log. |
| What the office knows | Project memory, the office's standing instructions, similar closed projects, what an authority asked for before (Behörden-Gedächtnis), and the experience a closed project leaves behind. Closing a project proposes what to clear out and records what the office learned. |
| Building law and norms | The OIB-Richtlinien, Austrian law via RIS, a curated norm register, and norms an office uploads itself, cited at the passage. One capability among the others, and a deep one. |

## Where it is going

These are directions with a document behind them, not promises:

- **The office's past as knowledge.** An importer that reads an office's
  archive for facts and decisions, and Referenzblätter for tenders
  ([`docs/roadmap/office-experience.md`](docs/roadmap/office-experience.md)).
- **Reading drawings, not only text.** Measuring from 2D drawings
  ([`docs/roadmap/plan-measurement-from-drawings.md`](docs/roadmap/plan-measurement-from-drawings.md)).
- **Requirements that follow the project.** A ledger of what applies and what
  is shown, carried across model revisions
  ([`docs/roadmap/ifc-compliance-ledger.md`](docs/roadmap/ifc-compliance-ledger.md),
  [`docs/roadmap/compliance-derivation-graph.md`](docs/roadmap/compliance-derivation-graph.md)).
- **An agent that holds work.** Longer tasks with a goal, a plan, a review and
  a decision that comes back
  ([`docs/roadmap/agentic-workspace-architecture.md`](docs/roadmap/agentic-workspace-architecture.md)).

## What Piloti is not

- **Not a question-answering tool.** A question is one way to hand Piloti work.
  The unit of the product is the project, the document and the task, not the
  chat message.
- **Not a compliance assistant.** Piloti knows building law well, and it uses
  that knowledge in the work. It does not reduce the work to checking rules.
- **Not a file server with a chatbot.** Piloti reads the files, so the
  workspace knows what is in them.
- **Not the Entwurfsverfasser or the Behörde.** Piloti prepares, checks and
  suggests. People decide and sign.

## Principles

1. **Work, not answers.** Ask what the architect is trying to get done, not
   which question to answer. A feature that only makes the chat smarter is
   suspect. A feature that removes a step from the office's day is not.
2. **The office's language.** Product copy is German and uses the words of the
   trade. Never call a file a plan: nothing knows a file is a drawing until its
   Dokumentart says so. Say Dokument, Datei, Fassung, Stand (`CONTEXT.md`).
3. **Grounded and traceable.** A claim resolves to a passage a person can open.
   An action leaves a trace a person can follow. What Piloti cannot ground, it
   does not present as fact.
4. **Suggest, then confirm.** Piloti proposes. A person confirms anything that
   changes the office's record: a Dokumentart, a Fassung, a fact in the project
   profile, a document's Freigabe.
5. **The office's own knowledge first.** The project's documents, the
   Büroablage, past projects and the office's conventions come before general
   knowledge. The base corpus serves the office, never the reverse.
6. **The whole organization.** Projects, people, roles and knowledge belong to
   the organization, and what one project learns, the next one can use.
7. **AI-native, not AI-added.** The agent works on the same file system,
   folders, Fassungen and records the people do, through the same API
   (ADR-0055). Everything it does is observable (Langfuse, ADR-0089).

## How to use this document

- **Deciding a feature:** does it help an architect do their work, in the
  office's language, in the place they already work? Building law is a means
  to that, never the measure.
- **Writing a doc, a prompt or copy:** lead with the work. Mention the legal
  corpus where it is the topic, and describe it as the capability it is.
- **Disagreeing with this document:** change it in a pull request. A vision
  nobody may edit is one everybody ignores.

The engineering detail behind the agent's direction is in
[`docs/roadmap/agentic-workspace-architecture.md`](docs/roadmap/agentic-workspace-architecture.md).
The domain words are in [`CONTEXT.md`](CONTEXT.md).
