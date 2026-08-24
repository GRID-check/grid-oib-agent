/**
 * Render tests for the two cards that carry a derivation and a procedure.
 *
 * Two things are worth asserting through a mounted tree, and only two — the
 * arithmetic itself is covered far more cheaply in `../lib/calculate.spec.ts`:
 *
 *   1. The card PRINTS what it computed, not what it was handed. A model can
 *      state operands and a limit and nothing else, so the result appearing on
 *      screen can only have come from the renderer.
 *   2. A click reveals and NOTHING else happens. Both cards are presentational
 *      („nicht zurück zum LLM … ich klick das und sehe mehr"), so the negative
 *      assertions — no fetch, no send — are the contract.
 */

import { render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import { CalculationCard } from './CalculationCard'
import { ProcessMapCard } from './ProcessMapCard'
import type { CalculationStepData, ProcessStepData } from '../schematics/types'

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
      { label: 'Auftritt', value: 30, unit: 'cm', provenance: 'declared' },
    ],
  },
]

describe('CalculationCard', () => {
  it('prints a result the payload never contained, from the operands it was given', () => {
    render(
      <CalculationCard
        title="Schrittmaßregel – Treppenlauf Haus A"
        steps={SCHRITTMASS}
        limit={{ comparator: 'between', value: 59, upper: 65, label: 'Schrittmaßregel' }}
      />
    )

    // 2 × 17 + 30. Nothing in the props says 64; the only way it can be on
    // screen is that the card worked it out.
    expect(screen.getByText('64')).toBeInTheDocument()
    expect(screen.getByText('17')).toBeInTheDocument()
    expect(screen.getByText('30')).toBeInTheDocument()
  })

  it('derives the verdict from its own result, not from a supplied status', () => {
    const { unmount } = render(
      <CalculationCard title="Schrittmaß" steps={SCHRITTMASS} limit={{ comparator: 'between', value: 59, upper: 65 }} />
    )
    expect(screen.getByText('erfüllt')).toBeInTheDocument()
    unmount()

    // Same operands, a limit the result misses — and the card says so without
    // anything in the payload having changed its mind.
    render(<CalculationCard title="Schrittmaß" steps={SCHRITTMASS} limit={{ comparator: '<=', value: 60 }} />)
    expect(screen.getByText('nicht erfüllt')).toBeInTheDocument()
  })

  it('carries the measured band into the result it computed', () => {
    render(<CalculationCard title="Schrittmaß" steps={SCHRITTMASS} limit={null} />)

    // 2 × (17 ± 0,5) → ±1 cm on the sum, in Austrian notation.
    expect(screen.getByText('±1 cm')).toBeInTheDocument()
  })

  it('shows the missing-value phrase instead of a partial sum when an operand is unknown', () => {
    render(
      <CalculationCard
        title="Schrittmaß"
        steps={[
          {
            label: 'Schrittmaß',
            operation: 'sum',
            unit: 'cm',
            operands: [
              { label: 'Steigung', value: null, unit: 'cm' },
              { label: 'Auftritt', value: 30, unit: 'cm' },
            ],
          },
        ]}
      />
    )

    expect(screen.getAllByText('fehlende Angabe').length).toBeGreaterThan(0)
    expect(screen.queryByText('30 cm')).not.toBeInTheDocument()
    expect(screen.getByText(/nicht berechenbar/)).toBeInTheDocument()
  })

  it('reveals where the figures came from on click, and reaches nothing to do it', async () => {
    const user = userEvent.setup()
    render(<CalculationCard title="Schrittmaß" steps={SCHRITTMASS} limit={null} />)

    expect(screen.queryByText(/Schnitt A-A/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Woher die Zahlen kommen/ }))

    expect(screen.getByText(/Schnitt A-A/)).toBeInTheDocument()
    expect(screen.getByText('gemessen')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(chatSendFn).not.toHaveBeenCalled()
    expect(setComposerPrefill).not.toHaveBeenCalled()
  })

  it('offers no disclosure when no operand has anything behind it', () => {
    render(
      <CalculationCard
        title="Geschossflächenzahl"
        steps={[
          {
            label: 'GFZ',
            operation: 'quotient',
            operands: [
              { label: 'BGF', value: 2400, unit: 'm²' },
              { label: 'Grundfläche', value: 800, unit: 'm²' },
            ],
          },
        ]}
      />
    )

    // An expander that opens onto nothing teaches the reader the chevrons are
    // decorative, and then they stop clicking the ones that are not.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})

const VERFAHREN: ProcessStepData[] = [
  {
    label: 'Einreichung',
    summary: 'Einreichunterlagen werden eingebracht.',
    actor: 'Bauwerber',
    requires: ['Einreichplan'],
    produces: ['Aktenzeichen'],
  },
  { label: 'Bauverhandlung', actor: 'Baubehörde', duration: 'binnen sechs Wochen' },
  { label: 'Baubewilligung', produces: ['Baubewilligungsbescheid'] },
]

describe('ProcessMapCard', () => {
  it('marks only the step it was told about, and opens it', () => {
    render(<ProcessMapCard title="Baubewilligungsverfahren" steps={VERFAHREN} current_step={2} />)

    expect(screen.getByText('hier stehen Sie')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Schritt 2/ })).toHaveAttribute('aria-current', 'step')
    // The current step's panel is open from the start: it is already the answer.
    expect(screen.getByRole('button', { name: /Schritt 2/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Schritt 1/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('marks nothing and opens nothing when the answer does not know where the project is', () => {
    render(<ProcessMapCard title="Baubewilligungsverfahren" steps={VERFAHREN} current_step={null} />)

    expect(screen.queryByText('hier stehen Sie')).not.toBeInTheDocument()
    for (const step of [1, 2, 3]) {
      expect(screen.getByRole('button', { name: new RegExp(`Schritt ${step}`) })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    }
  })

  it('reveals a step’s requirements and result on click, and reaches nothing to do it', async () => {
    const user = userEvent.setup()
    render(<ProcessMapCard title="Baubewilligungsverfahren" steps={VERFAHREN} current_step={2} />)

    expect(screen.queryByText('Einreichplan')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Schritt 1/ }))

    expect(screen.getByText('Einreichplan')).toBeInTheDocument()
    expect(screen.getByText('Aktenzeichen')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(chatSendFn).not.toHaveBeenCalled()
    expect(setComposerPrefill).not.toHaveBeenCalled()
  })

  it('keeps saying where the project actually is inside the panel of another step', async () => {
    const user = userEvent.setup()
    render(<ProcessMapCard title="Baubewilligungsverfahren" steps={VERFAHREN} current_step={2} />)

    await user.click(screen.getByRole('button', { name: /Schritt 3/ }))

    // The correcting sentence rides inside the opened panel, so it survives a
    // crop of that rectangle alone — and the chip never moves off step 2.
    expect(screen.getByText(/dieses Projekt steht bei Schritt 2: Bauverhandlung/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Schritt 2/ })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('hier stehen Sie')).toBeInTheDocument()
  })

  it('shows one step at a time, so picking a case is a selection and not five toggles', async () => {
    const user = userEvent.setup()
    render(<ProcessMapCard title="Baubewilligungsverfahren" steps={VERFAHREN} current_step={2} />)

    await user.click(screen.getByRole('button', { name: /Schritt 1/ }))

    expect(screen.getByRole('button', { name: /Schritt 1/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /Schritt 2/ })).toHaveAttribute('aria-expanded', 'false')
  })
})
