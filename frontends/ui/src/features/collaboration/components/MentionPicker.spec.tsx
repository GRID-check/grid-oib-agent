import { createRef } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'

import { AGENT_MENTION_ID, type MentionCandidate } from '@/lib/mentions/types'
import {
  filterMentionCandidates,
  MentionPicker,
  type MentionPickerHandle,
} from './MentionPicker'

const person = (
  id: string,
  name: string,
  overrides: Partial<MentionCandidate> = {},
): MentionCandidate => ({
  targetId: id,
  person: { userId: id, name, email: `${id}@example.com`, profilePictureUrl: null },
  isAgent: false,
  isParticipant: true,
  needsInvite: false,
  ...overrides,
})

const AGENT: MentionCandidate = {
  targetId: AGENT_MENTION_ID,
  person: { userId: AGENT_MENTION_ID, name: 'Piloti', email: null, profilePictureUrl: null },
  isAgent: true,
  isParticipant: true,
  needsInvite: false,
}

const ANNA = person('u-anna', 'Anna Weber')
const MARKUS = person('u-markus', 'Markus Hofer')
const SABINE = person('u-sabine', 'Sabine Gruber', { isParticipant: false, needsInvite: true })

const CANDIDATES = [AGENT, ANNA, MARKUS, SABINE]

function renderPicker(props: Partial<Parameters<typeof MentionPicker>[0]> = {}) {
  const onSelect = props.onSelect ?? vi.fn()
  const ref = createRef<MentionPickerHandle>()
  const view = render(
    <MentionPicker
      ref={ref}
      query=""
      candidates={CANDIDATES}
      canInvite
      onSelect={onSelect}
      {...props}
    />,
  )
  return { ...view, ref, onSelect }
}

const optionNames = (): string[] =>
  screen.getAllByRole('option').map((option) => option.textContent ?? '')

describe('filterMentionCandidates — order and grouping', () => {
  test('pins the assistant first, then participants, then everyone else', () => {
    const groups = filterMentionCandidates(CANDIDATES, '', true, 'Piloti')
    expect(groups.visible.map((c) => c.targetId)).toEqual([
      AGENT_MENTION_ID,
      'u-anna',
      'u-markus',
      'u-sabine',
    ])
    expect(groups.agent).toHaveLength(1)
    expect(groups.participants.map((c) => c.targetId)).toEqual(['u-anna', 'u-markus'])
    expect(groups.others.map((c) => c.targetId)).toEqual(['u-sabine'])
  })

  test('filters on name and on email, case-insensitively', () => {
    expect(filterMentionCandidates(CANDIDATES, 'hof', true, 'Piloti').visible).toEqual([MARKUS])
    expect(filterMentionCandidates(CANDIDATES, 'U-SABINE@', true, 'Piloti').visible).toEqual([
      SABINE,
    ])
  })

  test('a row the caller cannot invite stays visible but is not selectable (MN-5)', () => {
    const groups = filterMentionCandidates(CANDIDATES, '', false, 'Piloti')
    expect(groups.visible).toContain(SABINE)
    expect(groups.selectable).not.toContain(SABINE)
  })
})

