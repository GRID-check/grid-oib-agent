'use client'

/**
 * Dev preview: the answer's Markdown dialect, drawn by the real renderer.
 *
 * First a whole composed answer, a Brandschutz check the way the agent writes
 * one (masthead, then prose and the designed blocks, citations resolved),
 * through the real `AgentResponse`. Then each block on its own, its Markdown
 * source beside it, so the page is also the dialect's reference: what a writer
 * types, and what the reader gets. Last, the two schematics that took over
 * retired cards' jobs (the site plan's density readout, the lift cabin).
 *
 * `?stream=1` replays the composed answer line by line, to watch a block draw
 * while it arrives. 404s outside development. Pinned to German; figures show
 * form, not a real project.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, type FC, type ReactNode } from 'react'
import { I18nProvider } from '@/i18n'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import type { CitationSource } from '@/features/chat/types'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { DimensionDiagramCard } from '@/features/grid-cards/schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '@/features/grid-cards/schematics/SetbackPlanCard'

const at = new Date('2026-09-28T09:30:00')
const OIB = 'oib-rl_2_ausgabe_mai_2023.pdf'

const locus = (page: number, number: number, snippet: string): CitationSource => ({
  id: `oib2-${page}`,
  content: `[KB] ${OIB}, p.${page}\n${snippet}`,
  citationKey: `${OIB}, p.${page}`,
  documentId: `doc:oib_knowledge:${OIB}`,
  fileName: OIB,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
  origin: 'kb',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  laneLabel: 'OIB-Richtlinie',
  sourceType: 'knowledge_layer',
  page,
  number,
  isCited: true,
  timestamp: at,
})

const citations: CitationSource[] = [
  locus(4, 1, 'Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen.'),
  locus(7, 2, 'Die Netto-Grundfläche eines Brandabschnitts darf 1.200 m² nicht überschreiten.'),
  locus(12, 3, 'Fluchtwege müssen ins Freie führen; die Fluchtweglänge darf 40 m nicht überschreiten.'),
]

const answerMeta: AnswerMeta = {
  v: 2,
  kind: 'ruling',
  verdict: {
    value: 'REI 90',
    subject: 'Trennwände zwischen Brandabschnitten, Gebäudeklasse 5',
    reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Mai 2023' },
  },
  summary:
    'Das Konzept hält den Feuerwiderstand und die Fluchtwege ein; der Brandabschnitt im 2. OG ist zu groß und muss geteilt werden.',
}

const COMPOSED = `Die Trennwände zwischen den Brandabschnitten brauchen **REI 90** und müssen aus Baustoffen der Klasse A2 bestehen [1]. Das Brandschutzkonzept, Stand 3, erfüllt das; offen ist die Größe des Brandabschnitts im 2. OG.

> „Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen." [1]

## Die Prüfung

:::pruefung
| Anforderung | Ist | Soll | Stand |
|---|---|---|---|
| Trennwand Brandabschnitte | REI 90 | REI 90 | erfüllt |
| Netto-Grundfläche Brandabschnitt 2. OG | 1.380 m² | max. 1.200 m² | nicht erfüllt |
| Fluchtweglänge Stiege 2 | 38 m | ≤ 40 m | erfüllt |
| Rauchabzug Stiegenhaus | — | — | zu prüfen |
:::

## Kennzahlen

:::kennzahlen
- Brandabschnitt 2. OG: 1.380 m² (max. 1.200 m²)
- Fluchtweglänge: 38 m (≤ 40 m)
- Geschoße: 6
- Energieeffizienz: :klasse[B]
:::

## Was jetzt zu tun ist

:::verfahren
1. Brandschutzkonzept, Stand 3, liegt vor
2. Brandabschnitt im 2. OG teilen **bis Einreichung** :aktuell
   :::details[Was es braucht]
   Eine zusätzliche Brandwand in REI 90 an Achse C, oder eine Sprinkleranlage nach TRVB 127 [2].
   :::
3. Einreichung bei der Baubehörde
4. Bauverhandlung
:::

## Welche Gebäudeklasse gilt

:::faelle
| Fluchtniveau | Gebäudeklasse | Stand |
|---|---|---|
| bis 7 m | GK 3 | trifft nicht zu |
| bis 11 m | GK 4 | trifft nicht zu |
| bis 22 m | GK 5 | trifft zu |
:::

## Zwei Wege, den Abschnitt zu teilen

:::vergleich
| Kriterium | Brandwand an Achse C :empfohlen | Sprinkleranlage |
|---|---|---|
| Kosten | gering | hoch |
| Grundriss | eine Wand mehr | unverändert |
| Brandabschnitt | erfüllt | erfüllt |
| Wartung | keine | jährlich |
:::

:::details[Herleitung der Fluchtweglänge]
Gemessen vom entferntesten Aufenthaltsraum bis zum Stiegenhaus, entlang der Gangachse [3].
:::`

const BLOCKS: { title: string; note: string; source: string }[] = [
  {
    title: ':::pruefung — eine Prüfung',
    note: 'Status aus dem Inhalt der Spalte, Balken für Wert gegen Grenzwert (die Rechnung gewinnt über das Wort), „Dazu fragen" an offenen Zeilen.',
    source: `:::pruefung
| Anforderung | Ist | Soll | Stand |
|---|---|---|---|
| Trittschall | 57 dB | ≥ 55 dB | erfüllt |
| Fluchtweglänge | 38 m | ≤ 40 m | offen |
| Brandabschnitt | 1.380 m² | max. 1.200 m² | erfüllt |
| Rauchabzug | — | — | zu prüfen |
:::`,
  },
  {
    title: ':::pruefung — alles erfüllt',
    note: 'Eine Prüfung ohne offene Zeile schrumpft auf ihre Zusammenfassung; die Zeilen bleiben einen Klick entfernt.',
    source: `:::pruefung
| Anforderung | Ist | Soll | Stand |
|---|---|---|---|
| Geländerhöhe | 1,10 m | ≥ 1,00 m | erfüllt |
| U-Wert Dach | 0,15 W/m²K | ≤ 0,20 W/m²K | erfüllt |
| Trittschall | 57 dB | ≥ 55 dB | erfüllt |
:::`,
  },
  {
    title: ':::verfahren — ein Verfahren',
    note: 'Jeder Punkt ist ein Schritt; **fett** ist die Frist, :aktuell der Schritt, an dem das Projekt steht, ein :::details darin öffnet auf Klick.',
    source: `:::verfahren
1. Vorprüfung
2. Einreichung **binnen 6 Wochen** :aktuell
   :::details[Was es braucht]
   Einreichpläne, Baubeschreibung, Energieausweis
   :::
3. Bauverhandlung
4. Bescheid
:::`,
  },
  {
    title: ':::faelle — Fälle',
    note: 'Der Fall, der zutrifft (Status „trifft zu" oder :trifft), ist getönt; die anderen bleiben lesbar.',
    source: `:::faelle
- Fluchtniveau bis 7 m: GK 3
- Fluchtniveau bis 11 m: GK 4 :trifft
- Fluchtniveau bis 22 m: GK 5
:::`,
  },
  {
    title: ':::kennzahlen — Kennzahlen (Tabelle)',
    note: 'Bezeichnung | Wert | Grenzwert | Status; auf dem Telefon zwei je Zeile.',
    source: `:::kennzahlen
| Kennzahl | Wert | Grenzwert |
|---|---|---|
| Bebauungsgrad | 38 % | ≤ 40 % |
| GFZ | 1,35 | ≤ 1,2 |
| Stellplätze | 14 | mind. 14 |
:::`,
  },
  {
    title: ':::vergleich — Varianten',
    note: 'Eine Spalte je Variante, :empfohlen im Kopf hebt sie hervor; unter 30rem ein Block je Variante.',
    source: `:::vergleich
| Kriterium | Außentreppe | Zweites Stiegenhaus :empfohlen |
|---|---|---|
| Kosten | gering | hoch |
| Fluchtweg | erfüllt | erfüllt |
| Nutzfläche | unverändert | − 24 m² |
:::`,
  },
  {
    title: ':::details — aufklappbar',
    note: 'Überall; in Kopie und Export aufgeklappt.',
    source: `:::details[Herleitung]
Der Wert folgt aus Tabelle 2, Zeile 3.
:::`,
  },
  {
    title: 'Zeilen, Zahlen, Klassen — ohne Direktive',
    note: 'Eine Status-Zeile „trifft zu" ist getönt; eine Spalte aus Werten steht rechtsbündig; :klasse[…] zeichnet die Energieeffizienzklasse. „10:30" bleibt Text.',
    source: `| Bauteil | Klasse | Fläche | Status |
|---|---|---|---|
| Decke | EI 60 | 1.200 m² | trifft nicht zu |
| Wand | EI 90 | 3,5 m² | trifft zu |

Energieausweis: :klasse[A+] statt :klasse[C]. Begehung um 10:30 Uhr.`,
  },
]

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({ title, note, children }) => (
  <section className="flex flex-col gap-3">
    <div>
      <h2 className="text-foreground text-sm font-semibold">{title}</h2>
      <p className="text-muted-foreground text-xs">{note}</p>
    </div>
    {children}
  </section>
)

/** The composed answer, whole or replayed line by line. */
function Composed() {
  const stream = useSearchParams().get('stream') === '1'
  const lines = COMPOSED.split('\n')
  const [shown, setShown] = useState(stream ? 1 : lines.length)
  useEffect(() => {
    if (!stream || shown >= lines.length) return
    const timer = setTimeout(() => setShown((count) => count + 1), 180)
    return () => clearTimeout(timer)
  }, [stream, shown, lines.length])
  return (
    <AgentResponse
      content={lines.slice(0, shown).join('\n')}
      messageId="dialect-preview"
      citations={citations}
      routingDecision="deep"
      answerMeta={answerMeta}
      answerConfidence="high"
      isStreaming={stream && shown < lines.length}
    />
  )
}

