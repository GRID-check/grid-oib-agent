# Büroerfahrung: the office as Piloti's memory

> **Status:** product direction, 7 Oct 2026. It replaces
> [`cross-project-rag-vision.md`](cross-project-rag-vision.md) (July 2026). That
> document named the goal, but it had no access model, no data, and a readiness
> gate nobody owned. The first layer is built: ADR-0093 and
> [`../design/cross-project-escalation.md`](../design/cross-project-escalation.md).

## The thesis

**Piloti's unit of value is the office, not the project.**

A planning office's competitive substance is how it builds. That knowledge
lives in:
- Bescheide and their Auflagen
- Gutachten
- details that worked and details the Behörde sent back
- the reasoning behind the deviations
- the people who remember why

Today that knowledge sits in file servers and in heads. It leaves with every
Projektleiter who retires and is rediscovered on every new project.

Every competitor can load the OIB-Richtlinien. No competitor can load this
office's last fifteen years. So:

* **This is what nobody else does.** The norm corpus is a commodity. Almost
  every AEC vendor's AI stays inside one project: Autodesk Assistant, Procore,
  PlanRadar, Thinkproject. Allplan's assistant is pitched on never touching the
  office's data. The exceptions are Nomic, which searches US drawings across a
  firm, and ERP proposal tools. Nobody covers permitting knowledge.
* **This is the retention, not a network effect.** Be precise about the claim.
  One office's corpus makes Piloti expensive to leave: after two years it knows
  things no other tool does. It does not make Piloti better for other offices
  (a16z, "The Empty Promise of Data Moats"). The defensible part is the depth
  of workflow built on that corpus: Einreichung, Nachforderung, Wettbewerb. The
  only plausible pooled effect is an **opt-in, anonymised Verfahrensdauer
  benchmark per Behörde** across offices: counts and durations, never content.
* **This is the onboarding wedge.** Under "bring your last ten years", the
  first day already answers questions nothing else can.

Measured that way, cross-project search is not a feature among others. It is
the reason the rest compounds.

## The evidence

* **Permitting is where the time goes.** The ZT-Kammer W/NÖ/B member survey
  (2023, n=632) found:
  - the average Baubewilligung takes **9.3 months in Vienna**, 5.0 in NÖ and
    4.5 in Burgenland;
  - only 33% of Vienna procedures met the six-month deadline (29% by 2025);
  - more than 60% of planners report delays from purely formal
    Bauphysik defects;
  - only 16–18% never had to supplement architecture or fire-safety documents.

  Every Nachforderung an office has received is a lesson it can stop
  repeating. CivCheck-style pre-submission checks cut corrections from 23.5 to
  7.7 and permitting time from 73 to 32.5 days.
* **Searching is where the rest goes.** Construction professionals spend about
  5.5 h a week looking for project data (PlanGrid/FMI 2018). Engineers spend
  20–30% of their day searching (IHS).
* **Offices try and fail.** Staab Architekten curates every detail after a
  project ("hat es sich bewährt?"), with Detailpaten and a database holding
  Bausumme and Bauzeit. Volker Staab's own verdict: „Die Köpfe der Mitarbeiter
  bilden unser großes Archiv". He also warns: „Ein Detail in der Datenbank zeigt
  noch lange nicht, warum es genau so aussieht". GKS Architekten's internal
  survey on knowledge transfer was „ernüchternd". Only 4% of UK practices
  always do post-occupancy evaluation. The method is known; it is too expensive
  to do by hand.
* **Reference projects are mandatory paperwork.** Under BVergG §85 a client may
  require references from a defined period, and missing ones exclude the bid.
  DACH offices assemble them by hand; Deltek automates them in the US.

Sources: `docs/design/cross-project-escalation.md` (agent patterns) and the
research notes behind this document. Bauwelt 1.2025 (Staab), the derPlan 58
survey PDF (ZT-Kammer), and FHNW (GKS).

## What exists after ADR-0093, and what it is worth

| Layer | State | What it gives |
|---|---|---|
| **Access model** | built | Every lookup runs as the conversation's audience. A record of what each chat drew on is judged when it is read, and a closed project restricts nobody. This is the hard part, and the part every later layer stands on. |
| **Retrieval across projects** | built | Search, find and brief across what the audience may open, bounded and paged, with every source attributed to its project. |
| **Proactive use** | built | Each turn gets a catalog of the 12 closed projects most like this one, plus the rule to look without being asked. |
| **Similarity** | built, but **starved** | It ranks by Bundesland, Gebäudeklasse, Bauweise, use and kind of work. `gebaeudeklasse` has no writer at all. The other facts come only from the intake wizard, which an archived project never went through. |
| **Data** | **missing** | No importer for past projects; no facts extracted from documents; nothing happens when a project closes; no Behörde, duration or cost data. |
| **Knowledge objects** | **missing** | The unit of retrieval is a 900-character passage. What a planner wants is a decision: *what was asked, under which conditions, what was done, did the Behörde accept it.* |
| **Surfaces beyond chat** | **missing** | Experience appears only when someone asks. |

