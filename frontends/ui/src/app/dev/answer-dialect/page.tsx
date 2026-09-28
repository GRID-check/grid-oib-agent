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
 *
 * Every answer here binds one project profile fixture (`PROFILE`): Wien, GK 4,
 * Fluchtniveau 10,8 m confirmed, the Nutzung and the Geschoße assumed, the BGF
 * missing, so `:project[…]` shows all three chip states and `:::cases{by=…}`
 * marks its row and draws its ruler from it. What „ergänzen" and „Als Aufgabe"
 * put into the composer is shown in the bar at the top.
 */

import { notFound, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState, type FC, type ReactNode } from 'react'
import { I18nProvider } from '@/i18n'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import type { CitationSource } from '@/features/chat/types'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { DimensionDiagramCard } from '@/features/grid-cards/schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '@/features/grid-cards/schematics/SetbackPlanCard'
import { useChatStore } from '@/features/chat/store'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import type { QuoteStamp } from '@/lib/conversations/message-quote-stamps'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { projectFactResolver } from '@/lib/project-profile/answer-bindings'
import { AnswerDataProvider, type AnswerData } from '@/shared/components/MarkdownRenderer/answer-block-context'
import { AnswerProjectStrip } from '@/shared/components/MarkdownRenderer/project-binding'
import { searchedSources } from '@/features/chat/lib/answer-data'

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

const updated = '2026-09-20T08:00:00Z'

/** The project every answer on this page binds: confirmed, assumed and missing facts. */
const PROFILE: ProjectProfile = {
  facts: {
    bundesland: { value: 'wien', confidence: 'confirmed', source: 'onboarding', updatedAt: updated },
    gebaeudeklasse: { value: 'GK4', confidence: 'confirmed', source: 'user_confirmed', updatedAt: updated },
    fluchtniveau_m: { value: 10.8, confidence: 'confirmed', source: 'onboarding', updatedAt: updated },
  },
  goals: {},
  unknowns: ['bgf_oberirdisch'],
  assumptions: {
    nutzungen: { value: ['wohnen'], status: 'unconfirmed', reason: 'aus dem Projektnamen', source: 'agent_suggested', updatedAt: updated },
    geschosse_oberirdisch: {
      value: 5,
      status: 'unconfirmed',
      reason: 'aus den Schnitten geschätzt',
      source: 'agent_suggested',
      updatedAt: updated,
    },
  },
}

/** What the turn's retrieval searched: the source of „Gesucht in", never the model's list. */
const LEDGER: RetrievalLedger = [
  {
    index: 1,
    key: 'r1',
    tools: ['search_oib'],
    corpora: ['oib'],
    query: 'Photovoltaik Fassade',
    docs: [
      { name: OIB, title: 'OIB-Richtlinie 2, Ausgabe Mai 2023', detail: 'S. 4' },
      { name: 'oib-rl_2_leitfaden.pdf', title: 'OIB-Leitfaden zu RL 2', detail: 'S. 12' },
    ],
    newDocs: [OIB, 'oib-rl_2_leitfaden.pdf'],
    hits: 2,
    documents: 2,
  },
  {
    index: 2,
    key: 'r2',
    tools: ['search_ris'],
    corpora: ['ris'],
    query: 'BO Wien PV',
    docs: [{ name: 'https://www.ris.bka.gv.at/bo-wien', title: 'Bauordnung für Wien', detail: '§ 118' }],
    newDocs: ['https://www.ris.bka.gv.at/bo-wien'],
    hits: 1,
    documents: 1,
  },
]

/** The server's check of the quote lines: one verbatim, one it found in no passage. */
const STAMPS: QuoteStamp[] = [
  {
    text: 'Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen.',
    status: 'verbatim',
    number: 1,
    title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
    fileName: OIB,
    page: 4,
    punkt: '3.1.1',
  },
  { text: 'Brandabschnitte sind stets durch Brandwände zu trennen.', status: 'not_found', number: 2 },
]

