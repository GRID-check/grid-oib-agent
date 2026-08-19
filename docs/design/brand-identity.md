# Piloti — Corporate Identity

The strategy half of the brand. `grid-design-language.md` is the component half:
what a button looks like, what a card is made of. This document is what those
components are *for* — who we are talking to, what we are claiming, in whose
voice, and which of it may never change.

Read this before touching the wordmark, the palette, the type ramp, a headline,
an empty state, an error message, or the marketing site. The living visual
specimen is `/dev/brand-identity`; the tokens are `frontends/ui/src/styles/tokens.css`
and `frontends/web/src/styles/global.css`.

- **Status:** first consolidated edition, 2026-08.
- **Owner:** whoever ships the change. There is no brand police; there is this document.
- **Change rule:** §10 Governance. Foundation and positioning change by decision;
  expression evolves continuously.

---

## 1. Foundation

| Element | Piloti |
|---|---|
| **Purpose** | Building law should not be the reason a good building gets worse. We exist so that the hours an architect spends *looking things up* go back into *designing*. |
| **Vision** | Every planning decision in the German-speaking market is made with its legal basis visible next to it — not remembered, not guessed, not deferred to the next meeting. |
| **Mission** | Connect Austrian building law, the office's own past projects, and the live project file into one knowledge base that answers in seconds and shows its work. |
| **Values** | **Traceable** — an answer without its source is not an answer. **Precise** — this is regulated matter; approximately right is wrong. **Restrained** — the tool recedes, the work is the subject. **Accountable** — we assist the decision; the architect signs it. **Durable** — practices keep files for decades; so do we. |
| **Personality** | The excellent senior colleague. Knows the Richtlinien cold, answers in two sentences, always says where it comes from, never performs, never pads, tells you when it does not know. Not an assistant, not a chatbot, not a "buddy". |
| **Promise** | **Sekunden statt Stunden — mit Verweis auf Paragraf, Richtlinie und Herleitung.** Every claim traceable to its origin. |

### The name

*Piloti* — the columns that carry a modernist building while leaving the ground
free. It arrived as the pilot office's colloquial name for the project, and it
was kept because the architectural reading is exactly the product: **structure
that carries the load and leaves the space open.** Piloti holds the regulatory
weight so the design floor stays clear. It is also, conveniently, *pilot* —
someone who knows the waters and steers, while the captain stays responsible.

The name is never translated, never inflected into a verb ("pilotify"), never
abbreviated to "P." or "Pil". In German copy it takes no article: *Piloti
verknüpft…*, not *das Piloti*.

---

## 2. Positioning

**For** architects and planning offices in Austria **who** lose hours
cross-referencing OIB-Richtlinien, Landesbauordnungen and their own project
archive, **Piloti is** a project-centric knowledge base with an AI research
layer **that** answers building-law questions in seconds and shows the
paragraph, the derivation and the assumptions behind every answer. **Unlike**
general AI assistants, which are fluent and unaccountable, and unlike the PDF
portals and CAD plug-ins, which store documents but answer nothing, **we** make
every statement traceable to its source and keep each project's knowledge
separate and durable **because** the corpus is curated Austrian building law,
the retrieval is scoped per project, and the reasoning chain is inspectable
rather than summarised.

### The word we own

**Nachvollziehbar** (traceable / verifiable). If a reader remembers one thing
about Piloti, it is that it *shows where the answer comes from*. Speed is the
benefit; traceability is the reason the speed is usable. Volvo owns safety; we
own the citation.

### Frame of reference

| They are | Their strength | Where we win |
|---|---|---|
| General AI chat (ChatGPT & co.) | Fluent, universal, free | It cannot cite Austrian building law, cannot see this project, and is confidently wrong at exactly the moments that carry liability |
| Document portals (RIS, OIB PDFs, office DMS) | Authoritative, complete | They store; they do not answer. The architect is still the search engine |
| CAD/BIM plug-ins and code checkers | Inside the model, geometric rules | They check what is drawn; they do not explain what the law requires or why |
| The senior colleague down the hall | Judgement, context, trust | The one thing we imitate on purpose — and they are in a meeting, and they retire |

### The audience, concretely

