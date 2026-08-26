# Output Cards — der Entwurf vom August 2026

> **Was dieses Dokument ist.** Der Nachweis, woher die Kartenanatomie stammt,
> die [`grid-card-charter.md`](grid-card-charter.md) §A und §B beschreiben.
> Die Charter bleibt der Vertrag, aus dem gearbeitet wird; dieses Dokument sagt
> nur, welche Quelle sie in dieser Revision auslegt und wo sie liegt.

## Die Quelle

Der Produktverantwortliche hat den gesamten Kartensatz in Claude Design
nachgebaut — 45 Abschnitte, alle mit echten OIB-Inhalten gefüllt, in einer
Spalte untereinander, so wie sie im Katalog stehen. Zwei Dateien halten ihn fest:

| Datei | Wofür |
|---|---|
| [`assets/output-cards-2026-08.html`](assets/output-cards-2026-08.html) | Das lauffähige Bundle. Im Browser öffnen — es entpackt sich selbst und zeichnet alle 45 Abschnitte. Zum **Ansehen**. |
| [`assets/output-cards-2026-08.source.html`](assets/output-cards-2026-08.source.html) | Das entpackte `x-dc`-Template: Markup mit `{{ }}`-Platzhaltern, ab Zeile 1718 das Datenskript, das sie füllt. Zum **Lesen**. |

Die zweite Datei ist aus der ersten gewonnen — der Entwurf steckt gzip+base64 im
`__bundler/manifest`-Block. Falls jemand ein neueres Bundle bekommt:

```python
import json, re
s = open('bundle.html', encoding='utf-8').read()
t = json.loads(re.search(r'<script type="__bundler/template">(.*?)</script>', s, re.S).group(1))
open('source.html', 'w').write(t)
```

## Was daraus übernommen wird — und was ausdrücklich nicht

Der Entwurf ist in Plus Jakarta Sans gesetzt, benutzt eigene Hexwerte, kennt
keinen Dunkelmodus und keine Monospace. **Nichts davon wird übernommen.** Er ist
eine Quelle für den **Aufbau**, nicht für das Design System; die Entscheidung ist
so gefallen, damit die Karten nicht ein zweites Blau neben die Zitat-Chips und
die Herkunftsfilter stellen.

| Aus dem Entwurf | Bleibt beim Repo |
|---|---|
| Anatomie: welche Zeile wo steht, was gruppiert, was eingerückt ist | Farbwerte — `src/styles/tokens.css` |
| Kopfzeile: Titel links, Statuswort + Icon rechts, **kein Pillen-Badge** | Geist Sans + Geist Mono; Mono bleibt das Signal „nachprüfbare Zahl" |
| **Kein Eyebrow in der Karte** — der Titel trägt die Identität | Radius `--radius`, Elevation `--elevation-*` |
| Herkunfts-Pille als Fußzeile jeder Karte, getönt nach Quelle | Motion-Vokabular, `prefers-reduced-motion` |
| **Herkunft färbt Pillen, Status färbt nur Icon und Statuszeile** | Dunkelmodus als abgeleitete, nicht gespiegelte Seite |
| Innenpaneel: versenkter Grund, Haarlinie, 11px-Bildunterschrift darüber | `roughjs` ausschließlich in den Schematiken |
| Grenzwertzeile: Label / Wert / Limit auf einer Grundlinie über dem Track | sämtliche Anti-Ziele in Charter §D |

Die Herkunftstönung wird **immer** über `accentForLane`
(`features/chat/lib/source-kinds.ts`) aufgelöst, nie von Hand aus einem
Gesetzesnamen abgeleitet — sonst sagen die Karte und die „Belegt durch"-Chips
über dasselbe Dokument Verschiedenes.

### Die Schematiken zeichnet der Entwurf nach, nicht neu

`stair_diagram` steht im Entwurf mit 15 SVG-Primitiven; im Repo sind es 619
Zeilen mit sechs echten Architektur-Templates. Der Entwurf illustriert dort, was
in der Karte steht — er spezifiziert es nicht. Für die 15 Schematiken gilt
deshalb: **äußere Anatomie ja, Geometrie nein.** Charter §B3 nennt elf von ihnen
ausdrücklich „do not redesign", und das bleibt so.

Zwei Abschnitte gehen sogar hinter den Stand zurück und werden nicht gefolgt:
`acoustic_check` (24) und `energy_performance` (25) zeigen im Entwurf nur
Balkenzeilen. Charter §B3 verlangt für die eine eine echte Zeichnung und
bestätigt für die andere die A++–G-Leiter namentlich.

## Die 45 Abschnitte auf die 41 Kartentypen

**31 Abschnitte sind bestehende Typen, 1:1.**

