/**
 * The chip makes the same single promise `follow_ups` makes, so the tests that
 * matter are the negative ones — a click fetches nothing and sends nothing —
 * next to the proof that the sentence which reaches the composer is the whole,
 * sendable German question built from the row's own words, and that a row with
 * nothing to build from offers no chip at all.
 *
 * Both call sites are exercised through their real components rather than the
 * chip alone: the point of the feature is that a `needs_input` row IS the
 * question, and a chip that renders in isolation but never appears on a row
 * would pass a test of the chip and fail the reader.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { I18nProvider } from '@/i18n'
import { AskAboutChip } from './AskAboutChip'
import { RequirementChecklistCard } from './RequirementChecklistCard'
import { DimChecksList } from '../schematics/kit'

const setComposerPrefill = vi.fn()
const chatSendFn = vi.fn()

const mockStoreState = () => ({ setComposerPrefill, chatSendFn })

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) =>
    selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

/** German, pinned: the sentence under test is the German one, on every machine. */
const renderDe = (ui: ReactElement) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>,
  )

const CHIP = 'Dazu fragen'

describe('AskAboutChip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds a complete question out of the row and prefills it verbatim', async () => {
    const user = userEvent.setup()
    renderDe(
      <AskAboutChip
        subject="Handlauf beidseitig"
        missing="Dieser Export enthält kein IfcRailing — Handläufe im CAD als IfcRailing modellieren."
      />,
    )

    await user.click(screen.getByRole('button', { name: /Handlauf beidseitig/ }))

    // The row's own words, one sentence, sendable as it stands — and the
    // remedy's trailing full stop does not collide with the template's own.
    expect(setComposerPrefill).toHaveBeenCalledWith(
      'Bei „Handlauf beidseitig“ fehlt eine Angabe: Dieser Export enthält kein IfcRailing — ' +
        'Handläufe im CAD als IfcRailing modellieren. Wie kann ich das nachreichen, und was gilt bis dahin?',
    )
  })

  it('asks what is needed when the row names no remedy', async () => {
    const user = userEvent.setup()
    renderDe(<AskAboutChip subject="Brandmeldeanlage Kategorie 1" />)

    await user.click(screen.getByRole('button', { name: /Brandmeldeanlage/ }))

    expect(setComposerPrefill).toHaveBeenCalledWith(
      'Bei „Brandmeldeanlage Kategorie 1“ fehlt eine Angabe. ' +
        'Welche Angabe wird dafür benötigt, und woher bekomme ich sie?',
    )
  })

  it('renders nothing rather than a question with a hole in it', () => {
    // A subject too short to name anything would produce „Bei „—“ fehlt eine
    // Angabe …", which is a template showing through, not a question.
    const { container } = renderDe(<AskAboutChip subject="  " missing="egal" />)
    expect(container.querySelector('button')).toBeNull()

    const { container: second } = renderDe(<AskAboutChip subject={null} />)
    expect(second.querySelector('button')).toBeNull()
  })

  it('sends nothing and fetches nothing on click', async () => {
    const user = userEvent.setup()
    renderDe(<AskAboutChip subject="Handlauf beidseitig" missing="kein IfcRailing im Export" />)

    await user.click(screen.getByRole('button', { name: /Handlauf beidseitig/ }))

    // „nicht zurück zum LLM" — the chip queues a draft the user can ignore.
    expect(chatSendFn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup()
    renderDe(<AskAboutChip subject="Handlauf beidseitig" missing="kein IfcRailing im Export" />)

    await user.tab()
    expect(screen.getByRole('button', { name: /Handlauf beidseitig/ })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(setComposerPrefill).toHaveBeenCalledTimes(1)
  })

  it('carries the whole question in the tooltip', () => {
    renderDe(<AskAboutChip subject="Handlauf beidseitig" missing="kein IfcRailing im Export" />)

    expect(screen.getByRole('button', { name: /Handlauf beidseitig/ })).toHaveAttribute(
      'title',
      'Bei „Handlauf beidseitig“ fehlt eine Angabe: kein IfcRailing im Export. ' +
        'Wie kann ich das nachreichen, und was gilt bis dahin?',
    )
  })
})

