/**
 * Render tests for the three cards that carry a dossier, a set of clocks and
 * the cost of a change.
 *
 * Three things are worth asserting through a mounted tree:
 *
 *   1. A CLICK REVEALS AND NOTHING ELSE HAPPENS. All three are presentational
 *      („nicht zurück zum LLM … ich klick das und sehe mehr"), so the negative
 *      assertions — no fetch, no send, no composer prefill — are the contract,
 *      not a detail.
 *   2. AN UNSET FIELD RENDERS AS UNKNOWN, NEVER AS A DEFAULT. A document nobody
 *      asked about is not a document the reader lacks, and a change whose
 *      starting point was never established has no „bisher". This is the rule a
 *      field observation showed the model breaking on `process_map`, and it is
 *      enforced here on the render side as well as in Pydantic.
 *   3. EVERY NUMBER IS DERIVED. The tallies exist on no wire field, so a count
 *      appearing on screen can only have been worked out by the component.
 */

import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { ChangeImpactCard } from './ChangeImpactCard'
import { DeadlineTimelineCard } from './DeadlineTimelineCard'
import { DocumentChecklistCard } from './DocumentChecklistCard'
import type {
  ChangeConsequenceData,
  DeadlineData,
  RequiredDocumentData,
} from '../schematics/types'

const chatSendFn = vi.fn()
const setComposerPrefill = vi.fn()

vi.mock('@/features/chat/store', () => {
  const state = () => ({ setComposerPrefill, chatSendFn })
  const useChatStore = (selector: (s: ReturnType<typeof state>) => unknown) => selector(state())
  useChatStore.getState = () => state()
  return { useChatStore }
})

/** The reader is Austrian; the copy comes from the dictionary, so pin the locale. */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Nothing reached a backend, a send or the composer. The three cards' contract. */
const expectNothingLeftTheClient = () => {
  expect(fetch).not.toHaveBeenCalled()
  expect(chatSendFn).not.toHaveBeenCalled()
  expect(setComposerPrefill).not.toHaveBeenCalled()
}

const UNTERLAGEN: RequiredDocumentData[] = [
  {
    label: 'Einreichplan',
    requirement: 'required',
    issuer: 'Ziviltechniker:in',
    status: 'present',
    note: 'dreifach, im Maßstab 1:100',
  },
  { label: 'Baubeschreibung', requirement: 'required', issuer: 'Ziviltechniker:in' },
  { label: 'Energieausweis', requirement: 'required', status: 'missing' },
  {
    label: 'Grundbuchsauszug',
    requirement: 'conditional',
    condition: 'nur wenn der Bauwerber nicht Eigentümer ist',
    issuer: 'Bauwerber',
    reference: { document: 'Wiener Bauordnung', section: '§ 63 Abs. 1 lit. e' },
  },
]