01 `key_takeaways` · 02 `calculation` · 03 `requirement_checklist` ·
04 `deadline_timeline` · 05 `verdict_header` · 06 `callout` ·
07 `comparison_table` · 08 `condition_tree` · 09 `legal_basis` ·
10 `follow_ups` · 11 `summary` · 12 `process_map` · 13 `document_checklist` ·
14 `change_impact` · 15 `memory_proposal` · 16 `project_profile_patch` ·
17 `guardrail_check` · 18 `density_check` · 19 `parking_requirement` ·
20 `elevator_requirement` · 24 `acoustic_check` · 25 `energy_performance` ·
26 `thermal_envelope` · 27 `daylight_incidence` · 28 `stair_diagram` ·
35 `building_section` · 36 `setback_plan` · 37 `egress_diagram` ·
38 `fire_compartment` · 39 `fire_access_plan` — dazu `dimension_diagram`,
das mit sechs Vorlagen auftritt (29 Tür, 30 Rampe, 31 Gang, 32 Wendekreis,
33 Schwelle, 34 Stellplatz).

**Drei Abschnitte sind Zustände, keine Typen** — und genau deshalb wertvoll,
weil sie die Ausartung zeigen, die eine Karte überstehen muss:

| # | Zeigt |
|---|---|
| 21 `summary_under_verdict` | `summary`, wenn ein `verdict_header` darüber steht — rahmenlos, Titel zurückgenommen. Das ist die kartenübergreifende Regel aus Charter §A2, die `card-set.tsx` als `hasVerdictHeader` trägt. |
| 22 `verdict_header_long` | Der Leitwert ist ein Satz, keine Zahl. |
| 23 `verdict_header_bare` | Ein Wert aus den Projektunterlagen ohne Regelbezug — die Herkunfts-Pille fehlt, und das muss sie dürfen. |

**Sechs Abschnitte sind neu und stehen noch in keinem Schema:**
40 `zusammenfassung` (ein Kopfelement über der Antwort, keine Karte),
41 `project_impact`, 42 `document_preview`, 43 `document_result_set`,
44 `document_page_hits`, 45 `conflicting_values`.

Sie sind **nicht** Teil des Restylings. Jede von ihnen braucht
`src/aiq_agent/cards/models.py`, beide Generatorläufe, einen Eintrag in
`CARD_INTERACTIVITY`, einen Auslöser im Katalog und einen Weg durch den Export —
das ist eine eigene Arbeit mit eigenem Wert, und sie beginnt mit der Frage, ob
das Modell die Karte überhaupt zuverlässig auslösen kann.

**Zehn bestehende Typen kommen im Entwurf nicht vor:** `norm_chain`,
`typed_table`, `diagram`, `document_grid` und die sechs IFC-Karten. Sie
übernehmen die gemeinsame Hülle und behalten ansonsten die Vorgabe aus
Charter §B — der Entwurf sagt über sie nichts, und Schweigen ist keine
Anweisung.

## Wo der Entwurf der Charter widersprach

Drei Stellen, an denen beide nicht gleichzeitig gelten konnten. Die Auflösung
steht jeweils in der Charter selbst; hier steht, dass es eine Entscheidung war
und keine Auslegung.

1. **Die Figur-Regel.** Der Entwurf setzt in `calculation` drei Elemente über
   14px. Die Regel gilt weiter, aber ab 20px: 15px ist seither ein eigener
   Schritt *Wert* (eine gemessene Zahl in einer Zeile), 20px und darüber die
   *Figur* (die Antwort der Karte). Charter §A2.
2. **Die Formenzuordnung.** Der Entwurf gibt `deadline_timeline` die
   nummerierten Knoten und `process_map` die Zustandsglyphen — die Charter
   verlangte in §B2 das Gegenteil. Die Zuordnung des Entwurfs gilt; die Tabelle
   in §A5 ist danach neu geschrieben. Die Regel dahinter — keine zwei Karten
   teilen eine Marke — ist unberührt und bleibt der Prüfstein für Karte 46.
3. **Die Confidence-Anzeige.** Der Entwurf zeigt sie nirgends. Sie bleibt
   trotzdem, weil sie das Einzige ist, was zwei Antworten miteinander
   vergleichbar macht; sie zieht nur in die neue Kopfzeile um. Ein Wegfall wäre
   ein Verlust an Aussage gewesen, nicht an Dekoration.

## Die zwei Fallen, die diese Arbeit sonst kostet

**Jeder Zugriff auf ein verschachteltes Feld braucht einen Fallback.** Der
Schema-Generator flacht jedes `$ref` auf `z.any()` ab, `validateGridCards` lässt
eine Karte ohne ein in Pydantic pflichtiges Feld durch, und es gibt keine Error
Boundary um `GridCards` — ein fehlendes Feld nimmt die ganze Route mit. Muster:
`STATUS_ICON[item.status] ?? CircleHelp`. Beim Umbauen einer Zeile ist genau das
die Stelle, an der ein Fallback still verlorengeht.

**Auf 636px entwerfen, nicht auf den Entwurf.** Die Kette in der Produktion ist
`max-w-3xl` → `w-[680px]` → `px-[22px]` = 636px am Desktop, ~314px am Telefon.
Der Entwurf steht auf 760px minus 28px Padding — **rund 70px breiter**. Jede
zweispaltige Zeile daraus ist nachzurechnen, bevor sie übernommen wird.
`/dev/cards` rendert auf `max-w-2xl` und ist als Maß ebenfalls untauglich.
