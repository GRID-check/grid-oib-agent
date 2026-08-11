import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@/test-utils'

// Mock the API client — preserve the real SkillApiError/types, stub the fns.
vi.mock('@/adapters/api/skills-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/skills-client')>()
  return {
    ...actual,
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    deleteSkill: vi.fn(),
  }
})

// Toasts are asserted through the mock (no <Toaster /> in these renders).
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { toast } from 'sonner'
import * as client from '@/adapters/api/skills-client'
import { SkillEditorDialog } from './skill-editor-dialog'

const createSkillMock = vi.mocked(client.createSkill)
const updateSkillMock = vi.mocked(client.updateSkill)
const deleteSkillMock = vi.mocked(client.deleteSkill)

const orgSkill: client.SkillListItem = {
  id: 'skill-1',
  name: 'acoustic-report',
  description: 'Drafts the acoustic compliance report.',
  body: 'Draft a report on sound insulation per OIB Richtlinie 5.',
  // 'grid-agents' is an opaque key the UI must never touch (preserved as-is).
  metadata: { 'grid-execution': 'deep-research', 'grid-agents': 'voice-ana' },
  origin: 'org',
  enabled: true,
  clonedFrom: null,
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
}

const noop = () => {}

const dialogProps = {
  open: true,
  onOpenChange: noop,
  onSaved: noop,
}

describe('SkillEditorDialog — create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('renders the authoring form and validates the name shape', async () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    expect(screen.getByText('New skill')).toBeInTheDocument()
    // Errors surface only after the user has touched a field.
    expect(
      screen.queryByText(
        'Skill names must be lowercase a-z/0-9 separated by single hyphens (no leading, trailing or consecutive hyphens).',
      ),
    ).not.toBeInTheDocument()

    const name = screen.getByLabelText(/^Name/)
    fireEvent.change(name, { target: { value: 'UPPER CASE' } })
    fireEvent.blur(name)

    await waitFor(() =>
      expect(
        screen.getByText(
          'Skill names must be lowercase a-z/0-9 separated by single hyphens (no leading, trailing or consecutive hyphens).',
        ),
      ).toBeInTheDocument(),
    )
  })

  test('creating sends the deterministic default metadata and calls createSkill', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    const payload = createSkillMock.mock.calls[0][0]
    expect(payload.name).toBe('oib-fire-check')
    expect(payload.body).toBe('Act as a fire-safety reviewer.')
    expect(payload.clonedFrom).toBeUndefined()
    // The editor always sends a deterministic execution value so the resolved
    // mode cannot drift from what it showed; schedulable stays default-on.
    expect(payload.metadata).toEqual({ 'grid-execution': 'chat' })
    expect(payload.enabled).toBe(true)
    expect(toast.success).toHaveBeenCalledWith('Skill created.')
  })

  test('deep-research plus schedulable-off are written into the reserved keys', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    // Fill the required text fields first so the form can submit.
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'acoustic-report' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Drafts the report.' },
    })
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Draft the report.' },
    })

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Deep research' }))

    const switches = screen.getAllByRole('switch')
    // First switch = schedulable; second = enabled.
    fireEvent.click(switches[0])

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    const payload = createSkillMock.mock.calls[0][0]
    expect(payload.metadata).toEqual({
      'grid-execution': 'deep-research',
      'grid-schedulable': 'false',
    })
  })

  test('picked output cards land in grid-cards and in the SKILL.md preview', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    // No preference until the author expresses one.
    expect(
      screen.getByText('No preference — the agent picks the card that fits the answer.'),
    ).toBeInTheDocument()

    const search = screen.getByLabelText('Search cards, e.g. comparison or escape route')
    fireEvent.change(search, { target: { value: 'comparison' } })
    fireEvent.click(screen.getByRole('button', { name: /^comparison_table/ }))

    // The preview is the author's proof that the choice is stored.
    await waitFor(() =>
      expect(screen.getByText(/grid-cards: comparison_table/)).toBeInTheDocument(),
    )

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0].metadata).toEqual({
      'grid-execution': 'chat',
      'grid-cards': 'comparison_table',
    })
  })

  test('the picker never offers a system card type', () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    const search = screen.getByLabelText('Search cards, e.g. comparison or escape route')
    // Both are real union members the renderer knows; neither may be requested.
    for (const systemCard of ['memory_proposal', 'document_grid']) {
      fireEvent.change(search, { target: { value: systemCard } })
      expect(screen.getByText('No card matches that search.')).toBeInTheDocument()
    }
  })

  test('cloning flags the payload with clonedFrom and shows the source', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} cloneFrom="oib-fire-check" />)

    expect(screen.getByRole('heading', { name: 'New skill' })).toBeInTheDocument()
    expect(
      screen.getByText(/Cloned from .oib-fire-check/),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Adapted copy.' },
    })
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Adapted instruction.' },
    })

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0].clonedFrom).toBe('oib-fire-check')
  })

  test('a save failure surfaces inline and as an error toast', async () => {
    createSkillMock.mockRejectedValue(new Error('boom'))
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The skill could not be saved.'))
    expect(screen.getByText('The skill could not be saved.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save skill' })).toBeEnabled()
  })
})

describe('SkillEditorDialog — edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('prefills every field and preserves opaque metadata on save', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={orgSkill} />)

    expect(screen.getByRole('heading', { name: 'Edit skill' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Name/)).toHaveValue('acoustic-report')
    expect(screen.getByLabelText(/^Description/)).toHaveValue('Drafts the acoustic compliance report.')
    // Execution mode reflects the skill's reserved metadata.
    expect(screen.getByRole('combobox')).toHaveTextContent('Deep research')

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    const [skillId, payload] = updateSkillMock.mock.calls[0]
    expect(skillId).toBe('skill-1')
    // Reserved keys are rewritten deterministically; opaque keys pass through.
    expect(payload.metadata).toEqual({
      'grid-execution': 'deep-research',
      'grid-agents': 'voice-ana',
    })
    expect(toast.success).toHaveBeenCalledWith('Skill saved.')
  })

  test('prefills the card chips and drops the key when the last one is removed', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    render(
      <SkillEditorDialog
        {...dialogProps}
        skill={{ ...orgSkill, metadata: { ...orgSkill.metadata, 'grid-cards': 'summary' } }}
      />,
    )

    expect(screen.getByText('A concise overview of the answer for the user.')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove card type “summary” from the preference' }),
    )

    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    // No preference is the ABSENCE of the key, not an empty value.
    expect(updateSkillMock.mock.calls[0][1].metadata).toEqual({
      'grid-execution': 'deep-research',
      'grid-agents': 'voice-ana',
    })
  })

  test('the delete flow removes the skill after confirmation', async () => {
    deleteSkillMock.mockResolvedValue()
    const onSaved = vi.fn()
    render(<SkillEditorDialog {...dialogProps} skill={orgSkill} onSaved={onSaved} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete skill' }))

    await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith('skill-1'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })
})