The safe pipe exists. What flows through it is thin, and it is thinnest exactly
where the value is: in old projects nobody fed into Piloti.

## What it could give: six capabilities

Each capability is something an office pays for. Each names the data it
needs, which is the honest measure of how far away it is.

### 1. „Wie haben wir das gelöst?": precedent in every answer

*Built for chat.* The next step is to make precedent a first-class part of
the answer, not a passage among others:
- the answer separates **Norm** (what applies), **Büro** (how we usually do it)
  and **Präzedenz** (where we did it, and how it went);
- every precedent carries the **OIB edition and Bundesland it was decided
  under**, and is flagged when the rule changed since. Example: „Projekt Graz
  2019 löste das mit OIB-RL 2:2015; die Ausgabe 2023 verlangt …". The norm
  registry already parses editions.

*Needs:* the project's OIB edition and Bundesland as facts; decision objects
(capability 3).

### 2. Projektstart mit Erfahrung

When a project is created, its fingerprint (Bundesland, Gemeinde,
Gebäudeklasse, Bauweise, use, kind of work) is known from intake. At that
moment Piloti shows:
- the most similar past projects;
- what the Behörde demanded there;
- which Gutachten were needed;
- how long Einreichung to Bescheid took;
- what went wrong.

That last item is the Einreichcheck's checklist pre-filled with the office's
own failures, not only with the norm.

*Needs:* fingerprints of past projects; Auflagen extracted from Bescheide;
the Steckbrief period; the closing debrief (capability 6).

### 3. Entscheidungen: the decision as the unit of experience

A decision record holds:
- the question;
- the context: fingerprint, norm and edition, Behörde;
- the solution and its reasoning;
- the evidence: documents and pages;
- the outcome: accepted, Auflage, rejected.

Most of the raw material already exists:
- `project_memory` items of kind `decision`;
- accepted and rejected card proposals;
- reviewers' requested changes;
- Bescheide (an ingestion tag) and Gutachten.

Decisions are retrieved before passages. They are short and comparable, and
they answer the question a planner actually asks.

*Needs:*
- capture: harvest at close (capability 6), extract from Bescheide, promote
  memory decisions;
- one schema;
- the same access label as their project, so a decision of a closed project
  is office-readable like its documents.

### 4. Behörde und Gemeinde: permitting memory, the strongest case

Across an office's projects, the same Baubehörden recur. From Bescheide,
correspondence and the Steckbrief period, Piloti can learn:
- which Auflagen each authority typically sets;
- what it asks for in a Vorprüfung;
- how long it takes.

Example: „In 6 von 8 Projekten in Mödling wurde ein Brandschutzkonzept
nachgefordert."

No national product can know this. It exists only in the office's files.

*Needs:* the Gemeinde resolved from `standort_adresse`. That is a lookup to
buy, not build: the Austrian Gemeindekennziffer via an address register.
Also needed: Bescheid dates and Auflagen extracted; enough projects per
authority to be honest about the numbers.

### 5. Referenzblätter: experience as a bid document

For a Wettbewerb or a tender, the office needs reference sheets: comparable
projects from a period, with values, role, period and client confirmation.
Piloti already holds the period and the people (the Steckbrief). With the
fingerprint and the Bausumme it can draft the sheets for the projects most like
the tender's, as a document the office checks and files.

*Needs:* Bausumme and BGF as fields (ÖNORM B 1801-1), the fingerprint, and the
Steckbrief. People reach the document through its form fields, never through
the model's context (ADR-0090).

### 6. Erfahrung wird Standard: the compounding loop

Experience that repeats should become office standard:
- a detail solved the same way in five projects;
- an Auflage met the same way every time;
- a Gutachter who is always used.

Piloti proposes promotion. A person confirms it, and the standard moves to
the Büro shelf and organization memory, both of which already exist. From
then on it is answered as „so machen wir das", not as one precedent among
several.

The opposite also matters. When projects contradict each other, or a
standard is contradicted by a newer Bescheid, Piloti says so.

