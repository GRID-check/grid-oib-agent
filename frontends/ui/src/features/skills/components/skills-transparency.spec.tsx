/**
 * The two surfaces that make skill loading visible: the chip that says a skill
 * is attached to the message being written, and the disclosure that says which
 * skills the agent actually loaded while answering.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InvokedSkillChip } from './InvokedSkillChip'
import { SkillsUsedDisclosure } from './SkillsUsedDisclosure'
import { NATSystemResponseMessageSchema } from '@/adapters/api/schemas'

vi.mock('@/i18n', () => ({
  useTranslations: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(',')}` : key,
  useLocale: () => 'en',
}))

const listInvocableSkills = vi.fn()
vi.mock('@/adapters/api/skills-client', () => ({
  listInvocableSkills: (...args: unknown[]) => listInvocableSkills(...args),
}))

beforeEach(() => {
  listInvocableSkills.mockReset()
  listInvocableSkills.mockResolvedValue([
    { name: 'oib-brandschutz', description: 'Prüft Brandschutz nach OIB-RL 2.', origin: 'org' },
  ])
})

describe('InvokedSkillChip', () => {
  it('names the skill and states the consequence, not just the name', () => {
    render(
      <InvokedSkillChip name="oib-brandschutz" description="Prüft Brandschutz nach OIB-RL 2." />,
    )
    expect(screen.getByTestId('invoked-skill-chip')).toBeInTheDocument()
    expect(screen.getByText('composer.invoked.label:oib-brandschutz')).toBeInTheDocument()
    // The description is what confirms the RIGHT skill was picked.
    expect(screen.getByText('Prüft Brandschutz nach OIB-RL 2.')).toBeInTheDocument()
    // …and the mechanism is stated, because "instructions will be loaded" is
    // not something the token in the textarea can convey on its own.
    expect(screen.getByText('composer.invoked.hint')).toBeInTheDocument()
  })

  it('offers removal only where the composer can be edited', () => {
    const onRemove = vi.fn()
    const { rerender } = render(
      <InvokedSkillChip name="oib-brandschutz" description="d" onRemove={onRemove} />,
    )
    expect(screen.getByRole('button')).toBeInTheDocument()

    rerender(<InvokedSkillChip name="oib-brandschutz" description="d" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('SkillsUsedDisclosure', () => {
  it('renders nothing when the turn activated no skills', () => {
    const { container } = render(<SkillsUsedDisclosure skillsActivated={[]} />)
    expect(container).toBeEmptyDOMElement()

    const { container: none } = render(<SkillsUsedDisclosure />)
    expect(none).toBeEmptyDOMElement()
  })

  it('summarises without fetching anything until it is opened', () => {
    render(<SkillsUsedDisclosure skillsActivated={['oib-brandschutz']} />)
    expect(screen.getByTestId('skills-used-trigger')).toHaveTextContent('composer.activated.one')
    // Descriptions are a separate org-scoped read; paying for it on every
    // rendered answer would be exactly the eager loading skills avoid.
    expect(listInvocableSkills).not.toHaveBeenCalled()
  })

  it('pluralises on the count', () => {
    render(<SkillsUsedDisclosure skillsActivated={['a', 'b']} />)
    expect(screen.getByTestId('skills-used-trigger')).toHaveTextContent('composer.activated.other:2')
  })

  it('explains the mechanism and names the skills once opened', async () => {
    const user = userEvent.setup()
    render(<SkillsUsedDisclosure skillsActivated={['oib-brandschutz']} />)

    await user.click(screen.getByTestId('skills-used-trigger'))

    const panel = await screen.findByTestId('skills-used-panel')
    expect(panel).toHaveTextContent('oib-brandschutz')
    expect(panel).toHaveTextContent('composer.activated.explainer')
    expect(listInvocableSkills).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Prüft Brandschutz nach OIB-RL 2.')).toBeInTheDocument()
  })

  it('keeps a row whose skill can no longer be described', async () => {
    // Deleted or renamed since the answer was written: the NAME is still true,
    // so the row stays rather than vanishing from the record.
    listInvocableSkills.mockResolvedValue([])
    const user = userEvent.setup()
    render(<SkillsUsedDisclosure skillsActivated={['gone-since']} />)

    await user.click(screen.getByTestId('skills-used-trigger'))
    expect(await screen.findByTestId('skills-used-panel')).toHaveTextContent('gone-since')
  })
})

describe('the skills_activated wire field', () => {
  const frame = (extra: Record<string, unknown>) => ({
    type: 'system_response_message',
    id: 'm1',
    status: 'complete',
    content: { text: 'answer' },
    ...extra,
  })

  it('is lifted off the terminal frame', () => {
    const parsed = NATSystemResponseMessageSchema.parse(
      frame({ skills_activated: ['oib-brandschutz', 'projekt-zusammenfassung'] }),
    )
    expect(parsed.skills_activated).toEqual(['oib-brandschutz', 'projekt-zusammenfassung'])
  })

  it('is simply absent on a turn that activated none', () => {
    expect(NATSystemResponseMessageSchema.parse(frame({})).skills_activated).toBeUndefined()
  })

  it('degrades to absent rather than killing the frame when malformed', () => {
    // Per-field `.catch(undefined)`, like every other transparency extra: the
    // answer text must survive a bad extra.
    const parsed = NATSystemResponseMessageSchema.parse(frame({ skills_activated: 'not-an-array' }))
    expect(parsed.skills_activated).toBeUndefined()
    expect(parsed.content).toEqual({ text: 'answer' })
  })
})
