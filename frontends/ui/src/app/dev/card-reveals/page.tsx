'use client'

/**
 * Card-reveals dev preview: the two new cards in the state a reader has to
 * CLICK for, in the real 680px thread column.
 *
 * Both cards are built on „nicht zurück zum LLM … ich klick das und sehe mehr",
 * and neither of the things that promise buys is visible at rest — the gallery
 * shows them folded. So this route drives them open before the shot:
 *
 *   1. RECHENWEG, HERKUNFT OFFEN — the calculation's sources disclosure open:
 *      each operand's provenance tag, its ± band and where the figure is
 *      written down, plus the sentence saying the result was computed here.
 *   2. RECHENWEG, KNAPPE ENTSCHEIDUNG — the U-value whose exact result (0,2506)
 *      would round to the limit itself. The card must print the fourth decimal
 *      rather than show „0,25" beside „nicht erfüllt"; this is the shot that
 *      proves the printed number and the printed verdict cannot disagree.
 *   3. VERFAHREN, ANDERER SCHRITT — a step opened AGAINST the one the project
 *      is at: dashed chrome on muted ground, the correcting sentence inside the
 *      panel, and the way back — while the current row above keeps its filled
 *      node, its outcome and its „hier stehen Sie" chip.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import { useEffect, type FC, type ReactNode } from 'react'
import { CalculationCard } from '@/features/grid-cards/components/CalculationCard'
import { ProcessMapCard } from '@/features/grid-cards/components/ProcessMapCard'
import { I18nProvider } from '@/i18n'
import type { CalculationStepData, ProcessStepData } from '@/features/grid-cards/schematics/types'

const OIB4 = { document: 'OIB-Richtlinie 4', section: 'Pkt. 3.2', edition: 'Ausgabe Mai 2023' }
const OIB6 = { document: 'OIB-Richtlinie 6', section: 'Pkt. 4.2', edition: 'Ausgabe Mai 2023' }

const SCHRITTMASS: CalculationStepData[] = [
  {
    label: 'Schrittmaß',
    operation: 'sum',
    unit: 'cm',
    operands: [
      {
        label: 'Steigung',
        value: 17,
        unit: 'cm',
        factor: 2,
        provenance: 'computed',
        tolerance: 0.5,
        source: 'Einreichplan, Schnitt A-A',
      },
      { label: 'Auftritt', value: 30, unit: 'cm', provenance: 'declared', source: 'IFC-Modell haus-a.ifc' },
    ],
  },
]

/**
 * Rsi + 3,25 + 0,55 + Rse = 3,99 m²K/W, so U = 1 ÷ 3,99 = 0,25062… W/(m²K).
 * Against a „≤ 0,25" limit that FAILS, while the house two-decimal format would
 * print „0,25" — the one case where the number and the verdict would argue.
 */
const U_VALUE: CalculationStepData[] = [
  {
    label: 'Wärmedurchgangswiderstand',
    operation: 'sum',
    unit: 'm²K/W',
    operands: [
      { label: 'Rsi', value: 0.13, unit: 'm²K/W' },
      { label: 'Dämmung 18 cm', value: 3.27, unit: 'm²K/W' },
      { label: 'Ziegel 25 cm', value: 0.55, unit: 'm²K/W' },
      { label: 'Rse', value: 0.04, unit: 'm²K/W' },
    ],
  },
  {
    label: 'U-Wert',
    operation: 'quotient',
    unit: 'W/(m²K)',
    operands: [
      { label: '', value: 1 },
      { label: 'Rges', step: 1 },
    ],
  },
]