The loop is closed by **the closing debrief**. When a project is closed
(ticket 1's close action), Piloti drafts:
- the Steckbrief's missing facts;
- the decisions worth keeping;
- what went wrong;
- the Auflagen and their outcome.

The Projektleiter confirms in ten minutes what would otherwise be lost. This
is the Projektabschlussgespräch offices intend and skip, made cheap.

*Needs:* the debrief at close. Closing currently blocks memory writes (trigger
GPC01), so the debrief writes before the status flips. Also needed: a
promotion card, and the decision schema.

## The data problem is the product problem

Every capability above is bounded by the data. Data for past projects is
missing today, and that is where the value is. So the first investment is not
in smarter retrieval but in **turning an office's archive into experience**:

1. **Archiv-Import, or connecting the archive.**
   - **What it does:** an office points Piloti at its project archive, one
     folder per project.
   - **What each folder becomes:** a closed project with its documents
     ingested and tagged (the classifier exists).
   - **How it runs:** upload batches already exist; past projects are
     "uploaded in bulk".
   - **The first day:** this is what an office does in its first week.
   - **Migrate or connect?** Offices keep archives on a NAS, SharePoint or a
     CDE, and research is blunt that migrating archives is a non-starter at
     scale. A connector that indexes in place is the stronger product. It is
     also an ADR-sized decision (storage, sync, deletion), and it should be
     bought where possible.
2. **Fingerprint extraction.**
   - **What it does:** from each project's documents (Einreichplan,
     Baubeschreibung, Bescheid, Energieausweis), Piloti extracts the
     fingerprint facts as *agent-suggested* values. The profile already
     distinguishes `assumptions` (agent_suggested) from confirmed `facts`.
   - **Who confirms:** a person, in one table for all imported projects.
   - **Also new:** `gebaeudeklasse` gets its first writer.
   - **Why first:** it is the precondition for similarity being more than
     recency.
3. **Erfahrungsdichte, as a number the office sees.**
   - **What it counts:** how many closed projects have a full fingerprint, a
     period, decisions, and Bescheide with extracted Auflagen.
   - **Why it matters:** it tells the office what to feed in, and it tells us
     whether the flywheel turns.

## Principles that hold across every layer

* **Precedent is never compliance.** A past solution is evidence that something
  was accepted under some edition by some Behörde. The answer always shows
  under which. The norm stays the authority.
* **One access model.** Every new object (decision, Auflage, fingerprint,
  standard) carries its project's readers. A closed project's are the office.
  A restricted folder's stay restricted. ADR-0093's label rule applies
  unchanged; no layer gets its own.
* **Confirmed beats suggested, and the difference is visible.** Extracted facts
  and drafted decisions are suggestions until a person confirms them, and
  similarity weighs confirmed facts more.
* **Never across offices.** The office's experience is its own. Platform
  lessons stay anonymized agent-behaviour lessons, never building knowledge.
* **People stay out of the prompt** (ADR-0090). "Who solved this" is a UI link
  to the Steckbrief, never model context.
* **Measure the cause.** Similarity weights are learned from which references
  readers open and cite, not tuned by feel.

## Sequence

| Step | Delivers | Unblocks |
|---|---|---|
| **0 (done)** | Access model, lookup, catalog, similarity | — |
| **1 Archiv-Import + fingerprint extraction** | Fifteen years of projects as closed, searchable, ranked projects; `gebaeudeklasse` gets a writer; Erfahrungsdichte | Every later step has data |
| **2 Permitting memory** | Bescheide and Nachforderungen: dates, Auflagen, demanded Gutachten extracted per project; Gemeinde resolved; the Einreichcheck seeded with the office's own Nachforderungen | The strongest, uncontested case: fewer Nachforderungen, months saved |
| **3 Closing debrief** | Every project that closes leaves a confirmed fingerprint, decisions, lessons and the why | Decisions accumulate without extra work |
| **4 Entscheidungen** | A decision schema; harvested from memory, cards, reviews and Bescheide; retrieved before passages; answers split into Norm / Büro / Präzedenz with edition drift | „Wie haben wir das gelöst" answered with outcomes |
| **5 Projektstart mit Erfahrung** | Similar projects, typical Auflagen, Gutachten and durations at project creation | Experience reaches people who did not ask |
| **6 Referenzblätter** | Bid reference sheets drafted from fingerprint, Bausumme and Steckbrief | A direct, billable output |
| **7 Erfahrung wird Standard** | Promotion proposals, contradiction warnings, learned similarity; opt-in anonymised Verfahrensdauer benchmark | The loop compounds |

Steps 1 to 3 are not glamorous, and they decide whether any of this works.
Step 2 is also the one to show an office first. It is the clearest saving in
months and euros, and its value is not a promise about the future.

## How to price and position it

* **Positioning.** The office's own asset, never used to train anything, never
  shared. „Ihr Büro vergisst nichts mehr."
* **Price on outcomes, not seats.** Price on the hours of searching saved and
  on the Nachforderungen avoided per Einreichung. Glean-style 100-seat minimums
  do not fit offices of 5 to 30 people.

## Open for the product owner

1. **Opt-out per project.** Since ticket 1, a closed project is open to the
   whole office. Some client contracts may forbid internal reuse. Does a
   project need a „nicht als Referenz" switch, or are restricted folders
   enough?
2. **Archive import as the onboarding offer.** Is it a self-service upload or
   an onboarding service we run with the office? The second one teaches us
   the data faster.
3. **Who confirms the debrief.** Is it the Projektleiter, or whoever closes?
   Closing needs `project:manage`.
4. **Numbers about authorities.** Counts like „6 von 8" invite
   over-reading. What is the minimum sample before Piloti states a pattern?
