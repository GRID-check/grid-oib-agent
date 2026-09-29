# SEO and GEO audit of piloti.at, September 2026

What we found when we audited piloti.at for search (Google, Bing) and for
answer engines (ChatGPT search, Perplexity, Google AI Overviews, Claude),
what this branch changed, and what is left. The audience, conversion path
and keyword map live in
[`website-conversion-and-seo.md`](website-conversion-and-seo.md).

**Method.** We crawled the production build (`dist/client`) for every page's
title and description length, h1 count, word count, canonical, hreflang,
JSON-LD types, image alt text, internal links, orphans and broken links.
We read `robots.txt`, the sitemap, `llms.txt` and the head markup. We mapped
about 30 search results pages for Austrian planning queries and checked
competitors against their own sites.

What the method could not do:
- The search runs are not from google.at with an Austrian locale, and there
  is no rank tracker.
- Search volumes are unknown: there is no keyword tool, and piloti.at has no
  Search Console yet.

Rankings below are approximate top-ten positions. Difficulty is a judgement,
not a measurement.

## Verdict

The technical base was already better than most start-up sites, and it was
not the problem:
- The pages are prerendered and fast.
- Canonical, hreflang and a JSON-LD graph are on every page.
- The FAQ carries FAQPage markup.
- `llms.txt` and `llms-full.txt` exist.
- The AI crawlers are explicitly allowed.

The problem was **content surface**. There were ten indexable pages, and
none of them targeted a query that an Austrian planner types. A new domain
does not rank for "KI für Architekten" in its first year. It ranks for the
long tail nobody serves well yet:
- comparison pages ("Reiner AI Alternative")
- the edition question per state ("Welche OIB-Richtlinie gilt in Tirol")
- HTML explanations of facts that today exist only in PDFs (Gebäudeklasse,
  Fluchtniveau)

This branch builds that surface.

## Findings and what was done

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | Content | Ten indexable pages, none aimed at a searched query | Critical | **Fixed**: 5 sections, 44 search pages × 2 languages (see below) |
| 2 | Content | No comparison pages, though "X Alternative" searches show only the vendors' own pages | High | **Fixed**: `/vergleich/`, 10 comparisons |
| 3 | Content | No page per federal state, although building law is state law and search engines hedge on which OIB edition applies where | High | **Fixed**: `/baurecht/<land>/` for all nine states, with the OIB in-force status and date |
| 4 | Content | Definitions that answer engines quote (Gebäudeklasse, Fluchtniveau) exist mostly as PDFs | High | **Fixed**: `/glossar/`, verbatim from the OIB Begriffsbestimmungen 2023, with DefinedTerm markup |
| 5 | Schema | No entity saying what Piloti *is* | Medium | **Fixed**: `SoftwareApplication` node in the site graph; search pages are `WebPage` with `dateModified`, `BreadcrumbList`, `FAQPage` and, in the glossary, `DefinedTerm`; hubs are `CollectionPage` |
| 6 | GEO | `llms.txt` listed only the pages and the blog | Medium | **Fixed**: every search page is listed with its one-sentence answer, and `llms-full.txt` carries each one in full as Markdown |
| 7 | GEO | Pages opened with a lede, not a liftable conclusion | Medium | **Fixed**: every search page opens with a one-sentence answer ("Kurz gesagt"), used as the WebPage description in JSON-LD |
| 8 | On-page | Three new Journal posts had titles of 73–84 characters and descriptions of 166–194 characters, truncated in results | Medium | **Fixed**: titles under 55, descriptions under 155 |
| 9 | Internal links | New pages were reachable only from the footer | Medium | **Fixed**: "Vergleiche" in the main nav; five hubs in the footer; a "Weiterlesen, nach Frage" row on the homepage; every search page links 2–5 related pages; each hub links the other hubs |
| 10 | Trust / E-E-A-T | Competitor claims could age into false statements | Medium | Every comparison states the month its facts were read ("Stand") and invites corrections; the typography and claims lints now read the search-page data too |
| 11 | Images | Images without alt text | None | All flagged images carry `alt=""`: they are decorative and correctly empty |
| 12 | Technical | Broken internal links and orphan pages | None | None found. The only orphan is the unlisted image page, by design |
| 13 | Robots | AI crawlers blocked? | None | GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended and others are explicitly allowed |
| 14 | Exposure | **An English query ("AI Austrian building code OIB guidelines architects tool") returns github.com/GRID-check/grid-oib-agent first.** The repository describes the product | High | **Open, needs a decision.** If the repository is meant to be public, link it to piloti.at. If not, make it private: it also exposes the code |
| 15 | Measurement | No Search Console, no Bing Webmaster Tools, no analytics | High | **Open, needs you** (see Measurement) |
| 16 | Off-page | No inbound links apart from direct ones | High | **Open, needs you** (see Links) |

