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
    reviewSkill: vi.fn(),
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
const reviewSkillMock = vi.mocked(client.reviewSkill)

/**
 * The builder is a stepped form (name+description → instructions → check), so
 * the helpers below walk it the way a person does. A spec that reached into
 * step 3's controls while step 1 was on screen would be asserting about a
 * surface nobody can be looking at.
 */
const STEP_TESTID = { 1: 'skill-step-what', 2: 'skill-step-instructions', 3: 'skill-step-check' }

/**
 * Put the wanted step on screen, forwards or back.
 *
 * Absolute rather than "press Weiter n times": a test that has already filled
 * the body is on step 2, and one that has run the check is on step 3, so a
 * relative helper overshoots depending on what ran before it. Forwards is
 * „Weiter"; backwards is the stepper's own circle, which is exactly how a
 * person returns to a step they have already visited.
 */
function goToStep(n: 1 | 2 | 3): void {
  for (let guard = 0; guard < 6; guard += 1) {
    if (screen.queryByTestId(STEP_TESTID[n])) return
    const back = screen.queryByRole('button', { name: new RegExp(`^${n}\\.`) })
    if (back && !back.hasAttribute('disabled')) {
      fireEvent.click(back)
      continue
    }
    const next = screen.queryByTestId('skill-next')
    if (!next) return
    fireEvent.click(next)
  }
}

/**
 * Run the skill check, which the save waits on.
 *
 * A skill is an instruction the model acts on unsupervised, and the reviewer
 * is the only reader that can say whether its description will ever be
 * matched — so running it is a step, not a button beside the form. Every test
 * that saves therefore takes the step a person takes.
 */
async function passTheCheck(): Promise<void> {
  fireEvent.click(screen.getByTestId('skill-review-run'))
  await waitFor(() => expect(reviewSkillMock).toHaveBeenCalled())
}

/** Walk to the last step and run the check, which is what unlocks the save. */
async function reachTheSave(): Promise<void> {
  goToStep(3)
  await passTheCheck()
}

/**
 * Open the last step's „Erweitert".
 *
 * Agents, cards, category and the two switches live behind it. That is the
 * stripping-down the rebuild was for: they used to sit in a rail at the same
 * weight as the description, which is the one field that decides whether the
 * skill is ever picked. A test that reaches them takes the same two gestures
 * an author does.
 */
function openAdvanced(): void {
  goToStep(3)
  fireEvent.click(screen.getByTestId('skill-advanced'))
}

