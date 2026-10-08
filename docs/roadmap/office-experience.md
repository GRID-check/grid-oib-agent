# Büroerfahrung: the office as Piloti's memory

> **Status:** product direction, 7 Oct 2026. It replaces
> [`cross-project-rag-vision.md`](cross-project-rag-vision.md) (July 2026). That
> document named the goal, but it had no access model, no data, and a readiness
> gate nobody owned. The first layer is built: ADR-0085 and
> [`../design/cross-project-escalation.md`](../design/cross-project-escalation.md).

## The pure intent

> **Ein Büro soll nichts zweimal lernen müssen.**
> An office should never have to learn the same thing twice.

Every capability below is a way of keeping that promise, and every one is
judged by it. Did the planner get, at the moment of deciding, what the office
already knew, with where it came from and whether it still holds? If yes, it
works. If they had to remember, ask a colleague or dig in the NAS, it does not.

## What it gives the user, and how well we give it today

The honest scorecard on 8 Oct 2026. "Built" is not "delivered": a feature
that never meets data delivers nothing.

| The planner's moment | What they should get | Today | Why |
|---|---|---|---|
| „Wie haben wir das gelöst?" | The comparable projects' solutions, cited, as precedent | **Built, barely delivered** | Search, catalog and access work; the turn decision prefetches the reference projects when a precedent is likely; other projects' recorded decisions come first, found by meaning in any language. The ranking reads every building of a project as the wizard stores it (until 8 Oct it read only Bundesland and kind of work). But the catalog lists only CLOSED projects that live in Piloti, and closing only arrived with ticket 1. The Gebäudeklasse is left open in the wizard on purpose (a wrong class is a wrong requirement); only an agent proposal a person accepts writes it. In a real office today the catalog is empty or thin |
| „Fragt die Behörde das wieder nach?" | The office's past Nachforderungen and Auflagen for this Behörde | **Built, not delivered** | A document a person or the classifier tagged „Bescheid" is read once at ingest into a permit record: the Behörde, the Gemeinde from the letterhead, the date, each Auflage or Nachforderung with its evidence (ADR-0086). The record carries the document's folder restriction and is found by meaning in the cross-project lookup. In the eval every permit question cites the right project in every run; one English run left a dimension out. It delivers only what lies in Piloti and is tagged: `scripts/backfill_permit_records.py` reads Bescheide already ingested, and an archive is slice E. The Gemeinde is read off the letterhead, not matched to a register |
| Starting a project | Similar projects, typical Auflagen, Gutachten, durations | **Not built** | Depends on the two rows above |
| A tender | Reference sheets | **Not built** | No Bausumme or BGF fields |
| A colleague leaves | Their projects' lessons stay | **Built, not drafted** | The close dialog carries the closing debrief: the fingerprint with its open facts named, the project's decisions to confirm, a lesson to record. Confirmed ones are cited elsewhere as a person's. Piloti does not yet DRAFT the debrief (what went wrong, the Auflagen and their outcome); a person reviews what the memory already holds |
| Trusting the answer | Every precedent with project, year, edition; never confused with the norm | **Mostly** | Project, status and Bundesland are on every source, and a precedent from another Land is marked by the tool as decided under another Bauordnung. The prompt says „Präzedenzfall, nicht Norm". The edition a precedent was decided under is not known, so edition drift is said only when the answer can see a date |
| Nothing leaks | A colleague never sees what they may not read | **Delivered** | Audience search, record at hand-out, read-time judges; 24 access rules each with a test that fails without it |
| Knowing it works | A measured answer quality for precedent questions | **Built** | `suite.py --set precedent`: 32 questions, 16 held out, in three offices (the default house with 24 other projects and 74 documents, a Vienna office conversion, an office with no past project). The fixture ranks with the production embedder and no relevance floor; meanings go to a judge, and a judge that cannot answer is a failure; `cites` ignores a name the question already holds; `real_projects` catches an invented project in the sources. **Baseline 8 Oct (8c6e706), 64 runs:** cites 46/46, no invented project 64/64, said „nichts Vergleichbares" 12/12, looked when it should 48/48, edition caveat 5/6, stayed out on norm questions 6/8 (one definition question sits on the prefetch threshold), answer envelope 60/64 (2/54 before), no unwanted project 88/92: all four misses are one correct answer („keine Nachforderung der BH Kufstein", Mödling named as the contrast) that a word check misreads, left as is because the question is held out. Held-out scored as the tuned questions; the judge answered all 18. **Not comparable with earlier figures:** the 7 Oct baseline (cites 18/24, 2 of 30 answers replaced by a canned error) and an earlier 8 Oct run (cites 38/38, 9/9) had fewer questions, an office of 8 projects, a cites check 10 of 23 groups passed by repeating the question, and left a judge's non-answer out of the count. The held-out `wien-uebernahme` check was moved from a word list to the judge after the run that first scored it (69bae5e) |