const COMPOSED = `Die Trennwände zwischen den Brandabschnitten brauchen **REI 90** und müssen aus Baustoffen der Klasse A2 bestehen [1]. Das Brandschutzkonzept, Stand 3, erfüllt das; offen ist die Größe des Brandabschnitts im 2. OG.

> „Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen." [1]

Ihr Projekt in :project[state] liegt mit :project[escape_level_m] in :project[building_class]; die Bruttogrundfläche (:project[gross_floor_area_m2]) fehlt noch.

## Warum REI 90 hier gilt

:::subsumption
> „Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen." [1]

- Gebäudeklasse :project[building_class]
- Fluchtniveau :project[escape_level_m]
- Nutzung :project[use]

Die Anforderung an die Trennwand ist damit erfüllt.
:::

## Die Prüfung

:::check
| Anforderung | Ist | Soll | Stand |
|---|---|---|---|
| Trennwand Brandabschnitte | REI 90 | REI 90 | erfüllt |
| Netto-Grundfläche Brandabschnitt 2. OG | 1.380 m² | max. 1.200 m² | nicht erfüllt |
| Fluchtweglänge Stiege 2 | 38 m | ≤ 40 m | erfüllt |
| Rauchabzug Stiegenhaus | — | — | zu prüfen |
:::

## Kennzahlen

:::metrics
- Brandabschnitt 2. OG: 1.380 m² (max. 1.200 m²)
- Fluchtweglänge: 38 m (≤ 40 m)
- Geschoße: 6
- Energieeffizienz: :energy-class[B]
:::

## Was jetzt zu tun ist

:::procedure
1. Brandschutzkonzept, Stand 3, liegt vor
2. Brandabschnitt im 2. OG teilen **bis Einreichung** :current
   :::details[Was es braucht]
   Eine zusätzliche Brandwand in REI 90 an Achse C, oder eine Sprinkleranlage nach TRVB 127 [2].
   :::
3. Einreichung bei der Baubehörde
4. Bauverhandlung
:::

## Welche Gebäudeklasse gilt

:::cases{by=escape_level_m}
| Fluchtniveau | Gebäudeklasse | Stand |
|---|---|---|
| bis 7 m | GK 3 | trifft nicht zu |
| bis 11 m | GK 4 | trifft nicht zu |
| bis 22 m | GK 5 | trifft zu |
:::

Die Antwort schrieb „trifft zu" bei GK 5; das Profil sagt 10,8 m, also markiert der Renderer GK 4 und überstimmt die falsche Markierung.

> „Brandabschnitte sind stets durch Brandwände zu trennen." [2]

## Zwei Wege, den Abschnitt zu teilen

:::compare
| Kriterium | Brandwand an Achse C :recommended | Sprinkleranlage |
|---|---|---|
| Kosten | gering | hoch |
| Grundriss | eine Wand mehr | unverändert |
| Brandabschnitt | erfüllt | erfüllt |
| Wartung | keine | jährlich |
:::

:::details[Herleitung der Fluchtweglänge]
Gemessen vom entferntesten Aufenthaltsraum bis zum Stiegenhaus, entlang der Gangachse [3].
:::

## Was zu tun ist

:::actions
| Wer | Was | bis | Fundstelle |
|---|---|---|---|
| Planer | Brandwand an Achse C in die Einreichpläne aufnehmen | vor Einreichung | [2] |
| Brandschutzplaner | Brandschutzkonzept auf Stand 4 bringen | vor Einreichung | [1] |
| Bauwerber | Bruttogrundfläche im Projektprofil ergänzen | — | — |
:::`

const NOT_REGULATED_META: AnswerMeta = {
  v: 2,
  kind: 'ruling',
  verdict: { value: 'Nicht geregelt', subject: 'Photovoltaik an der Fassade, Brandverhalten' },
  summary: 'Die OIB-Richtlinie 2 regelt PV-Module an Fassaden nicht eigens; die Behörde entscheidet im Einzelfall.',
}