describe('the checklist offers the question only where a row is undecided', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const items = [
    {
      label: 'Tragende Bauteile REI 60',
      status: 'pass' as const,
      detail: 'Stahlbetondecken und -wände erfüllen REI 90.',
    },
    {
      label: 'Treppenhaus als gesicherter Fluchtbereich',
      status: 'fail' as const,
      detail: 'Derzeit keine rauchdichte Abtrennung im EG vorgesehen.',
    },
    {
      label: 'Zweiter Fluchtweg oder Anleiterbarkeit',
      status: 'needs_input' as const,
      detail: 'Anleiterbarkeit der Nordfassade noch nicht geklärt.',
    },
  ]

  it('offers exactly one chip, on the row that cannot be decided', async () => {
    const user = userEvent.setup()
    renderDe(
      <RequirementChecklistCard
        title="Anforderungen GK 4 – Brandschutz"
        items={items}
        reference={{ document: 'OIB-Richtlinie 2' }}
        note={null}
      />,
    )

    // A decided row — pass or fail — has no missing input to ask about, so it
    // gets no chip; four of them would be decoration.
    expect(screen.getAllByText(CHIP)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /Zweiter Fluchtweg/ }))

    expect(setComposerPrefill).toHaveBeenCalledWith(
      'Bei „Zweiter Fluchtweg oder Anleiterbarkeit“ fehlt eine Angabe: ' +
        'Anleiterbarkeit der Nordfassade noch nicht geklärt. ' +
        'Wie kann ich das nachreichen, und was gilt bis dahin?',
    )
    expect(chatSendFn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('a schematic legend offers the question next to the remedy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prefills the CAD remedy the row already names', async () => {
    const user = userEvent.setup()
    renderDe(
      <DimChecksList
        checks={[
          { label: 'Neigung', value: 7.2, required: 6, unit: '%', comparator: '<=', status: 'fail' },
          {
            label: 'Handlauf beidseitig',
            value: null,
            unit: 'cm',
            status: 'needs_input',
            missing:
              'Dieser Export enthält kein IfcRailing — Handläufe im CAD als IfcRailing modellieren.',
          },
        ]}
      />,
    )

    expect(screen.getAllByText(CHIP)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: /Handlauf beidseitig/ }))

    expect(setComposerPrefill).toHaveBeenCalledWith(
      'Bei „Handlauf beidseitig“ fehlt eine Angabe: Dieser Export enthält kein IfcRailing — ' +
        'Handläufe im CAD als IfcRailing modellieren. Wie kann ich das nachreichen, und was gilt bis dahin?',
    )
    expect(chatSendFn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  describe('trailing-mark stripping is linear in the length of the label', () => {
    /**
     * `tidy` used to strip the trailing run with `/[.,;:!?…]+$/`. That pattern is
     * anchored at the end but may begin at any position, so on a label of many
     * marks the engine retries from each one and the scan is quadratic — 32k
     * colons took 1,007ms against 0.2ms for the loop that replaced it. The label
     * is written by the model into a card row, so its length and shape are not
     * ours to bound.
     *
     * An absolute budget, not a ratio between two sizes: healthy timings here
     * are microseconds and a ratio of two of those is noise rather than signal.
     */
    it('does not stall on a label that is all sentence marks', () => {
      const started = performance.now()

      renderDe(<AskAboutChip subject={`Neigung${':'.repeat(32_000)}-`} missing="Wert fehlt" />)
      const elapsed = performance.now() - started

      expect(elapsed).toBeLessThan(400)
    })

    it('still drops the trailing mark so the template punctuation stands alone', async () => {
      const user = userEvent.setup()
      renderDe(<AskAboutChip subject="Handlauf beidseitig." missing="Im CAD modellieren." />)

      await user.click(screen.getByRole('button'))

      const [sent] = setComposerPrefill.mock.calls.at(-1) as [string]
      expect(sent).not.toContain('..')
      expect(sent).toContain('„Handlauf beidseitig“')
    })
  })
})
