# The public site: who it is for, what it ranks for, what it still lacks

How piloti.at is meant to convert and be found. Written after an outside
teardown (September 2026) rated the site 7.2/10: strong on positioning and
trust, weak on proof, on the call to action and on search. This file keeps the
plan and the gaps in one place, so the next change starts from them instead of
from a blank page.

## Who reads the site, and what each needs to see

| Reader | Arrives with | Needs to leave with | Where the site answers |
|---|---|---|---|
| Office principal (buyer) | "Is this worth my team's time, and is it safe?" | Less submission risk, knowledge that does not leave with people, a clear data answer | `/warum-piloti/` (audiences, what Piloti is not), FAQ |
| Project lead (champion) | A real question on a real project | Proof that the answer is checkable and project-aware, and that work can be handed over | Homepage decision chain, then the week of work (`Arbeit.astro`, on the homepage and atop `/warum-piloti/`), the CTA |
| Planner (user) | A search: "Gebäudeklasse …", "ChatGPT Baurecht" | A useful article, then a reason to try | Journal articles, each ending in a real-question invite |
| Data or IT decider (gatekeeper) | "Where do our drawings go?" | The providers, named, and no training | Quellen section, FAQ, privacy policy |
| Buyer comparing tools | "Reiner AI Alternative", "Rainer AI" | An honest side-by-side they can trust | `/piloti-vs-reiner-ai/` |

## The turn the page has to make

The first version read as a better reference book: sources, citations, what
Piloti draws on. The founders' verdict was that it lacked the moment a reader
thinks "this does my work". That moment is the handover: one sentence starts
a submission check, and a report, open points, an approval and a weekly
recheck follow. The homepage shows one answer (Nutzung), then a week of work
(Arbeit). Keep that order: an answer earns trust, and handing over work is
what a reference book cannot do.

## The conversion path

One action: **send a real planning question from a current project.** Not
"become a pilot office", which reads as a sales process. The mail is prefilled
with the question, the state, the building type and the team size
(`ui.ts` `cta.bodyPilot`). Every page ends in the same action (`EndInvite`).
Being a pilot office is what follows a good answer, and the copy says so.

## Keyword map

One page per query cluster. A new article takes a cluster nobody owns yet.

| Cluster (German first) | Page |
|---|---|
| KI für Architekten Österreich, KI Architekturbüro, KI Planungsbüro | `/warum-piloti/`, `/blog/ki-im-architekturbuero/` |
| ChatGPT Baurecht, ChatGPT Architekten, KI Baurecht Österreich | `/blog/chatgpt-baurecht/`, the FAQ entry |
| Reiner AI, Rainer AI, Reiner AI Alternative, Reiner AI Österreich | `/piloti-vs-reiner-ai/` |
| Wissensmanagement Architekturbüro, Projektwissen, Büroarchiv | `/blog/wissen-aus-alten-projekten/` |
| How Piloti works, RAG for building law | `/blog/wie-piloti-funktioniert/` |

Next clusters, in order of intent: planning questions offices type verbatim,
such as Gebäudeklasse bestimmen, Brandschutz WDVS Gebäudeklasse 4, Stellplatzpflicht
Wien, and Einreichunterlagen by state. Write each as the answer first, the
limits second, and "ask Piloti about your project" last. A post that states a
regulatory value names its source and the edition, and is checked by someone in
the office before it is published.

## Rules the copy keeps

- A competitor is described only as its own site describes it, with the month
  it was read. Where it is ahead, the page says so first. A buyer reads both
  sites side by side, and a shaded comparison loses them.
- No number that was not measured. The ≈ 30 s answer time is measured; the
  changelog count on the homepage is counted at build time
  (`shippedTotals()` in `src/lib/changelog.ts`). Everything else waits for the pilots.
- `scripts/lint-claims.mjs` holds the retracted phrases, and
  `scripts/lint-typography.mjs` now reads every file in `src/i18n/`.

## What the site still lacks, and who can close it

None of these can be written into the code. Each needs a person or a decision.

| Gap | Why it matters | What closes it |
|---|---|---|
| Measured pilot evidence | The teardown's biggest criticism: the site proves the product is built, not that it pays | Record per pilot: questions asked, research time before and after, answers used without correction. Publish once real |
| One anonymised case study | Worth more than any section of copy | One pilot office's permission for question → documents → answer → outcome |
| A Piloti mailbox | `mail@jonathanuhlemann.de` reads as a side project | Create `pilot@piloti.at`, then change `CONTACT_EMAILS` in `src/consts.ts` |
| The real product on the homepage | The chat mock is labelled fictional, and a buyer wants the interface | Screenshots from a demo organisation with non-confidential documents |
| The value calculator | Amortisation and value-per-euro read as claims, despite the disclaimer | Reframe to "what searching costs your office" until pilot data replaces the assumptions |
| An EU-only processing option | US routing will stop some deals, and Reiner AI offers German servers | A product and provider decision, then the copy |
| Search visibility | The site has no analytics by design (no cookies, no tracking) | Verify piloti.at in Google Search Console and submit `/sitemap-index.xml`: server-side, no cookie, and it shows which queries find which page. Ask the chamber, trade press and nextroom-style directories for links |
