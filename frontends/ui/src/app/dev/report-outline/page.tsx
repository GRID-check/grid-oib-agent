'use client'

/**
 * Report-outline dev preview: the deep-research report's own outline, on a
 * report long enough for it to exist.
 *
 * The outline only appears on a FINISHED report with at least four headings,
 * inside the research panel's scroll box — so previewing the component on its
 * own would prove nothing about the two things it claims. Both are properties
 * of the report around it: the collapsed row prints the section currently in
 * view (so „wo bin ich" is answered without opening anything), and the open
 * list marks that same section. This route therefore renders the REAL
 * `ReportTab` against a ~1.400-word report in a box the width and height of the
 * research panel, and drives each block into the state worth photographing:
 *
 *   1. EINGEKLAPPT — scrolled into the middle of the report, so the sticky row
 *      is showing a section the reader did not start at.
 *   2. AUSGEKLAPPT — the same report with the list open and the current section
 *      marked, capped at 50vh and scrollable.
 *
 * The report is seeded onto the chat store, which is where `ReportTab` reads it
 * from (`/dev/chat-welcome` and `/dev/shared-thread` seed the same way). No
 * backend is involved; the source chips resolve to nothing and degrade to plain
 * entries, exactly as they do for a report whose corpus file is not indexed.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import { useEffect, useState, type FC, type ReactNode } from 'react'
import { useChatStore } from '@/features/chat'
import { ReportTab } from '@/features/layout/components/ReportTab'
import { I18nProvider } from '@/i18n'

/**
 * A finished report of the shape this outline was built for: ten headings,
 * two of them H3, a table, and a written „Quellen" section — the entry readers
 * reach for most, and the one the outline has to synthesize because the
 * component renders that heading itself.
 */
const REPORT = `# Fluchtwege und Barrierefreiheit bei Gebäudeklasse 4 in Wien

Die Recherche fasst zusammen, welche Anforderungen an Fluchtwege, Treppenhäuser
und barrierefreie Erschließung für ein Wohngebäude der Gebäudeklasse 4 in Wien
gelten, und wo die Wiener Regelungen von den OIB-Richtlinien abweichen.

## Ausgangslage

Das Projekt umfasst ein Wohngebäude mit fünf oberirdischen Geschossen und einem
Kellergeschoss. Das oberste Fluchtniveau liegt bei 9,80 m über dem angrenzenden
Gelände und damit unter der Grenze von 11 m, ab der Gebäudeklasse 5 anzuwenden
wäre [1]. Maßgeblich für die Einstufung ist ausschließlich das oberste
Fluchtniveau, nicht die Gesamthöhe des Gebäudes — ein Punkt, der in der
Einreichung regelmäßig zu Rückfragen führt, weil Attika und Aufbauten
mitgemessen werden, obwohl sie kein Fluchtniveau bilden.

Für die Beurteilung wurden der Vorentwurf vom 12.06., der Lageplan und das
vorläufige Brandschutzkonzept herangezogen. Angaben zur Anleiterbarkeit der
Nordfassade fehlen bislang; sie sind für den zweiten Fluchtweg entscheidend.

## Rechtsrahmen

Die OIB-Richtlinien sind aus sich heraus nicht verbindlich. Verbindlichkeit
entsteht erst dadurch, dass ein Land sie für anwendbar erklärt — in Wien über
die Wiener Bautechnikverordnung 2020 [2]. Für die Einreichung heißt das: die
OIB-Richtlinie liefert den Inhalt, die Landesverordnung die Rechtsgrundlage,
und zitiert werden muss beides.

### Bundesebene: OIB-Richtlinien

OIB-Richtlinie 2 regelt den Brandschutz und enthält in Tabelle 1b die
erforderlichen Feuerwiderstandsklassen tragender Bauteile je Gebäudeklasse. Für
Gebäudeklasse 4 sind das REI 60, in Kellergeschossen unabhängig von der Klasse
REI 90 [1]. OIB-Richtlinie 4 regelt die Nutzungssicherheit und
Barrierefreiheit, OIB-Richtlinie 3 die Hygiene und den Schallschutz.

### Landesebene: Wiener Bautechnikverordnung

Die Wiener Bautechnikverordnung übernimmt die OIB-Richtlinien in der Ausgabe
Mai 2023, mit Abweichungen bei der Berechnung des Fluchtniveaus und bei den
Anforderungen an Aufzüge. § 108 der Bauordnung für Wien verlangt zusätzlich
einen zweiten Fluchtweg, wo die Anleiterbarkeit nicht nachgewiesen werden kann
[3].

## Anforderungen an Fluchtwege

Für Gebäudeklasse 4 sind zwei voneinander unabhängige Fluchtwege erforderlich.
Der erste ist der bauliche Weg über das Treppenhaus, das in jedem Geschoss
rauchdicht abzutrennen ist. Der zweite ist entweder ein zweiter baulicher Weg
oder eine über die Feuerwehr anleiterbare Stelle je Nutzungseinheit.

| Anforderung | Wert | Grundlage |
| --- | --- | --- |
| Gehweglänge bis zum sicheren Bereich | ≤ 40 m | OIB-RL 2, Pkt. 3.2 |
| Nutzbare Treppenlaufbreite | ≥ 120 cm | OIB-RL 4, Pkt. 2.2 |
| Rauchdichte Abtrennung Treppenhaus | in jedem Geschoss | OIB-RL 2, Pkt. 5.1 |

Die im Vorentwurf eingetragene Laufbreite von 110 cm unterschreitet den
Mindestwert und ist vor der Einreichung anzupassen; eine Ausnahme ist im
Wohnbau nicht vorgesehen.

## Barrierefreiheit

Ab drei oberirdischen Geschossen ist ein barrierefreier Aufzug erforderlich.
Die Kabine muss mindestens 110 × 140 cm messen, die lichte Türbreite mindestens
90 cm betragen [4]. Der Vorentwurf sieht 80 cm vor und erfüllt die Anforderung
damit nicht. Die Anpassung ist im Rohbau kostengünstig, nach der Einreichung
teuer — sie verschiebt den Schacht.

## Kostenfolgen

Die drei offenen Punkte — Laufbreite, Türbreite, Anleiterbarkeit — sind in der
Vorentwurfsphase mit geringem Aufwand zu lösen. Wird die Anleiterbarkeit erst
im Bauverfahren geklärt und dort verneint, ist ein zweites Treppenhaus
erforderlich; das kostet Nutzfläche in jedem Geschoss und ist die teuerste der
hier betrachteten Varianten.

## Offene Punkte

Die Anleiterbarkeit der Nordfassade ist ungeklärt. Erforderlich sind die
Aufstellfläche der Feuerwehr, der Abstand zur Fassade und die Höhe der
anzuleiternden Stelle. Ohne diese Angaben lässt sich der zweite Fluchtweg nicht
beurteilen, und die Aussage zu den Kostenfolgen bleibt unter Vorbehalt.

## Empfehlung

Die Laufbreite auf 120 cm und die lichte Türbreite auf 90 cm anzupassen, bevor
der Einreichplan gezeichnet wird, und die Anleiterbarkeit vorab mit der
Feuerwehr abzustimmen. Ein Schnitt durch das Treppenhaus mit eingetragenem
Fluchtniveau erspart erfahrungsgemäß eine Rückfrage der Behörde.

## Quellen
- [1] [KB] OIB-RL_2_Brandschutz.pdf, p.18
- [2] [RIS] Wiener Bautechnikverordnung 2020 — https://www.ris.bka.gv.at/
- [3] [RIS] Bauordnung für Wien § 108 — https://www.ris.bka.gv.at/
- [4] [KB] OIB-RL_4_Nutzungssicherheit.pdf, p.7
`

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({
  title,
  note,
  children,
}) => (
  <section className="flex flex-col gap-2">
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
    {/* The research panel: ~640px wide, and a fixed height, because the outline
        observes headings against THIS scroll box rather than the window. */}
    <div className="h-[820px] w-full max-w-[640px] overflow-hidden rounded-lg border bg-background p-4">
      {children}
    </div>
  </section>
)