Not "AEC professionals". An Austrian architect, 30–60, in a practice of 3–40
people. Fluent in Revit/ArchiCAD/Vectorworks, works in German, deals with
Behörde and Einreichung, is personally liable for what they stamp, and is
sceptical of AI *specifically because* it does not cite. They do not want a
co-pilot with opinions. They want the paragraph, the page, and the derivation —
fast enough to use while still drawing.

**What follows for the brand:** every claim we make is checkable, every screen
is quiet enough to work in for eight hours, and nothing anywhere implies the
machine decides. *Die Verantwortung bleibt bei Ihnen.*

---

## 3. Brand architecture

**Endorsed, one level deep.**

- **Piloti** — the product brand. Everything a customer sees: wordmark, app,
  piloti.at, changelog, blog, invoices, support.
- **GRID** — the platform/company name. Internal and infrastructural only:
  repository, env vars (`GRID_*`), headers, CSS variable legacy names, the
  "GRID Platform" org. It is not a consumer brand and gets no visual identity of
  its own.
- **Features are described, not branded.** They take plain German names that say
  what they do: *Herleitung*, *Projektwissen*, *Archiv*, *Postfach*, *Skills*,
  *Modelle*. No capitalised product names inside the product, no ™ theatre, no
  "Piloti Intelligence Engine™". The one exception is inherited from the
  marketing site: **Decision Chain**, the name of the traceable path from
  question to decision, which the app renders as *Herleitung*. Prefer the German
  word in the product; keep Decision Chain for the site's narrative.

**Rule for anything new:** a new surface is a *section of Piloti*, not a new
brand. If a thing genuinely needs its own name, it needs its own positioning
statement first — and almost nothing does.

---

## 4. Verbal identity

### Voice spectrum

| Dimension | Piloti sits | Why |
|---|---|---|
| Formal ←→ Casual | **Formal-plain** (Sie, never du) | Austrian professional register; the reader is liable for the outcome |
| Serious ←→ Playful | **Serious, not solemn** | The subject is fire escape routes. No jokes, no emoji, no exclamation marks — but no funeral either |
| Technical ←→ Simple | **Technical, unpadded** | Say *Gebäudeklasse 4*, not "the building's category". The reader knows more than we do about their building |
| Humble ←→ Confident | **Confident about sources, humble about judgement** | "OIB-RL 2, Pkt. 3.5 verlangt…" is confident. "Das prüft die Behörde im Einzelfall" is humble. Both in the same answer is normal |

### Tone by context

| Context | Tone | Example |
|---|---|---|
| Marketing headline | Declarative, two beats, full stop | *Planen. Statt suchen.* |
| Product microcopy | Instructional, present tense, no filler | *Datei hinzufügen* |
| Answer copy | Legal-register, source first | *Für GK 4 sind zwei voneinander unabhängige Fluchtwege erforderlich (OIB-RL 2, Pkt. 2.5).* |
| Uncertainty | Named, never hedged into mush | *Dazu findet sich in den geladenen Quellen nichts. Mögliche nächste Schritte: …* |
| Error | What happened, what now, no apology theatre | *Upload fehlgeschlagen — Datei größer als 50 MB. Kleinere Datei wählen oder aufteilen.* |
| Empty state | An invitation with a first move | *Noch keine Dokumente. Laden Sie Pläne hoch, damit Piloti sie mitliest.* |
| Release note | What the reader can now do, in plain sentences | See `docs/contributing/release-notes.md` — the house rules there are this voice, enforced by CI |

### Vocabulary bank

**We say:** nachvollziehbar · Herleitung · Quelle · Beleg · Richtlinie ·
Paragraf · Projektwissen · Einreichung · Behörde · prüfen · gemessen · erforderlich ·
"laut OIB-RL 2" · "in Ihren Projektunterlagen"

**We never say:** revolutionär · nahtlos · mühelos · magisch · "KI-powered" ·
"einfach nur fragen" · "wir kümmern uns darum" · Assistent (Piloti is not an
assistant, it is a knowledge base with a research layer) · any claim of legal
certainty (*rechtssicher*, *garantiert konform*) — we show sources, we do not
issue guarantees.

### Sentence patterns that are ours

1. **Claim, then source, then limit.** *Zwei Fluchtwege erforderlich (OIB-RL 2,
   Pkt. 2.5). Für Sonderbauten kann die Behörde abweichen.*
2. **Short-full-stop pairs in display copy.** *Planen. Statt suchen.*
   *Keine Blackbox.* Two beats, no subordinate clause.