describe('MentionPicker — the rows', () => {
  test('renders every candidate as an option, assistant first', () => {
    renderPicker()
    const options = optionNames()
    expect(options).toHaveLength(4)
    expect(options[0]).toContain('Piloti')
    expect(options[0]).toContain('Ask the assistant')
    expect(options[0]).toContain('Assistant')
  })

  test('a participant carries name and email, and no badge restating its heading', () => {
    renderPicker()
    const row = screen.getByText('Anna Weber').closest('[role="option"]') as HTMLElement
    expect(within(row).getByText('u-anna@example.com')).toBeInTheDocument()
    // An ordinary participant gets NO badge. These rows only ever render inside
    // the group headed "In this chat", so a per-row "In this chat" badge could
    // never say anything the heading above it had not already said — and it
    // competed with the badges that do carry information. A badge here now means
    // the row is not ordinary.
    expect(within(row).queryByText(/In this (chat|conversation)/)).toBeNull()
    expect(screen.getByText('In this conversation')).toBeInTheDocument() // …the heading
  })

  test('someone who is not in the chat yet is offered WITH the consequence spelled out', () => {
    renderPicker()
    const row = screen.getByText('Sabine Gruber').closest('[role="option"]') as HTMLElement
    expect(within(row).getByText('Will be invited')).toBeInTheDocument()
    // The consequence is stated WITHOUT repeating her name: the row already
    // prints it on the line above, and interpolating it again read
    // "Sabine Gruber / Sabine Gruber is not in this conversation yet…".
    expect(within(row).getByText('Not in this conversation yet — will be invited.')).toBeInTheDocument()
    expect(within(row).queryByText(/Sabine Gruber is not in this conversation/)).toBeNull()
    expect(row).toHaveAttribute('aria-disabled', 'false')
  })

  test('without invite rights that row is disabled and says why — never hidden (MN-5, SH-19)', () => {
    renderPicker({ canInvite: false })
    const row = screen.getByText('Sabine Gruber').closest('[role="option"]') as HTMLElement
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(
      within(row).getByText('Only an owner can bring new people into this conversation.'),
    ).toBeInTheDocument()
  })

  test('groups carry their headings', () => {
    renderPicker()
    expect(screen.getByText('In this conversation')).toBeInTheDocument()
    expect(screen.getByText('Elsewhere in this project')).toBeInTheDocument()
  })

  test('emphasises the matched fragment inside the name', () => {
    renderPicker({ query: 'web' })
    const mark = document.querySelector('mark') as HTMLElement
    expect(mark).toBeInTheDocument()
    expect(mark.textContent).toBe('Web')
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  test('does not show the empty state while there are candidates', () => {
    renderPicker()
    expect(screen.queryByText('Nobody to mention here.')).not.toBeInTheDocument()
    expect(screen.queryByText(/^No match for/)).not.toBeInTheDocument()
  })

  test('the footer keeps the keyboard hint', () => {
    renderPicker()
    expect(screen.getByText('↑↓ to choose · ↵ to insert · Esc to close')).toBeInTheDocument()
  })

  test('the list is a labelled listbox of options (a11y)', () => {
    renderPicker()
    expect(screen.getByRole('listbox')).toHaveAttribute(
      'aria-label',
      'People you can mention',
    )
  })
})

describe('MentionPicker — states', () => {
  test('loading shows skeleton rows, not a spinner or an empty panel', () => {
    renderPicker({ loading: true, candidates: [] })
    expect(screen.getByText('Loading people…')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  test('no match for a query names the query', () => {
    renderPicker({ query: 'zzz' })
    expect(screen.getByText('No match for “zzz”')).toBeInTheDocument()
  })

  test('nobody to mention at all reads as empty, not as a failed search', () => {
    renderPicker({ candidates: [] })
    expect(screen.getByText('Nobody to mention here.')).toBeInTheDocument()
  })
})

describe('MentionPicker — selection', () => {
  test('the first selectable row is selected on open', () => {
    renderPicker()
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
  })

  test('↓ and ↑ move the selection and wrap around', () => {
    const { ref } = renderPicker()
    act(() => ref.current?.move(1))
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true')

    // Up from the top wraps to the last selectable row.
    act(() => ref.current?.move(-1))
    act(() => ref.current?.move(-1))
    expect(screen.getAllByRole('option')[3]).toHaveAttribute('aria-selected', 'true')

    act(() => ref.current?.move(1))
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  test('selectActive inserts the selected candidate and reports success', () => {
    const onSelect = vi.fn()
    const { ref } = renderPicker({ onSelect })
    act(() => ref.current?.move(1))
    let inserted: boolean | undefined
    act(() => {
      inserted = ref.current?.selectActive()
    })
    expect(inserted).toBe(true)
    expect(onSelect).toHaveBeenCalledWith(ANNA)
  })

  test('selectActive reports false when there is nothing to insert', () => {
    const onSelect = vi.fn()
    const { ref } = renderPicker({ candidates: [], onSelect })
    let inserted: boolean | undefined
    act(() => {
      inserted = ref.current?.selectActive()
    })
    expect(inserted).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('keyboard navigation skips the rows it cannot insert', () => {
    const onSelect = vi.fn()
    const { ref } = renderPicker({ canInvite: false, onSelect })
    act(() => ref.current?.move(-1))
    act(() => {
      ref.current?.selectActive()
    })
    expect(onSelect).toHaveBeenCalledWith(MARKUS)
  })

  test('clicking a row inserts it', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderPicker({ onSelect })
    await user.click(screen.getByText('Markus Hofer'))
    expect(onSelect).toHaveBeenCalledWith(MARKUS)
  })

  test('a disabled row cannot be clicked into a mention', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    renderPicker({ canInvite: false, onSelect })
    await user.click(screen.getByText('Sabine Gruber'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('hover moves the selection, so mouse and keyboard never disagree', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { ref } = renderPicker({ onSelect })
    await user.hover(screen.getByText('Markus Hofer'))
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    act(() => {
      ref.current?.selectActive()
    })
    expect(onSelect).toHaveBeenCalledWith(MARKUS)
  })

  test('a new query resets the selection to the top', () => {
    const { ref, rerender } = renderPicker()
    act(() => ref.current?.move(2))
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true')
    rerender(
      <MentionPicker ref={ref} query="a" candidates={CANDIDATES} canInvite onSelect={vi.fn()} />,
    )
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  test('reports the live listbox and active-option ids for the combobox wiring', () => {
    const onAriaChange = vi.fn()
    const { ref } = renderPicker({ onAriaChange })
    const last = () => onAriaChange.mock.calls[onAriaChange.mock.calls.length - 1][0]
    expect(last().listboxId).toBe(screen.getByRole('listbox').id)
    expect(last().activeOptionId).toBe(screen.getAllByRole('option')[0].id)

    act(() => ref.current?.move(1))
    expect(last().activeOptionId).toBe(screen.getAllByRole('option')[1].id)
  })
})