const NOT_REGULATED = `Für Photovoltaik-Module an der Fassade gibt es in der OIB-Richtlinie 2 **keine eigene Regelung** [1].

:::not-found
> „Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen." [1]

Entscheidet: die Baubehörde im Einzelfall, auf Grundlage eines Brandschutzkonzepts.
:::

:::actions
| Wer | Was | bis | Fundstelle |
|---|---|---|---|
| Planer | Vorgespräch mit der Baubehörde vereinbaren | vor Einreichung | [1] |
:::`

const BLOCKS: { title: string; note: string; source: string }[] = [
  {
    title: ':::check — eine Prüfung',
    note: 'Status aus dem Inhalt der Spalte, Balken für Wert gegen Grenzwert (die Rechnung gewinnt über das Wort), „Dazu fragen" an offenen Zeilen.',
    source: `:::check
| Anforderung | Ist | Soll | Stand |
|---|---|---|---|
| Trittschall | 57 dB | ≥ 55 dB | erfüllt |
| Fluchtweglänge | 38 m | ≤ 40 m | offen |
| Brandabschnitt | 1.380 m² | max. 1.200 m² | erfüllt |
| Rauchabzug | — | — | zu prüfen |
:::`,
  },
  {
    title: ':::check — alles erfüllt',
    note: 'Eine Prüfung ohne offene Zeile schrumpft auf ihre Zusammenfassung; die Zeilen bleiben einen Klick entfernt.',
    source: `:::check
| Anforderung | Ist | Soll | Stand |
|---|---|---|---|
| Geländerhöhe | 1,10 m | ≥ 1,00 m | erfüllt |
| U-Wert Dach | 0,15 W/m²K | ≤ 0,20 W/m²K | erfüllt |
| Trittschall | 57 dB | ≥ 55 dB | erfüllt |
:::`,
  },
  {
    title: ':::procedure — ein Verfahren',
    note: 'Jeder Punkt ist ein Schritt; **fett** ist die Frist, :current der Schritt, an dem das Projekt steht, ein :::details darin öffnet auf Klick.',
    source: `:::procedure
1. Vorprüfung
2. Einreichung **binnen 6 Wochen** :current
   :::details[Was es braucht]
   Einreichpläne, Baubeschreibung, Energieausweis
   :::
3. Bauverhandlung
4. Bescheid
:::`,
  },
  {
    title: ':::cases — Fälle',
    note: 'Der Fall, der zutrifft (Status „trifft zu" oder :applies), ist getönt; die anderen bleiben lesbar.',
    source: `:::cases
- Fluchtniveau bis 7 m: GK 3
- Fluchtniveau bis 11 m: GK 4 :applies
- Fluchtniveau bis 22 m: GK 5
:::`,
  },
  {
    title: ':::metrics — Kennzahlen (Tabelle)',
    note: 'Bezeichnung | Wert | Grenzwert | Status; auf dem Telefon zwei je Zeile.',
    source: `:::metrics
| Kennzahl | Wert | Grenzwert |
|---|---|---|
| Bebauungsgrad | 38 % | ≤ 40 % |
| GFZ | 1,35 | ≤ 1,2 |
| Stellplätze | 14 | mind. 14 |
:::`,
  },
  {
    title: ':::compare — Varianten',
    note: 'Eine Spalte je Variante, :recommended im Kopf hebt sie hervor; unter 30rem ein Block je Variante.',
    source: `:::compare
| Kriterium | Außentreppe | Zweites Stiegenhaus :recommended |
|---|---|---|
| Kosten | gering | hoch |
| Fluchtweg | erfüllt | erfüllt |
| Nutzfläche | unverändert | − 24 m² |
:::`,
  },
  {
    title: ':::cases{by=building_class} — der Renderer markiert',
    note: 'by= nennt den Projektschlüssel; der Renderer markiert die Zeile aus dem Profil (GK 4) und überstimmt ein widersprechendes „trifft zu" der Antwort.',
    source: `:::cases{by=building_class}
| Gebäudeklasse | Feuerwiderstand tragende Wände | Stand |
|---|---|---|
| GK 3 | R 30 | trifft zu |
| GK 4 | R 60 | trifft nicht zu |
| GK 5 | R 90 | trifft nicht zu |
:::`,
  },
  {
    title: ':::cases{by=escape_level_m} — mit Schwellen-Lineal',
    note: 'Die Fälle sind Bereiche; das Lineal zeigt die Schwellen, den Stift beim Wert des Projekts und den Abstand zur nächsten Schwelle.',
    source: `:::cases{by=escape_level_m}
- Fluchtniveau bis 7 m: GK 3
- Fluchtniveau über 7 m bis 11 m: GK 4
- Fluchtniveau über 11 m bis 22 m: GK 5
:::`,
  },
  {
    title: ':project[key] — der Wert kommt aus dem Profil',
    note: 'Durchgezogen: bestätigt. Gestrichelt mit „Annahme": vom Agenten angenommen. Schraffiert „fehlt · ergänzen": fehlt, ein Klick füllt den Composer. Ein unbekannter Schlüssel bleibt Text.',
    source: `Das Projekt in :project[state] hat :project[escape_level_m] und liegt in :project[building_class].
Nutzung :project[use], :project[storeys] Geschoße (angenommen); BGF: :project[gross_floor_area_m2].
Unbekannt: :project[parcel_area_m2].`,
  },
  {
    title: ':::actions — Maßnahmen',
    note: 'Wer | Was | bis | Fundstelle; Wer ist eine Rolle. „Als Aufgabe" füllt nur den Composer, angelegt wird nichts.',
    source: `:::actions
| Wer | Was | bis | Fundstelle |
|---|---|---|---|
| Planer | Brandschutzkonzept nachreichen | vor Einreichung | [2] |
| Statiker | Nachweis R 60 für die Decke über dem EG | Baubeginn | [1] |
| Behörde | Vorprüfung | 6 Wochen | — |
:::`,
  },
  {
    title: ':::not-found — Fehlanzeige',
    note: '„Gesucht in" kommt aus dem Retrieval-Protokoll des Zugs, nicht aus dem Text der Antwort; dann die nächstliegende Regel und wer entscheidet.',
    source: `:::not-found
> „Außenwandbekleidungen sind in Gebäudeklasse 4 und 5 aus A2 auszuführen." [1]

Entscheidet: die Baubehörde im Einzelfall.
:::`,
  },
  {
    title: ':::subsumption — Norm, Sachverhalt, Ergebnis',
    note: 'Die Regel als Zitat, die Tatsachen des Projekts als :project-Werte, ein Satz mit Statuswort.',
    source: `:::subsumption
> „Tragende Wände in Gebäudeklasse 4 sind in R 60 auszuführen." [1]

- Gebäudeklasse :project[building_class]
- Fluchtniveau :project[escape_level_m]

Die tragenden Wände brauchen R 60; der Nachweis ist offen.
:::`,
  },
  {
    title: ':::metrics — drei und vier Kacheln',
    note: 'Drei in einer Reihe (auf dem Telefon untereinander), vier als zwei mal zwei oder in einer Reihe; keine Kachel allein in der zweiten Reihe.',
    source: `:::metrics
- Bebauungsgrad: 38 % (≤ 40 %)
- GFZ: 1,35 (≤ 1,2)
- Stellplätze: 14 (mind. 14)
:::

:::metrics
- Bebauungsgrad: 38 % (≤ 40 %)
- GFZ: 1,35 (≤ 1,2)
- Stellplätze: 14 (mind. 14)
- Grünfläche: 22 % (≥ 20 %)
:::`,
  },
  {
    title: 'Zitat mit Stempel des Servers',
    note: 'Der Server prüft jede Zitatzeile gegen die Passagen des Zugs: „Wortlaut belegt [N]" mit Stelle, oder „Wortlaut nicht belegt" und das Zitat wird als Paraphrase gesetzt.',
    source: `> „Wände zwischen Brandabschnitten sind in Gebäudeklasse 5 in REI 90 und A2 auszuführen." [1]

> „Brandabschnitte sind stets durch Brandwände zu trennen." [2]`,
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
    note: 'Eine Status-Zeile „trifft zu" ist getönt; eine Spalte aus Werten steht rechtsbündig; :energy-class[…] zeichnet die Energieeffizienzklasse. „10:30" bleibt Text.',
    source: `| Bauteil | Klasse | Fläche | Status |
|---|---|---|---|
| Decke | EI 60 | 1.200 m² | trifft nicht zu |
| Wand | EI 90 | 3,5 m² | trifft zu |

Energieausweis: :energy-class[A+] statt :energy-class[C]. Begehung um 10:30 Uhr.`,
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
function Composed({ content = COMPOSED, meta = answerMeta }: { content?: string; meta?: AnswerMeta }) {
  const stream = useSearchParams().get('stream') === '1' && content === COMPOSED
  const lines = content.split('\n')
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
      answerMeta={meta}
      answerConfidence="high"
      isStreaming={stream && shown < lines.length}
      projectProfile={PROFILE}
      retrievalLedger={LEDGER}
      quoteStamps={STAMPS}
    />
  )
}

/** What „ergänzen" and „Als Aufgabe" put into the composer; nothing else happens. */
function ComposerEcho() {
  const prefill = useChatStore((state) => state.composerPrefill)
  return (
    <p data-testid="composer-echo" className="bg-muted/60 sticky top-0 z-20 rounded-md px-3 py-2 font-mono text-xs">
      Composer: {prefill?.text ?? '—'}
    </p>
  )
}

function Preview() {
  const setComposerPrefill = useChatStore((state) => state.setComposerPrefill)
  const data = useMemo(
    (): AnswerData => ({
      project: projectFactResolver(PROFILE),
      prefill: setComposerPrefill,
      searched: searchedSources(LEDGER),
      quoteStamps: STAMPS,
    }),
    [setComposerPrefill]
  )
  return (
    <main data-testid="answer-dialect-preview" className="text-foreground mx-auto flex w-full max-w-[760px] flex-col gap-10 p-4 sm:p-6">
      <ComposerEcho />
      <Block
        title="Eine ganze Antwort — Brandschutzprüfung"
        note="Kopf (Urteil, Zusammenfassung), Projektbezug, dann Prosa und die gestalteten Blöcke in einem Rhythmus; [N] mit Vorschau überall, auch in den Blöcken."
      >
        <Composed />
      </Block>
      <Block
        title="Eine Fehlanzeige — Nicht geregelt"
        note="Nur wenn der Kopf „Nicht geregelt“ sagt, zeichnet :::not-found seine drei Felder; „Gesucht in“ aus dem Retrieval-Protokoll."
      >
        <Composed content={NOT_REGULATED} meta={NOT_REGULATED_META} />
      </Block>
      <Block title="Projektbezug-Leiste" note="Die Fakten, die eine Antwort bindet, unter dem Kopf; in denselben Chips wie im Text.">
        <AnswerDataProvider value={data}>
          <AnswerProjectStrip keys={['state', 'building_class', 'escape_level_m', 'use', 'storeys', 'gross_floor_area_m2']} />
        </AnswerDataProvider>
      </Block>
      {BLOCKS.map((block) => (
        <Block key={block.title} title={block.title} note={block.note}>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <pre className="bg-muted/40 overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed">{block.source}</pre>
            <div className="min-w-0">
              <AnswerDataProvider value={data}>
                <MarkdownRenderer content={block.source} />
              </AnswerDataProvider>
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