3. **Numbers with their unit and their origin.** *40 m Fluchtweglänge (§ 108 BO
   Wien)* — never a bare number.
4. **The reader is the actor.** *Sie entwerfen, Piloti liefert den Kontext.*
   Never *Piloti entscheidet*.

### The citation contract

Non-negotiable, and the reason the brand exists:

- Every substantive claim carries its source, visible without a click.
- A source is a paragraph or a document with a page — never "the guidelines".
- Where nothing was found, we say so; we do not fill the gap with fluency.
- Model output is never presented as legal advice, and the interface never
  implies the decision has been made for the reader.

---

## 5. Visual identity

The visual system in one sentence: **warm drafting paper, near-black ink, one
olive-green pencil, and the sources colour-coded — the working surface of a
careful office, not a dashboard.**

Where it comes from: architects work on gridded sheets, annotate in pencil,
mark provenance in the margin, and keep drawings for thirty years. Every element
below is that room, translated. It is also, deliberately, a rejection of the
2026 defaults — glass panels, gradient meshes, purple AI sparkle, brutalist
shout. Those read as *product*; this has to read as *instrument*.

### 5.1 Wordmark

- **Lockup:** the four-square mark + **PILOTI** in Poppins Medium, uppercase,
  letterspaced 0.2em (`font-logo`, `tracking-logo`). Identical on piloti.at and
  in the app — that identity is the point.
- **Clearspace:** the height of one square of the mark on all four sides.
- **Minimum sizes:** wordmark 12px cap height (`Logo size="small"`); mark alone
  16px. Below that, mark only.
- **Colour:** ink on paper, paper on ink. The mark is never green, never
  gradient, never outlined, never in a coloured disc.
- **Misuse:** do not set it in another face, do not tighten the tracking, do not
  set it mixed-case, do not lock it to a tagline, do not rotate it, do not put
  it on a photograph.

### 5.2 Colour

Three colour systems, three jobs. A token that fits none of them does not get
colour.

| System | Says | Where |
|---|---|---|
| **Paper & ink** | the surface and the words on it | everything by default; the primary action is ink, never green |
| **The accent — Piloti green** | *this one, right now*: focus, checked, chosen, in flight, the mark itself | `--brand*`; at most one green element per component, on the smallest element that can carry the meaning |
| **Provenance signals** | *where this came from*: law blue, OIB indigo, project green, office gold, model teal, gap gray, error red | `--source-*`; always with icon **and** label — colour never travels alone |

**The accent, precisely.** Light `--brand` #57703a — the marketing site's
accent-600 olive with chroma lifted ~35%, because on the site that colour fills
display type and here it must register on a 13px label and a 1.5px tick (5.3:1
on paper, 5.7:1 under white text). Dark `--brand` #a4b47a — the site's own
on-dark label green, not its hero lime: the lime is a display colour and reads
as a highlighter on a 16px switch. `--brand-pop` keeps the lime for a moment
that genuinely wants one; nothing currently spends it.

**Why olive and not a "tech" colour.** Olive is the colour of the drafting
pencil and of the site's own panels. It is unfashionable in software, which is
the point: a green that nobody else in this category is using is worth more than
the twelfth blue. It is also held apart from the *project green* provenance
signal by hue (128 vs 152) and by role — provenance greens only ever appear as a
chip beside an icon and a label; the accent never carries a source meaning.

**Accessibility is part of the palette, not a review step.** Body text ≥ 4.5:1,
UI chrome ≥ 3:1, both themes. A signal is never colour alone. Contrast figures
belong in the token comment next to the value.

### 5.3 Type — two voices, and one of them only makes statements

Five faces, five jobs, shared by the app and the marketing site, self-hosted, no
third-party request on first paint.

| Role | Face | Used for |
|---|---|---|
| `font-serif` — **the statement** | Instrument Serif | ONE moment per surface, ≥24px: the site's hero and narrative beats, the greeting on an empty thread. Nothing else. |
| `font-display` — **the working voice** | Helvetica Neue → Archivo | page titles, section headings, card titles, uppercase eyebrows, numeric stats |
| `font-sans` — the reader | Inter | body, controls, everything unmarked |
| `font-mono` — the record | IBM Plex Mono | identifiers: job ids, § references, collection names, measured values |
| `font-logo` | Poppins | the wordmark, and nothing else |