function Preview() {
  return (
    <main data-testid="answer-dialect-preview" className="text-foreground mx-auto flex w-full max-w-[760px] flex-col gap-10 p-6">
      <Block
        title="Eine ganze Antwort — Brandschutzprüfung"
        note="Kopf (Urteil, Zusammenfassung), dann Prosa und die gestalteten Blöcke in einem Rhythmus; [N] mit Vorschau überall, auch in den Blöcken."
      >
        <Composed />
      </Block>
      {BLOCKS.map((block) => (
        <Block key={block.title} title={block.title} note={block.note}>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <pre className="bg-muted/40 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed">{block.source}</pre>
            <div className="min-w-0">
              <MarkdownRenderer content={block.source} />
            </div>
          </div>
        </Block>
      ))}
      <Block
        title="Lageplan mit Bebauungsgrad und GFZ"
        note="Die Kennzahlen, die density_check trug, jetzt unter dem Lageplan; die Verhältnisse rechnet der Renderer aus den Flächen."
      >
        <SetbackPlanCard
          title="Abstandsflächen und Dichte"
          parcel_width_m={24}
          parcel_depth_m={42}
          building_width_m={14}
          building_depth_m={26}
          sides={[
            { side: 'front', required_m: 5, actual_m: 6, status: 'pass' },
            { side: 'left', required_m: 3, actual_m: 4, status: 'pass' },
          ]}
          reference={{ document: 'Bebauungsplan', section: '§ 3' }}
          gross_floor_area_m2={1450}
          coverage={{ label: 'Bebauungsgrad', value: null, required: 40, unit: '%', comparator: '<=', status: 'needs_input' }}
          density={{ label: 'GFZ', value: null, required: 1.2, unit: '', comparator: '<=', status: 'needs_input' }}
        />
      </Block>
      <Block title="Aufzugskabine" note="dimension_diagram mit shape lift_cabin: Kabinenbreite, Kabinentiefe, lichte Türbreite.">
        <DimensionDiagramCard
          title="Aufzug – barrierefreie Kabine"
          shape="lift_cabin"
          dimensions={[
            { label: 'Kabinenbreite', value: 110, required: 110, unit: 'cm', comparator: '>=', status: 'pass' },
            { label: 'Kabinentiefe', value: 130, required: 140, unit: 'cm', comparator: '>=', status: 'fail' },
            { label: 'lichte Türbreite', value: 90, required: 90, unit: 'cm', comparator: '>=', status: 'pass' },
          ]}
          reference={{ document: 'OIB-Richtlinie 4', section: 'Pkt. 2.6' }}
        />
      </Block>
    </main>
  )
}

export default function AnswerDialectPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense>
        <Preview />
      </Suspense>
    </I18nProvider>
  )
}