describe('DocumentChecklistCard', () => {
  it('draws a document nobody asked about as unknown, not as missing', () => {
    render(<DocumentChecklistCard title="Einreichunterlagen" items={UNTERLAGEN} />)

    // Three distinct states, three distinct words. „nicht bekannt" is the one
    // that would be lost if an absent status fell back to a default: two rows
    // carry no status, and neither may be reported as lacking.
    expect(screen.getAllByText('nicht bekannt')).toHaveLength(2)
    expect(screen.getAllByText('fehlt')).toHaveLength(1)
    expect(screen.getAllByText('liegt vor')).toHaveLength(1)
  })

  it('works out its own tally, which appears on no wire field', () => {
    render(<DocumentChecklistCard title="Einreichunterlagen" items={UNTERLAGEN} />)

    // 3 erforderlich / 1 bedingt, and 1 vorhanden / 1 fehlend / 2 ungeklärt.
    // Nothing in the props says any of those numbers.
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('vorhanden')).toBeInTheDocument()
    expect(screen.getByText('ungeklärt')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('says nothing is known instead of drawing a list at zero per cent', () => {
    render(
      <DocumentChecklistCard
        title="Einreichunterlagen"
        items={UNTERLAGEN.map((item) => ({ ...item, status: null }))}
      />
    )

    // A progress readout here would say „you have none of these", which is a
    // claim about the reader's project that nothing supports.
    expect(screen.getByText(/geht aus dem Gespräch nicht hervor/)).toBeInTheDocument()
    expect(screen.queryByText('vorhanden')).not.toBeInTheDocument()
  })

  it('opens a row onto its condition, issuer and Fundstelle, and reaches nothing', async () => {
    const user = userEvent.setup()
    render(<DocumentChecklistCard title="Einreichunterlagen" items={UNTERLAGEN} />)

    expect(screen.queryByText('§ 63 Abs. 1 lit. e')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Grundbuchsauszug/ }))

    expect(screen.getByText('§ 63 Abs. 1 lit. e')).toBeInTheDocument()
    expect(screen.getByText('Bauwerber')).toBeInTheDocument()
    expectNothingLeftTheClient()
  })

  it('opens rows independently, because a list is compared and not chosen from', async () => {
    const user = userEvent.setup()
    render(<DocumentChecklistCard title="Einreichunterlagen" items={UNTERLAGEN} />)

    await user.click(screen.getByRole('button', { name: /Einreichplan/ }))
    await user.click(screen.getByRole('button', { name: /Grundbuchsauszug/ }))

    // Unlike the process map's one-at-a-time selection: those steps are
    // alternatives for the reader's attention, these are items on one list.
    expect(screen.getByRole('button', { name: /Einreichplan/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Grundbuchsauszug/ })).toHaveAttribute('aria-expanded', 'true')
  })
})

const FRISTEN: DeadlineData[] = [
  {
    label: 'Beschwerdefrist',
    period: 'binnen vier Wochen',
    starts_from: 'ab Zustellung des Bescheids',
    actor: 'Nachbar',
    consequence: 'Der Bescheid wird rechtskräftig.',
    reference: { document: 'VwGVG', section: '§ 7 Abs. 4' },
  },
  {
    label: 'Baubeginnsanzeige',
    period: 'vor Beginn der Bauführung',
    starts_from: 'bezogen auf den beabsichtigten Baubeginn',
  },
  {
    label: 'Fertigstellungsanzeige',
    period: 'unverzüglich',
    starts_from: 'ab Fertigstellung des Bauvorhabens',
    actor: 'Bauwerber',
  },
]