**The gap in one sentence.** The pipe is safe and the agent knows to use
it, but almost nothing flows through it yet, and we have no instrument that
would tell us if something did.

That reorders the next work. Before any new capability:

1. **An eval for precedent questions** (done, 7 Oct). A fixture office, with
   16 questions with expected projects and expected silences, run in the
   answer suite before and after every change to this feature.
2. **The data**: archive import, the sieve and fingerprint extraction (step 1
   below).

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

## What exists after ADR-0085, and what it is worth

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
the model's context (ADR-0083).

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

*Built (7 Oct):* the debrief at close, in the close dialog
(`closing-debrief.tsx`). Closing blocks memory writes (trigger GPC01), so it
writes before the status flips: confirming a decision, recording a lesson. The
fingerprint it shows is the one the ranking reads (`lib/cross-project/fingerprint.ts`),
so what it asks for is exactly what makes the project findable. It asks; it
never blocks the close.

*Still needed:* the draft. Piloti proposing the missing facts, what went wrong,
and the Auflagen with their outcome, from the project's own Bescheide, needs
the sieve and the pen of step 2. Also a promotion card, and the decision
schema.

## Augmentation: three levels, not one search box

"Cross-project search" undersells it. Piloti augments three things, and
each one feeds the next.

### Augment the archive: enrich it once, backwards, cheaply

An office's archive is fifteen years of PDFs nobody has read twice. It
contains everything above: Bescheide with Auflagen, Nachforderungen, Gutachten
verdicts, details that were built. Augmenting it means annotating every
document and page with what it IS and what it SAYS, as structured records that
retrieval, statistics and surfaces can use. The annotation runs as a cascade,
and each stage is paid only for what the stage before it let through:

| Stage | Who | Asks | Cost shape |
|---|---|---|---|
| **Sieve** | Jev, one call per page | Is this a Bescheid? Does it set an Auflage? Is it a Nachforderung, a Gutachten's verdict, a construction detail? Which document role (`document_roles` has 13 and no writer today)? Which Bundesland, Bauweise, use? | Cents per project: $0.042 per million input tokens, so 100,000 pages at ~1,000 tokens cost about $4 |
| **Pen** | A generative model, only on what the sieve flagged at 0.8 or above | Extract the Auflage's text, the demanded Gutachten, the dates, the decision and its reasoning, the Gebäudeklasse from the Einreichplan's heights and floors | The expensive call runs on a few percent of pages |
| **Judge** | A person, in one table per project or in the closing debrief | Confirm, correct, reject | Minutes per project. Confirmed beats suggested everywhere downstream |

The annotations are versioned: model, threshold and date per record. A better
model re-runs the sieve over the archive overnight, and a person's
confirmation is never overwritten. This is what makes "bring your last ten
years" a first-week offer rather than a consulting project.

### Augment the work: experience at every step, not only when asked

Chat is one surface. The same experience belongs wherever a planner decides:

* **Drafting** an Einreichung or a Baubeschreibung: „Mödling verlangte 2022 und
  2024 an dieser Stelle einen Nachweis der Fluchtwegbreite."
* **The Einreichcheck**: the norm's checklist, plus this office's own
  Nachforderungen for comparable projects at this Behörde.
* **Reviewing a plan or an IFC model**: a detail that was rejected before is
  flagged where it appears again.
* **Project start, tenders, the closing**: capabilities 2, 5 and 6 above.

Every one of these surfaces only ADDS. A precedent never hides a norm, never
blocks a step, and always names its project, year and edition.

### Augment the people: the office's heads, written down

* **The closing debrief** turns the Projektabschlussgespräch into ten minutes of
  confirming what Piloti drafted, including the why that Staab says a detail
  database lacks.
* **A new colleague** asks „Wie macht unser Büro das?" and gets the office's
  answer with its projects, not the internet's.
* **Who knows** stays a link to the Steckbrief, never model context
  (ADR-0083). The office can see who solved what. The model cannot use it to
  profile people.

## Where Jev fits

