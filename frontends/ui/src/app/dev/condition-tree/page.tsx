'use client'

/**
 * Condition-tree dev preview: the Bedingungsbaum in the three states the card
 * actually has, in the real 680px thread column.
 *
 * The card answers „hängt von der Gebäudeklasse ab" by drawing the fork and
 * marking the case that applies to this project. Its whole risk is a reader
 * screenshotting the WRONG case into an Einreichung, and the defences against
 * that are visual — the tinted node and „trifft zu" chip that never move, the
 * Konjunktiv lead on a previewed case, the dashed chrome, and the correcting
 * sentence inside the previewed panel. None of that is reviewable from the
 * resting state alone, so the middle block below is driven into the switched
 * state before the shot is taken.
 *
 *   1. RUHEZUSTAND    — the case that applies, open, with its Grundlage.
 *   2. ANDERER FALL    — GK 5 opened against it: Konjunktiv lead, dashed panel,
 *                        „Nur zum Vergleich …" and the way back — while the
 *                        active row above keeps its chip and its outcome.
 *   3. OHNE ZUTREFFENDEN FALL — no branch marked: the tree opens closed and
 *                        nothing is marked, because picking a case on the
 *                        reader's behalf is the failure this card exists to
 *                        avoid.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import { useEffect, type FC, type ReactNode } from 'react'
import { ConditionTreeCard } from '@/features/grid-cards/components/ConditionTreeCard'
import { I18nProvider } from '@/i18n'
import type { ConditionBranchData } from '@/features/grid-cards/schematics/types'

const REFERENCE = {
  document: 'OIB-Richtlinie 2',
  section: 'Tabelle 1b',
  edition: 'Ausgabe Mai 2023',
}

const BRANCHES: ConditionBranchData[] = [
  {
    condition: 'GK 1–3',
    outcome: 'REI 30 (bzw. R 30)',
    reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' },
  },
  {
    condition: 'GK 4',
    outcome: 'REI 60',
    active: true,
    reference: {
      document: 'OIB-Richtlinie 2',
      section: 'Tabelle 1b',
      excerpt:
        'Tragende Bauteile in Gebäuden der Gebäudeklasse 4 sind in REI 60 auszuführen; in Kellergeschossen gilt REI 90.',
    },
  },
  {
    condition: 'GK 5',
    outcome: 'REI 90 — zusätzlich Sicherheitstreppenhaus ab 22 m Fluchtniveau',
    reference: {
      document: 'OIB-Richtlinie 2',
      section: 'Tabelle 1b',
      excerpt:
        'In Gebäuden der Gebäudeklasse 5 sind tragende Bauteile in REI 90 auszuführen.',
    },
  },
]

/** The same tree with nothing marked — the „wir wissen es nicht" shape. */
const UNMARKED: ConditionBranchData[] = BRANCHES.map(({ active: _active, ...branch }) => branch)

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({
  title,
  note,
  children,
}) => (
  <section className="flex flex-col gap-2">
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-2xl text-xs text-muted-foreground">{note}</p>
    </div>
    <div className="w-[680px] max-w-full">{children}</div>
  </section>
)

/**
 * Whether the switched block has been driven yet, at MODULE scope rather than
 * in the effect.
 *
 * `reactStrictMode` is on, so React mounts every effect twice in development
 * and a driver that simply clicks runs twice: the first press opened GK 5, the
 * second closed it again, and the block was captured with nothing open at all
 * under the name of the switched state. A flag inside the effect cannot see
 * that, and one that the cleanup resets cannot either.
 */
let switching = false

/**
 * Opens the LAST branch of the block it is placed in, so the harness captures
 * the switched state instead of the resting one.
 *
 * Polls rather than waiting a fixed time, the way `/dev/citation-interaction`
 * does and for the same reason: a fixed delay loses the race whenever the dev
 * server has to compile the route first, and the shot then silently becomes a
 * duplicate of block 1. It keeps polling until the branch actually reports
 * itself open, so a press that lands before hydration is retried rather than
 * mistaken for success.
 */
const OpenOtherCase: FC = () => {
  useEffect(() => {
    if (switching) return
    switching = true
    let attempts = 0
    const tick = (): void => {
      const triggers = document.querySelectorAll<HTMLButtonElement>(
        '[data-preview="switched"] button[aria-expanded]'
      )
      const last = triggers[triggers.length - 1]
      if (last?.getAttribute('aria-expanded') === 'true') return
      last?.click()
      if (attempts++ > 80) return
      window.setTimeout(tick, 50)
    }
    tick()
  }, [])
  return null
}

export default function ConditionTreePreviewPage() {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="condition-tree-preview"
        className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8"
      >
        <Block
          title="Ruhezustand"
          note="The case that applies to this project is open from the start, with its Grundlage under it; the other cases are one line each."
        >
          <ConditionTreeCard
            title="Erforderliche Feuerwiderstandsklasse tragender Bauteile"
            question="Gebäudeklasse"
            branches={BRANCHES}
            reference={REFERENCE}
          />
        </Block>

        <Block
          title="Anderer Fall geöffnet"
          note="GK 5 opened against the case that applies. Konjunktiv lead, dashed chrome, the correcting sentence inside the panel — and the active row above still carries its tinted node, its outcome and its „trifft zu“ chip."
        >
          <div data-preview="switched">
            <ConditionTreeCard
              title="Erforderliche Feuerwiderstandsklasse tragender Bauteile"
              question="Gebäudeklasse"
              branches={BRANCHES}
              reference={REFERENCE}
            />
          </div>
        </Block>

        <Block
          title="Ohne zutreffenden Fall"
          note="Nothing is marked, so the tree opens closed: every case is an equal one-line row and none is presented as this project's answer."
        >
          <ConditionTreeCard
            title="Erforderliche Feuerwiderstandsklasse tragender Bauteile"
            question="Gebäudeklasse"
            branches={UNMARKED}
            reference={REFERENCE}
          />
        </Block>

        <OpenOtherCase />
      </main>
    </I18nProvider>
  )
}