const orgSkill: client.SkillListItem = {
  id: 'skill-1',
  name: 'acoustic-report',
  description: 'Drafts the acoustic compliance report.',
  body: 'Draft a report on sound insulation per OIB Richtlinie 5.',
  // Two leftovers, both of which must simply SURVIVE a save. 'voice-ana' is
  // not an agent, so the scope reads as "both agents"; 'grid-execution' is not
  // a reserved key any more (scheduling belongs to a job), so it is ordinary
  // free-form metadata the editor must carry through untouched rather than
  // tidy away on the author's behalf.
  metadata: { 'grid-execution': 'deep-research', 'grid-agents': 'voice-ana' },
  origin: 'org',
  enabled: true,
  clonedFrom: null,
  categoryId: null,
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
    reviewSkillMock.mockResolvedValue({ findings: [] })
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
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    const payload = createSkillMock.mock.calls[0][0]
    expect(payload.name).toBe('oib-fire-check')
    expect(payload.body).toBe('Act as a fire-safety reviewer.')
    expect(payload.clonedFrom).toBeUndefined()
    // A new skill writes NO reserved metadata at all: both agents is the
    // default (so no `grid-agents`), hidden is off (so no `grid-hidden`), no
    // card preference, and nothing about time or output — a skill does not
    // know when a job runs.
    expect(payload.metadata).toEqual({})
    expect(payload.enabled).toBe(true)
    expect(toast.success).toHaveBeenCalledWith('Skill created.')
  })

  // Which skills the model may pick is the model's business (ADR-0060). The
  // switch that took one out of the catalog is gone, and the editor must not
  // grow another way to write the key.
  test('offers nothing that decides whether the model may pick the skill', () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)
    expect(screen.queryByRole('switch', { name: /may pick/i })).not.toBeInTheDocument()
  })

  test('turning hidden on writes grid-hidden true', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'house-voice' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'How a Piloti answer is built.' },
    })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Answer first, caveats after.' },
    })

    openAdvanced()
    expect(screen.getByRole('switch', { name: 'Keep off the live line' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'Keep off the live line' }))

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0].metadata).toEqual({
      'grid-hidden': 'true',
    })
  })

  test('offers nothing about time or output — that belongs to a job', async () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    // These three controls moved to the Jobs builder with the concepts they
    // configure. A skill that could still declare them would be declaring
    // something no longer read.
    expect(screen.queryByRole('combobox', { name: 'Output' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Schedulable' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Deep-research report/)).not.toBeInTheDocument()
  })

  test('both agents is the default, and the default writes no grid-agents key', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Checks stuff.' } })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), { target: { value: 'Review it.' } })

    openAdvanced()
    expect(screen.getByRole('checkbox', { name: /Chat agent/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Deep research agent/ })).toBeChecked()

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    // "Every agent" is the ABSENCE of the key. Writing both names would mean
    // the same thing while reading as a restriction somebody chose.
    expect(createSkillMock.mock.calls[0][0].metadata).not.toHaveProperty('grid-agents')
  })

  test('narrowing the scope writes grid-agents, and the last agent cannot be removed', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'sandbox-writer' } })
    fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'Writes files.' } })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), { target: { value: 'Use execute.' } })

    openAdvanced()
    fireEvent.click(screen.getByRole('checkbox', { name: /Chat agent/ }))

    // Available to no agent is not a state grid-agents can express — an empty
    // allowlist reads as "all agents" to both resolvers — so the last one holds.
    const remaining = screen.getByRole('checkbox', { name: /Deep research agent/ })
    expect(remaining).toBeDisabled()

    await waitFor(() =>
      expect(screen.getByText(/grid-agents: deep_researcher/)).toBeInTheDocument(),
    )

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0].metadata).toEqual({
      'grid-agents': 'deep_researcher',
    })
  })

  test('picked output cards land in grid-cards and in the SKILL.md preview', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    // No preference until the author expresses one.
    openAdvanced()
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

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0].metadata).toEqual({
      'grid-cards': 'comparison_table',
    })
  })

  test('the picker never offers a system card type', () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    openAdvanced()
    const search = screen.getByLabelText('Search cards, e.g. comparison or escape route')
    // Both are real union members the renderer knows; neither may be requested.
    for (const systemCard of ['memory_proposal', 'document_grid']) {
      fireEvent.change(search, { target: { value: systemCard } })
      expect(screen.getByText('No card matches that search.')).toBeInTheDocument()
    }
  })

  /**
   * There is no clone any more, and this dialog no longer writes `clonedFrom`.
   *
   * Copying a platform skill produced a second skill frozen at the moment it
   * was copied — an org maintaining an instruction it never wrote, missing
   * every improvement shipped afterwards. What replaced it is a switch on the
   * offer itself (`curated-skills.tsx`), so nothing authored here is a copy of
   * anything: a skill written in this dialog is the org's own.
   */
  test('authoring never marks a skill as a copy of something else', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    expect(screen.getByRole('heading', { name: 'New skill' })).toBeInTheDocument()
    expect(screen.queryByText(/clone/i)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0].clonedFrom).toBeUndefined()
  })

  test('a save failure surfaces inline and as an error toast', async () => {
    createSkillMock.mockRejectedValue(new Error('boom'))
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    await reachTheSave()
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
    reviewSkillMock.mockResolvedValue({ findings: [] })
  })

  test('prefills every field and preserves opaque metadata on save', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={orgSkill} />)

    expect(screen.getByRole('heading', { name: 'Edit skill' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^Name/)).toHaveValue('acoustic-report')
    expect(screen.getByLabelText(/^Description/)).toHaveValue('Drafts the acoustic compliance report.')
    // `grid-agents: voice-ana` names no known agent, so the scope is "both".
    openAdvanced()
    expect(screen.getByRole('checkbox', { name: /Chat agent/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Deep research agent/ })).toBeChecked()

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    const [skillId, payload] = updateSkillMock.mock.calls[0]
    expect(skillId).toBe('skill-1')
    // Keys the editor owns are rewritten deterministically; everything else —
    // including the stale `grid-execution` this row still carries — passes
    // through untouched rather than being tidied away.
    expect(payload.metadata).toEqual({
      'grid-execution': 'deep-research',
      'grid-agents': 'voice-ana',
    })
    expect(toast.success).toHaveBeenCalledWith('Skill saved.')
  })

  test('offers the categories in a picker and saves the pick', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    const user = (await import('@testing-library/user-event')).default.setup()
    render(
      <SkillEditorDialog
        {...dialogProps}
        skill={orgSkill}
        categories={[
          { id: 'cat-1', name: 'Recherche', description: null, slug: 'research', sortOrder: 0, scope: 'platform' },
        ]}
      />,
    )

    // Unsorted until picked.
    openAdvanced()
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('Unsorted')
    await user.click(screen.getByRole('combobox', { name: 'Category' }))
    await user.click(screen.getByRole('option', { name: 'Recherche' }))

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    expect(updateSkillMock.mock.calls[0][1]).toHaveProperty('categoryId', 'cat-1')
  })

  test('creating without a pick omits the category', async () => {
    createSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={null} />)

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'oib-fire-check' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Checks fire-safety guidelines.' },
    })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Act as a fire-safety reviewer.' },
    })

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(createSkillMock).toHaveBeenCalledTimes(1))
    expect(createSkillMock.mock.calls[0][0]).not.toHaveProperty('categoryId')
  })

  test('carries a stored grid-auto-invoke through untouched, and shows no control for it', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    render(
      <SkillEditorDialog
        {...dialogProps}
        skill={{
          ...orgSkill,
          metadata: {
            ...orgSkill.metadata,
            'grid-auto-invoke': 'false',
            'grid-hidden': 'true',
          },
        }}
      />,
    )

    expect(screen.queryByRole('switch', { name: /may pick/i })).not.toBeInTheDocument()
    openAdvanced()
    expect(screen.getByRole('switch', { name: 'Keep off the live line' })).toBeChecked()

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    expect(updateSkillMock.mock.calls[0][1].metadata).toEqual({
      'grid-execution': 'deep-research',
      'grid-agents': 'voice-ana',
      'grid-auto-invoke': 'false',
      'grid-hidden': 'true',
    })
  })

  test('prefills the card chips and drops the key when the last one is removed', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    render(
      <SkillEditorDialog
        {...dialogProps}
        skill={{ ...orgSkill, metadata: { ...orgSkill.metadata, 'grid-cards': 'condition_tree' } }}
      />,
    )

    openAdvanced()
    expect(screen.getByText(/Bedingungsbaum/)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove card type “condition_tree” from the preference' }),
    )

    await reachTheSave()
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

  test('the advanced section rewrites every field from a pasted document', async () => {
    updateSkillMock.mockResolvedValue(orgSkill)
    render(<SkillEditorDialog {...dialogProps} skill={orgSkill} />)

    goToStep(2)
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))

    fireEvent.change(await screen.findByLabelText('SKILL.md document'), {
      target: {
        value: [
          '---',
          'name: geaenderter-skill',
          'description: A pasted description that says when to use it.',
          'metadata:',
          '  grid-execution: chat',
          '  grid-cards: condition_tree',
          '---',
          '',
          '# Pasted',
          '',
          'Do the pasted thing.',
        ].join('\n'),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    // The paste rewrote fields on BOTH steps, so both are checked where they
    // live — that is the claim: one control rewrites the whole document.
    expect(screen.getByLabelText(/^Instruction/)).toHaveValue('# Pasted\n\nDo the pasted thing.')
    goToStep(1)
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('geaenderter-skill'))
    expect(screen.getByLabelText(/^Description/)).toHaveValue(
      'A pasted description that says when to use it.',
    )
    // The metadata follows the document, including the keys the document
    // DROPS — `grid-agents` was in the row and is gone from the paste.
    openAdvanced()
    expect(screen.getByRole('checkbox', { name: /Chat agent/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Deep research agent/ })).toBeChecked()
    expect(screen.getByText(/Bedingungsbaum/)).toBeInTheDocument()

    await reachTheSave()
    const saveButton = screen.getByRole('button', { name: 'Save skill' })
    await waitFor(() => expect(saveButton).toBeEnabled())
    fireEvent.click(saveButton)

    await waitFor(() => expect(updateSkillMock).toHaveBeenCalledTimes(1))
    expect(updateSkillMock.mock.calls[0][1].metadata).toEqual({
      'grid-execution': 'chat',
      'grid-cards': 'condition_tree',
    })
  })

  test('a document that does not parse applies nothing', async () => {
    render(<SkillEditorDialog {...dialogProps} skill={orgSkill} />)

    goToStep(2)
    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    fireEvent.change(await screen.findByLabelText('SKILL.md document'), {
      target: { value: 'no frontmatter here' },
    })

    expect(
      screen.getByText(
        'The document does not start with a “---” block. A SKILL.md always opens with YAML frontmatter.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    goToStep(1)
    expect(screen.getByLabelText(/^Name/)).toHaveValue('acoustic-report')
  })

  test('the delete flow removes the skill after confirmation', async () => {
    deleteSkillMock.mockResolvedValue()
    const onSaved = vi.fn()
    render(<SkillEditorDialog {...dialogProps} skill={orgSkill} onSaved={onSaved} />)

    goToStep(3)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete skill' }))

    await waitFor(() => expect(deleteSkillMock).toHaveBeenCalledWith('skill-1'))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })
})

/**
 * The check is a step, not an ornament.
 *
 * A skill is an instruction the model acts on with nobody watching, and the
 * failure an author cannot see from inside the form is a description that never
 * gets matched — which is exactly what the reviewer reads for. A button beside
 * the form is a button nobody presses.
 */
describe('the skill check gates the save', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reviewSkillMock.mockResolvedValue({ findings: [] })
  })

  /** A complete draft, filled the way a person fills it: step by step. */
  const fill = (): void => {
    goToStep(1)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'einreichcheck' } })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Was diesem Bauansuchen noch fehlt.' },
    })
    goToStep(2)
    fireEvent.change(screen.getByLabelText(/^Instruction/), {
      target: { value: 'Walk the missing Unterlagen.' },
    })
    goToStep(3)
  }

  test('a complete, valid draft still cannot be saved until it has been checked', () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)
    fill()
    expect(screen.getByRole('button', { name: 'Save skill' })).toBeDisabled()
    // Greying a button without saying why is a dead end; the reason is a step.
    expect(screen.getByTestId('skill-review-required')).toBeInTheDocument()
  })

  test('running the check opens the save', async () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)
    fill()
    await passTheCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save skill' })).toBeEnabled())
  })

  // What the reviewer SAYS is not a condition. Blocking on a model's verdict
  // would be the forcing this codebase removed everywhere else, aimed at the
  // author rather than the agent.
  test('findings do not block the save — the author weighs them', async () => {
    reviewSkillMock.mockResolvedValue({
      findings: [
        {
          severity: 'error',
          field: 'description',
          message: 'Says nothing about when to use it.',
          fix: 'Name the situation it answers.',
        },
      ],
    })
    render(<SkillEditorDialog {...dialogProps} skill={null} />)
    fill()
    await passTheCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save skill' })).toBeEnabled())
  })

  // Our outage is not the author's to pay for with an unsaveable draft.
  test('a reviewer that could not run blocks nothing', async () => {
    reviewSkillMock.mockResolvedValue({ findings: null })
    render(<SkillEditorDialog {...dialogProps} skill={null} />)
    fill()
    await passTheCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save skill' })).toBeEnabled())
  })

  // A verdict on an older draft is not a verdict on this one.
  test('editing after a check closes the gate again', async () => {
    render(<SkillEditorDialog {...dialogProps} skill={null} />)
    fill()
    await passTheCheck()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save skill' })).toBeEnabled())

    goToStep(1)
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'Etwas ganz anderes.' },
    })
    goToStep(3)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save skill' })).toBeDisabled())
    expect(screen.getByTestId('skill-review-stale')).toBeInTheDocument()
  })
})