/**
 * Which blocks have been driven already, at MODULE scope rather than in the
 * effect: `reactStrictMode` is on, so React mounts every effect twice in
 * development. A driver that simply presses the outline's toggle therefore ran
 * twice — opening the list and closing it again — and the block was captured at
 * rest under the name of the opened state. A flag inside the effect cannot see
 * the second mount, and one the cleanup resets cannot either.
 */
const driven = new Set<string>()

/**
 * Drives one block into the state the harness should capture, and keeps trying
 * until the block reports that state.
 *
 * Polls rather than waiting a fixed time: the report renders through the real
 * markdown pipeline, and how long that takes depends on whether the dev server
 * has compiled the route yet. A fixed delay that loses the race produces a
 * screenshot of the resting state under the name of the driven one — and a
 * press that lands before hydration looks exactly like success.
 */
const Drive: FC<{ selector: string; action: (element: HTMLElement) => boolean }> = ({
  selector,
  action,
}) => {
  useEffect(() => {
    if (driven.has(selector)) return
    driven.add(selector)
    let attempts = 0
    const tick = (): void => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element && action(element)) return
      if (attempts++ > 80) return
      window.setTimeout(tick, 50)
    }
    tick()
  }, [selector, action])
  return null
}

/** Scroll a report block to where the reader is past the first sections. */
const scrollIntoReport = (element: HTMLElement): boolean => {
  const box = element
    .querySelector<HTMLElement>('[data-testid="report-outline"]')
    ?.closest<HTMLElement>('.overflow-y-auto')
  if (!box) return false
  box.scrollTop = 1400
  return box.scrollTop > 0
}

/** Open the outline list of a report block. */
const openOutline = (element: HTMLElement): boolean => {
  const toggle = element.querySelector<HTMLButtonElement>('[data-testid="report-outline"] button')
  if (!toggle) return false
  if (toggle.getAttribute('aria-expanded') === 'true') return true
  toggle.click()
  return false
}

export default function ReportOutlinePreviewPage() {
  const [ready, setReady] = useState(false)

  // Seeded after mount so the server render and the first client render agree.
  useEffect(() => {
    useChatStore.setState({
      reportContent: REPORT,
      reportContentCategory: 'final_report',
      isStreaming: false,
      currentStatus: null,
      deepResearchCards: [],
      deepResearchCitations: [],
    })
    setReady(true)
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="report-outline-preview"
        className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8"
      >
        <Block
          title="Eingeklappt, mitten im Bericht"
          note="Scrolled past the first sections: the sticky row names the section in view, so „where am I“ is answered without opening anything."
        >
          <div id="report-collapsed" className="h-full">
            {ready && <ReportTab />}
          </div>
        </Block>

        <Block
          title="Ausgeklappt"
          note="The list the row opens into: ten entries, H3 entries indented, the section in view marked with a rule and full-contrast ink."
        >
          <div id="report-open" className="h-full">
            {ready && <ReportTab />}
          </div>
        </Block>

        {ready && (
          <>
            <Drive selector="#report-collapsed" action={scrollIntoReport} />
            <Drive selector="#report-open" action={openOutline} />
          </>
        )}
      </main>
    </I18nProvider>
  )
}