## What the new surface targets

| Section | Pages | Query clusters (German first) |
|---|---|---|
| `/vergleich/` | ChatGPT, Microsoft Copilot, NotebookLM (Gemini Notebook), Perplexity, own research in RIS/Google, Reiner AI, WEKA Bau AI, BauKI, K24AI and, where verifiable, BaurechtGPT | "ChatGPT Baurecht", "ChatGPT Alternative Architekten", "Reiner AI Alternative", "Rainer AI", "WEKA Bau AI Österreich", "KI Baurecht Österreich" |
| `/anwendungen/` | Gebäudeklasse, Brandschutz, Einreichcheck, Bestand, Bebauung, Wärmeschutz, Barrierefreiheit, Aufenthaltsraum, Prüfbericht und Aktenvermerk, Büroarchiv | "Gebäudeklasse bestimmen", "Einreichplan Checkliste", "Bauen im Bestand OIB", "Bebauungsplan prüfen", "Wissensmanagement Architekturbüro" |
| `/fuer/` | Architekturbüros, Ziviltechniker und Ingenieurbüros, Baumeister und Bauträger | "KI für Architekturbüros", "KI für Ziviltechniker", "KI für Baumeister" |
| `/baurecht/` | All nine states | "Bauordnung Tirol", "Welche OIB-Richtlinie gilt in …", "OIB-Richtlinien 2023 Niederösterreich" |
| `/glossar/` | Gebäudeklasse, Fluchtniveau, oberirdisches Geschoß, OIB-Richtlinien, RIS, Bebauungsplan, Einreichplan, Aufenthaltsraum, Brandabschnitt, Reihenhaus | "Was ist Gebäudeklasse 4", "Fluchtniveau Definition", "OIB-Richtlinien einfach erklärt" |

Why these are winnable:
- **Comparison and alternative queries.** The results show only the vendors'
  own pages.
- **Gebäudeklasse and Fluchtniveau.** The results are PDFs plus one thin page
  (flexible-design.at).
- **"Welche OIB-Richtlinie gilt in [Land]".** No maintained HTML table exists;
  the OIB's own tables are PDFs and pages that answer engines hedge on.
- **pak-immo.at** is the one systematic SEO player. It is an exam-prep company
  with long, bylined FAQ articles. That format is what ranks here.

## The competitive landscape (September 2026)

Read on each vendor's own site. The comparison pages carry the details and
the dates.

- **No shipping product combines Austrian state law via RIS, the OIB
  guidelines, the office archive and a project workspace.** Every comparison
  page makes that point.
- **K24AI** is the closest in concept (it names OIB and Austria), but its
  alpha is postponed and it has paused taking new testers.
- **German-law tools:** Reiner AI, WEKA Bau AI, BauKI, Nexfour and
  ki·spezial. None claims Austrian coverage. They beat Piloti on public
  prices, trials and German hosting, and the pages say so.