describe('DeadlineTimelineCard', () => {
  it('shows every period as written, with the event its clock runs from', () => {
    render(<DeadlineTimelineCard title="Fristen im Bauverfahren" deadlines={FRISTEN} />)

    expect(screen.getByText('binnen vier Wochen')).toBeInTheDocument()
    // The trigger is at rest, not behind the click: a period nobody can place
    // is not usable, so it is never the thing a reader has to go looking for.
    expect(screen.getByText('ab Zustellung des Bescheids')).toBeInTheDocument()
    expect(screen.getAllByText('Fristbeginn')).toHaveLength(FRISTEN.length)
  })

  it('says out loud that it computes no dates and draws no durations', () => {
    render(<DeadlineTimelineCard title="Fristen im Bauverfahren" deadlines={FRISTEN} />)

    expect(screen.getByText(/rechnet kein Datum aus/)).toBeInTheDocument()
    expect(screen.getByText(/maßstabslos/)).toBeInTheDocument()
  })

  it('opens a Frist onto what happens if it lapses, and reaches nothing', async () => {
    const user = userEvent.setup()
    render(<DeadlineTimelineCard title="Fristen im Bauverfahren" deadlines={FRISTEN} />)

    expect(screen.queryByText('Der Bescheid wird rechtskräftig.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Frist 1: Beschwerdefrist/ }))

    expect(screen.getByText('Der Bescheid wird rechtskräftig.')).toBeInTheDocument()
    expect(screen.getByText('§ 7 Abs. 4')).toBeInTheDocument()
    expectNothingLeftTheClient()
  })

  it('offers no expander on a Frist with nothing behind it', () => {
    render(<DeadlineTimelineCard title="Fristen im Bauverfahren" deadlines={FRISTEN} />)

    // Baubeginnsanzeige carries no actor, no consequence and no reference. An
    // expander that opens onto nothing teaches the reader that the chevrons
    // are decorative, and then they stop pressing the ones that are not.
    expect(screen.queryByRole('button', { name: /Baubeginnsanzeige/ })).not.toBeInTheDocument()
    expect(screen.getByText('Baubeginnsanzeige')).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})

const FOLGEN: ChangeConsequenceData[] = [
  {
    aspect: 'Feuerwiderstand tragender Bauteile',
    before: 'R 60',
    after: 'R 90',
    direction: 'tightens',
    detail: 'Gilt für die tragenden Bauteile der oberirdischen Geschoße.',
    reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1' },
  },
  {
    aspect: 'Aufzug',
    after: 'Aufzug erforderlich',
    direction: 'tightens',
    reference: { document: 'OIB-Richtlinie 4', section: 'Pkt. 3' },
  },
  {
    aspect: 'Schallschutz',
    before: 'DnT,w mindestens 55 dB',
    after: 'DnT,w mindestens 55 dB',
    direction: 'unchanged',
    reference: { document: 'OIB-Richtlinie 5', section: 'Tabelle 1' },
  },
]

describe('ChangeImpactCard', () => {
  it('counts the directions itself, from rows that carry no tally', () => {
    render(
      <ChangeImpactCard
        title="Fluchtniveau über 11 m"
        factor="Fluchtniveau"
        from_value="7 bis 11 m"
        to_value="über 11 m"
        consequences={FOLGEN}
      />
    )

    expect(screen.getByText('Fluchtniveau: 7 bis 11 m → über 11 m')).toBeInTheDocument()
    // 2 verschärft, 1 unverändert — neither number is anywhere in the props.
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('says the starting point is unknown rather than printing a plausible one', () => {
    render(
      <ChangeImpactCard
        title="Nutzungsänderung"
        factor="Hauptnutzung"
        from_value={null}
        to_value="Beherbergungsstätte"
        consequences={FOLGEN.slice(1, 2)}
      />
    )

    expect(screen.getByText('Hauptnutzung → Beherbergungsstätte')).toBeInTheDocument()
    expect(screen.getByText(/Ausgangswert geht aus dem Gespräch nicht hervor/)).toBeInTheDocument()
  })

  it('marks a row with no before as unknown, not as blank', async () => {
    const user = userEvent.setup()
    render(
      <ChangeImpactCard
        title="Fluchtniveau über 11 m"
        factor="Fluchtniveau"
        to_value="über 11 m"
        consequences={FOLGEN}
      />
    )

    await user.click(screen.getByRole('button', { name: /Auswirkung: Aufzug/ }))

    // A blank „bisher" reads as „nothing applied before", which is a different
    // claim from „nobody said".
    expect(screen.getByText('bisher nicht bekannt')).toBeInTheDocument()
    expectNothingLeftTheClient()
  })

  it('opens a consequence onto its detail and its own Fundstelle, and reaches nothing', async () => {
    const user = userEvent.setup()
    render(
      <ChangeImpactCard
        title="Fluchtniveau über 11 m"
        factor="Fluchtniveau"
        from_value="7 bis 11 m"
        to_value="über 11 m"
        consequences={FOLGEN}
      />
    )

    expect(screen.queryByText('Tabelle 1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Feuerwiderstand tragender Bauteile/ }))

    expect(screen.getByText('Tabelle 1')).toBeInTheDocument()
    expect(screen.getByText(/oberirdischen Geschoße/)).toBeInTheDocument()
    expect(screen.getByText('R 60')).toBeInTheDocument()
    expectNothingLeftTheClient()
  })

  it('never carries a direction by colour alone', () => {
    render(
      <ChangeImpactCard
        title="Fluchtniveau über 11 m"
        factor="Fluchtniveau"
        to_value="über 11 m"
        consequences={FOLGEN}
      />
    )

    // Every row says which way it moves in a word, the same rule the
    // requirement checklist follows for its verdicts.
    expect(screen.getAllByText('verschärft').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('unverändert').length).toBeGreaterThanOrEqual(1)
  })
})