**The split is of role, not of taste.** The grotesk is the voice the product
works in — neutral by design, legible at 13px, invisible over an eight-hour day.
The serif is the voice the *brand* speaks in, and a brand does not speak
continuously: one statement per surface, at display size, or nothing. A page
that opens with a serif hero and then sets its section headings in the grotesk
is doing this correctly; a page with three serif headings has no statement left.

**The 24px floor is not a guideline.** Instrument Serif ships a single 400
weight with high stroke contrast. At 20px it goes spindly beside a 14px Inter
paragraph; at 13px it is unreadable. It is therefore never used for a page
title, a card title, a label, a table header, or body copy — the grotesk takes
all of those, at any size.

**Why this face.** Instrument Serif is a display serif — condensed, contrasty,
drawn to be set large — and the open equivalent of the Domaine/Canela class that
premium editorial brands use. The alternative tried first and reverted was a
*text* serif (Spectral): it survives small sizes, and at hero scale it reads as
an enlarged book page, which is precisely the dated look the serif was brought
in to avoid. One face cannot do both jobs. Playfair and Fraunces were also
considered — the first is the most overused serif on the web, the second carries
a period flavour that will date.

**Why a serif at all.** Neo-grotesk sameness is the real risk in this category:
when every product ships Inter, typography stops contributing to identity. The
counter-move is not to set the UI in a display face — it is to keep the working
typography neutral and spend the character in one place, where it is seen and
cannot get in the way.

**Weights and tracking follow the face.** The site's display steps carry weight
400 (a `700` would ask the browser to synthesise a bold and smear the contrast
the face exists for) and relaxed tracking (-0.008em at hero scale, where the
grotesk ran -0.032em): a high-contrast serif already reads as precision, and
squeezing it closes the counters. The ramp is in `grid-design-language.md`
§"Type ramp".

### 5.4 The drawing sheet

A 28px grid at ~4% ink, with the site's 168px (6×28) major grid available for
large surfaces (`drafting-sheet`, `globals.css`). It goes **only under bare
planes** — an empty state's panel, an empty chat — never under content and never
across the whole app. A blank surface should read as an unused sheet, not as a
missing screen. On the marketing site the same grid runs full-page at
landing-page scale; that is the loud version of one idea, this is the quiet one.

### 5.4b Craft rules that are function, not polish

Three rules that look like detailing and are actually structure. Each exists
because something is easier to *do* with it than without it.

- **Ledger numerals.** Every column of figures is `tabular-nums` — tables, stat
  tiles, count pills, measured values. A "1" is narrower than a "7" in
  proportional digits, so 1.482 and 7.900 do not line up and a column stops
  being comparable, which is the only reason it is a column. Digits only; prose
  is untouched.
- **Fluid statement type.** The serif moment sizes with the viewport
  (`clamp(1.75rem, 1.25rem + 1.6vw, 2.125rem)`) rather than snapping at a
  breakpoint. A display face fixed at one size is either too large on a 390px
  phone or too small on a 1600px desktop; there is no width where a jump helps.
- **One continuous grid.** The app's drafting sheet uses the site's module *and*
  its origin (28px, `center top`), so the grid a reader saw on piloti.at
  continues into the product instead of restarting half a square off.

This is also where the wider trend line lands: 2026's "raw aesthetics" — visible
grids, monospaced/ledger figures, serif headlines, no ornament — and its
rejection of glass-and-blur spectacle describe what this system already does for
its own reasons. That is the test for adopting any trend here: **it must already
be the functional answer.** A grid because architects work on gridded sheets;
mono because an identifier must be copyable and comparable; a serif because one
statement per surface earns a voice. If a trend cannot be argued from function,
it does not ship, however current it looks.

### 5.5 Motion

Movement is an argument, not an ornament: it says where something came from,
that a press landed, or that a change took. Durations and easings are tokens
(`--motion-*`, `--ease-*`); springs only where the trajectory carries
information, with a 1–2px overshoot budget; `prefers-reduced-motion` is honoured
absolutely, delays included. Full rules in the design language, §"Motion with a
reason". Brand-level: **nothing in Piloti bounces, pulses for attention, or
animates to look alive.** A tool that fidgets is a tool that distracts.

### 5.6 Icons and imagery