Jev (TypeSafe's decision model, ADR-0064) answers typed questions about a
state: yes/no, a choice of up to 255, a level on a rubric. It answers in under
a second, with a probability, for almost nothing. That is the exact shape of
most of the augmentation work, which is why it matters more here than anywhere
else in Piloti. Its documented limits decide what it may NOT do.

| Use | Jev's question | Rule it obeys |
|---|---|---|
| **The archive sieve** (above) | Per page: Bescheid? Auflage? Nachforderung? Gutachten verdict? Detail? Document role? | Labels only, acted on at 0.8 or above, like ingestion tags (ADR-0064 use 4). The pen and the person decide content |
| **Closed vocabularies of a project** | Choice: Bundesland, Bauweise, use, kind of work, a Bescheid's outcome (bewilligt / mit Auflagen / abgewiesen) | Writes *suggested* facts, never confirmed ones |
| **The turn decision** | Add `referenz` to the corpus choice of ADR-0064 use 1, plus a noul: "has a comparable project likely faced this decision?" | Only ADDS a round-0 prefetch of the similar projects' search beside the project's own. The tool stays bound whatever it says |
| **Precedent verdicts** | Per hit: "does this passage show how a comparable decision was solved?" | The same sufficiency judge as use 2, over reference hits. It decides whether to page on, never what the reader may see |
| **Fit of a reference to a question** | Rank by fingerprint, then one "fits this question" noul per candidate (TypeSafe's own rank-then-verify cookbook) | Reorders the catalog and the `similar` scope; drops nothing |
| **The compounding loop** | Are these two decisions the same solution? Does this Bescheid contradict that office standard? | Proposes a promotion or flags a conflict for a person; never promotes itself |

What Jev must never do here:
* **Decide access.** The BFF does, by the audience rule.
* **Count, compute durations or compare dates.** It cannot. Approval
  durations, „6 von 8" and edition drift are code over extracted fields.
* **Derive a Gebäudeklasse.** That needs heights and floors: the pen's job, or
  arithmetic.
* **Withhold.** A wrong verdict may cost a fetch, never a source.

Three risks need a mitigation before it reads archives:
* **German.** The vendor warns of lower accuracy outside English. Each sieve
  question is measured on a golden set of real Austrian Bescheide and plans
  before its threshold is set.
* **Hostile text in the state.** An archive page is untrusted input. Its labels
  steer nothing but more reading, and the injection noul of use 2 runs on it
  too.
* **ZDR offices and the alpha endpoint.** Where Jev cannot be used, the same
  questions run on a small generative model at a higher cost. The pipeline
  does not depend on Jev, it is only cheaper with it.

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
  A restricted folder's stay restricted. ADR-0085's label rule applies
  unchanged; no layer gets its own.
* **Confirmed beats suggested, and the difference is visible.** Extracted facts
  and drafted decisions are suggestions until a person confirms them, and
  similarity weighs confirmed facts more.
* **Never across offices.** The office's experience is its own. Platform
  lessons stay anonymized agent-behaviour lessons, never building knowledge.
* **People stay out of the prompt** (ADR-0083). "Who solved this" is a UI link
  to the Steckbrief, never model context.
* **Measure the cause.** Similarity weights are learned from which references
  readers open and cite, not tuned by feel.

## Sequence

| Step | Delivers | Unblocks |
|---|---|---|
| **0 (done)** | Access model, lookup, catalog, similarity | — |
| **1 Archiv-Import + the sieve** | Fifteen years of projects as closed, searchable, ranked projects. Every page annotated by the Jev sieve; fingerprints extracted by the pen and confirmed; `gebaeudeklasse` and `document_roles` get writers; Erfahrungsdichte. First: a German golden set for the sieve | Every later step has data |
| **2 Permitting memory** | Bescheide and Nachforderungen: dates, Auflagen, demanded Gutachten extracted per project (sieve, then pen); Gemeinde resolved; the Einreichcheck seeded with the office's own Nachforderungen; the turn decision gains `referenz` | The strongest, uncontested case: fewer Nachforderungen, months saved |
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

## Horizons

| Horizon | What Piloti is to the office |
|---|---|
| **Now (Oct 2026)** | A careful researcher that can look into past projects safely, if they are in Piloti |
| **Next (3–6 months)** | The office's archive, read and annotated. Precedent and permitting memory in answers and in the Einreichcheck. A closing debrief that captures the why |
| **Later (6–18 months)** | The colleague who has worked on every project: at project start, in drafting, in plan and model review, in tenders. Office standards emerge from repeated solutions, and contradictions surface |
| **Future** | Permitting becomes a data exchange. Vienna's BIM-based permit work (BRISE-Vienna) and the Länder's digital Einreichung point to authorities answering in structured form. An office whose Nachforderungen are already structured data learns from every procedure automatically. An opt-in, anonymised Verfahrensdauer benchmark per Behörde across offices becomes possible. It is the only pooled signal, and never content |

The direction holds across all four horizons. Piloti moves from answering
when asked, to being present when deciding, to closing the loop with the
authority. The access model and the "only add" rule stay unchanged.

## Open for the product owner

1. **Opt-out per project.** Since ticket 1, a closed project is open to the
   whole office. Some client contracts may forbid internal reuse. Does a
   project need a „nicht als Referenz" switch, or are restricted folders
   enough?
2. **Archive import as the onboarding offer.** Is it a self-service upload or
   an onboarding service we run with the office? The second one teaches us
   the data faster.
3. **Who confirms the debrief.** Is it the Projektleiter, or whoever closes?
   Built for whoever closes (`project:manage`), with confirming and recording
   asking `project:memory:write`, which every project admin and editor holds.
   A Projektleiter-only confirmation would need a role the office assigns.
4. **Numbers about authorities.** Counts like „6 von 8" invite
   over-reading. What is the minimum sample before Piloti states a pattern?