- **General assistants:** ChatGPT, Microsoft Copilot, NotebookLM (renamed
  Gemini Notebook in 2026) and Perplexity. They are strong on text, office
  documents and the web. None ships a curated Austrian building-law corpus.
- **Austrian incumbents to watch:** Forum Verlag's BaurechtGPT; "Norman" from
  Austrian Standards, which covers ÖNORM and is known only from a press
  release; MANZ Genjus, which does legal research for lawyers.
- **Authority side, not competitors:** BRISE-Vienna and the KI-Quadrat
  Bau-Assistent check permit applications for authorities. They are worth a
  sentence in sales, since the authority and the office meet at the same
  submission.

## Measurement: what to set up

The site sets no cookies and runs no tracking, and the privacy policy says
so. **Do not add Google Analytics.** It sets cookies, it needs a consent
banner, and it would break a promise the site makes on a page buyers read.
Measure this way instead:

1. **Google Search Console, as a Domain property.** Verify it with a DNS TXT
   record at the registrar: no code, no cookie, and it covers `www` too. Then
   submit `https://piloti.at/sitemap-index.xml`. It shows which queries find
   which page, the position and the click-through rate. That is the ranking
   report.
2. **Bing Webmaster Tools.** Import the property from Search Console in one
   click. Bing's index feeds ChatGPT search and Copilot, which matters for
   GEO.
3. **If visit counts are wanted:** a cookieless, self-hosted counter (Umami
   or Plausible Community Edition) on the cluster. It sets no cookie and
   needs no banner, and one sentence in the privacy policy covers it. It is
   a decision for the founders, and the privacy policy changes in the same
   commit.
4. **Leads.** Count "Planungsfrage für Piloti" mails per week. The subject
   line is fixed by the call to action for exactly that reason.

KPIs to review monthly in Search Console:
- impressions and clicks per section (`/vergleich/`, `/baurecht/`, …)
- average position for the ten target queries above
- the share of queries containing a competitor's name

## Links: what only people can do

Rankings for a new domain follow links. In order of value:
1. **Chambers.** The Kammer der ZiviltechnikerInnen (arching.at, ztkammer.at)
   runs member news and events. A talk or a member offer gets a link.
2. **Trade press.** architektur-aktuell.at, a3bau.at, report.at, baublatt.at.
   The OIB edition table and the comparison between tools are the stories
   they would print.
3. **Tool roundups.** Ask phase0.com's "KI im Architekturbüro 2026" and
   internet-fuer-architekten.de to list Piloti. Answer engines cite both for
   "KI + Architekten".
4. **Directories and events.** nextroom.at, and the Digital Findet Stadt KI
   Con.
5. **Founders' profiles.** Each LinkedIn profile links to piloti.at. Once one
   exists, add the company page to the Organization's `sameAs` in
   `src/lib/seo.ts`.

## Backlog, in order

1. The Search Console and Bing setup above. It takes about half an hour, and
   nothing else can be measured without it.
2. Decide on the GitHub repository (finding 14).
3. A bylined expert on the glossary and state pages ("Geprüft von …", with a
   ZT or architect's name). This is the E-E-A-T signal that pak-immo.at wins
   with.
4. Maintain the OIB table. When a state declares an edition binding, update
   `baurecht.ts`, the brief's table and each page's `checked` date. A stale
   in-force table does more harm than none.
5. Q&A articles on the long-tail questions, answered from the source and
   checked by someone in the office before they go live. Examples:
   - how the Fluchtniveau is measured
   - when a WDVS needs a fire stop
   - Stellplatzverpflichtung Wien 2026
   - the NÖ Bauordnung reform of 2026
6. English versions only where the English results are thin: "OIB guidelines
   explained", "Austrian building code AI".
7. Real evidence, once the pilots produce it: a case study and measured time
   before and after. See the gaps in
   [`website-conversion-and-seo.md`](website-conversion-and-seo.md).