- **Icons:** Lucide, 1.5px stroke, 16px in dense UI. The provenance glyphs (§, doc,
  archive box, ruler, globe) are semantic and fixed — they are half of the
  colour-never-travels-alone rule.
- **Imagery:** the work surface, never the worker posing. The site's hero is the
  model to follow — an overhead shot of an architect's hands on a drawing at a
  drafting table, desaturated to the paper palette, with the drawing as the
  subject. Otherwise: plans, sections, details, and screenshots of real answers.
  **No stock photography of smiling teams or people in hard hats holding
  tablets. No 3D-rendered AI orbs. No gradient meshes.** If an image is not the
  work, a drawing, a diagram, or the product itself, it does not ship.

---

## 6. Applications

| Surface | What identity looks like there |
|---|---|
| **App chrome** | Paper, ink, one green icon marking where you are; the wordmark in the rail; the drafting grid only on empty planes |
| **Answers** | Provenance chips with icon + label; mono for §-references; the derivation reachable in one click |
| **piloti.at** | The loud version: full-page drafting grid, display type at hero scale, numbered sections `01…06`, the Decision Chain animation |
| **Changelog / blog** | Same faces, prose width, plain-language notes in the product voice (CI enforces the register) |
| **Exports & reports** | Paper, ink, mono identifiers, sources printed in full — an export must survive being printed and filed |
| **Email & OG images** | Wordmark, one sentence, no decoration. Never a hero photograph |

---

## 7. Anti-patterns

| Anti-pattern | Why it is wrong here | Instead |
|---|---|---|
| A green primary button | Makes the accent mean "action" and "state" at once; the reader stops trusting it | Ink action, green state |
| Colour without icon + label | Breaks the provenance contract and fails colour-blind readers | Icon, label, colour — always all three |
| "KI-powered", "revolutionär" | Claims the reader cannot check, in a category built on checkability | Say what it does and cite it |
| An emoji, an exclamation mark | Wrong register for a liability-bearing profession | The plain sentence |
| Stock photo of a smiling team | Generic SaaS; says nothing about building law | The work surface: hands, drawings, the product |
| A new sub-brand for a feature | Fragments a brand whose whole value is one trustworthy source | Describe it in German and move on |
| Trend-chasing (glass, gradient AI purple, brutalist shout) | Dates the product in a market that buys durability | The drafting sheet ages well |
| Green everywhere "for brand" | Kills the accent's meaning; makes a calm tool loud | One green thing per component |

---

## 8. The five-second brand test

Before shipping any user-facing surface, in order:

1. **Can a reader check every claim on this screen?** (traceable)
2. **Is the primary action ink, and is there at most one green thing?** (restrained)
3. **Does the copy say *Sie*, in the present tense, with no filler and no exclamation mark?** (voice)
4. **Would this still look right printed and filed in three years?** (durable)
5. **Does anything here imply the machine decided?** If yes — rewrite. (accountable)

---

## 9. Governance

- **Fixed** (change only by explicit decision, recorded here): name, purpose,
  positioning statement, the owned word, wordmark lockup, the three colour
  systems and their division of labour, the citation contract.
- **Evolving** (change freely, with the design language and tokens as the record):
  token values, ramp steps, component patterns, individual copy.
- **Where the truth lives:** foundation and voice here · component rules in
  `grid-design-language.md` · values in `frontends/ui/src/styles/tokens.css` and
  `frontends/web/src/styles/global.css` · living specimen at `/dev/brand-identity`
  (captured to `visual/screenshots/brand-identity.*.png` on every screenshot run).
- **Both surfaces move together.** A change to a shared token (face, accent,
  grid) is not done until the app and piloti.at agree. A divergence is a bug.

---

## 10. Open questions

1. **Sub-brand for the BIM/model layer?** Model measurement is a different
   promise (measured, not retrieved) and currently rides the provenance system.
   Recommendation: keep it described, not branded — revisit only if it is ever
   sold separately.
2. **German/English parity.** The product voice is defined in German and
   translated; the English strings currently read a shade more casual. Worth a
   pass with §4 in hand.
3. **The lime.** `--brand-pop` exists and nothing spends it. Either give it one
   deliberate home (a single marketing-adjacent moment in-product) or retire it.
4. **Print/export identity** is asserted above but not yet built; the export
   surface is the least brand-resolved part of the product.