const VERFAHREN: ProcessStepData[] = [
  {
    label: 'Einreichung',
    summary: 'Einreichunterlagen werden bei der Baubehörde eingebracht.',
    actor: 'Bauwerber',
    requires: ['Einreichplan', 'Baubeschreibung', 'Energieausweis'],
    produces: ['Aktenzeichen'],
    reference: { document: 'Wiener Bauordnung', section: '§ 63' },
  },
  {
    label: 'Bauverhandlung',
    summary: 'Mündliche Verhandlung mit Nachbarn und Amtssachverständigen.',
    actor: 'Baubehörde',
    duration: 'binnen sechs Wochen',
    produces: ['Verhandlungsschrift'],
    reference: { document: 'Wiener Bauordnung', section: '§ 70' },
  },
  {
    label: 'Baubewilligung',
    summary: 'Bescheid mit den Auflagen aus der Verhandlung.',
    actor: 'Baubehörde',
    produces: ['Baubewilligungsbescheid'],
    reference: { document: 'Wiener Bauordnung', section: '§ 70' },
  },
  {
    label: 'Baubeginnsanzeige',
    summary: 'Der Baubeginn ist der Behörde anzuzeigen.',
    actor: 'Bauwerber',
    requires: ['rechtskräftige Baubewilligung'],
  },
  {
    label: 'Fertigstellungsanzeige',
    summary: 'Nach Fertigstellung, mit den Ausführungsbestätigungen.',
    actor: 'Bauwerber',
    requires: ['Ausführungsbestätigungen der Fachplaner'],
  },
]

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({ title, note, children }) => (
  <section className="flex flex-col gap-2">
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-2xl text-xs text-muted-foreground">{note}</p>
    </div>
    <div className="w-[680px] max-w-full">{children}</div>
  </section>
)

/**
 * Which blocks have already been driven, at MODULE scope and keyed per block.
 *
 * `reactStrictMode` mounts every effect twice in development, so a driver that
 * simply clicks runs twice — the first press opens the disclosure and the
 * second closes it, and the shot is then the resting state under the name of
 * the driven one. A flag inside the effect cannot see the second mount, and one
 * the cleanup resets cannot either. Same guard as `/dev/condition-tree`.
 */
const driven = new Set<string>()

/**
 * Presses the nth (from the end) disclosure inside the named block until it
 * REPORTS itself open.
 *
 * Polling rather than a fixed delay, for the reason `/dev/citation-interaction`
 * gives: a fixed wait loses the race whenever the dev server still has to
 * compile the route, and the shot then silently duplicates the resting state.
 */
const Open: FC<{ block: string; fromEnd?: number }> = ({ block, fromEnd = 1 }) => {
  useEffect(() => {
    if (driven.has(block)) return
    driven.add(block)
    let attempts = 0
    const tick = (): void => {
      const triggers = document.querySelectorAll<HTMLButtonElement>(
        `[data-preview="${block}"] button[aria-expanded]`
      )
      const target = triggers[triggers.length - fromEnd]
      if (target?.getAttribute('aria-expanded') === 'true') return
      target?.click()
      if (attempts++ > 80) return
      window.setTimeout(tick, 50)
    }
    tick()
  }, [block, fromEnd])
  return null
}

export default function CardRevealsPreviewPage() {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main data-testid="card-reveals-preview" className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8">
        <Block
          title="Rechenweg – Herkunft aufgeklappt"
          note="The sources disclosure driven open: provenance tag and ± band per operand, where each figure is written down, and the sentence saying the card computed the result rather than copying it."
        >
          <div data-preview="sources">
            <CalculationCard
              title="Schrittmaßregel – Treppenlauf Haus A"
              steps={SCHRITTMASS}
              limit={{
                comparator: 'between',
                value: 59,
                upper: 65,
                label: 'Schrittmaßregel',
                reference: OIB4,
              }}
            />
          </div>
        </Block>

        <Block
          title="Rechenweg – knappe Entscheidung"
          note="A two-step U-value whose exact result is 0,2506 W/(m²K) against a ≤ 0,25 limit. The house format would print „0,25“ beside „nicht erfüllt“; the card prints the digits that carry the decision instead."
        >
          <CalculationCard
            title="U-Wert Außenwand aus den Wärmedurchlasswiderständen"
            steps={U_VALUE}
            limit={{ comparator: '<=', value: 0.25, reference: OIB6 }}
            note="Wärmebrücken sind darin nicht berücksichtigt."
          />
        </Block>

        <Block
          title="Verfahren – anderer Schritt geöffnet"
          note="Baubewilligung opened against the step the project is at. Dashed chrome, the correcting sentence inside the panel and the way back — while the Bauverhandlung row above keeps its tinted node, its summary and its „hier stehen Sie“ chip."
        >
          <div data-preview="elsewhere">
            <ProcessMapCard
              title="Baubewilligungsverfahren – Wien"
              current_step={2}
              steps={VERFAHREN}
              reference={{ document: 'Wiener Bauordnung', section: '§§ 60 ff.' }}
            />
          </div>
        </Block>

        <Open block="sources" />
        <Open block="elsewhere" fromEnd={3} />
      </main>
    </I18nProvider>
  )
}
