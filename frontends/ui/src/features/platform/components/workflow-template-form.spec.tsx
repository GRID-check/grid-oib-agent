import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkflowTemplateForm, type TemplateFormSeed } from './workflow-template-form'
import type { CreatePlatformTemplateInput, PlatformTemplate } from '@/adapters/api/platform-workflow-templates-client'

const SOURCES = [
  { id: 'knowledge_layer', name: 'Base knowledge' },
  { id: 'ris', name: 'RIS', description: 'Austrian legal information system' },
  { id: 'web_search', name: 'Web search' },
]

vi.mock('@/adapters/api/data-sources-client', () => ({
  createDataSourcesClient: () => ({
    getDataSources: async () => ({ data_sources: SOURCES, knowledge_layer: true, vlm_available: false }),
  }),
}))

const TEMPLATE: PlatformTemplate = {
  id: 'tpl-1',
  provenance: 'law',
  dataSources: ['ris'],
  agentType: 'deep_researcher',
  scheduleCron: '0 6 * * 1',
  scheduleTimezone: 'Europe/Vienna',
  published: true,
  sortOrder: 3,
  createdByEmail: 'owner@grid.example',
  createdAt: '2026-07-10T09:00:00Z',
  updatedAt: '2026-07-20T09:00:00Z',
  content: {
    de: {
      name: 'Richtlinien-Monitoring',
      description: 'Deutsche Kurzbeschreibung.',
      category: 'Recht',
      definition: {
        version: 1,
        blocks: { objective: 'Neue Richtlinien überwachen.', questions: ['Was ist neu?', 'Wen betrifft es?'] },
      },
    },
    en: {
      name: 'Regulation monitor',
      description: 'Watches for new guidelines.',
      category: 'Compliance',
      definition: { version: 1, blocks: { objective: 'Watch for new guidelines.' } },
    },
  },
}

/** Fill one locale tab completely; the form requires all four fields per language. */
async function fillLocale(
  user: ReturnType<typeof userEvent.setup>,
  values: { name: string; description: string; category: string; objective: string },
) {
  await user.type(screen.getByLabelText('Name'), values.name)
  await user.type(screen.getByLabelText('Short description'), values.description)
  await user.type(screen.getByLabelText('Category label'), values.category)
  await user.type(screen.getByLabelText('Objective'), values.objective)
}

function renderForm(
  overrides: {
    template?: PlatformTemplate | null
    seed?: TemplateFormSeed | null
    onSubmit?: (input: CreatePlatformTemplateInput, id: string | null) => Promise<void>
  } = {},
) {
  const onSubmit = vi.fn(overrides.onSubmit ?? (async () => undefined))
  const onOpenChange = vi.fn()
  render(
    <WorkflowTemplateForm
      open
      onOpenChange={onOpenChange}
      template={overrides.template ?? null}
      seed={overrides.seed ?? null}
      onSubmit={onSubmit}
    />,
  )
  return { onSubmit, onOpenChange }
}

describe('WorkflowTemplateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('authors in a Sheet, opening on the German tab', async () => {
    renderForm()

    expect(await screen.findByText('New workflow template')).toBeDefined()
    expect(screen.getByRole('tab', { name: 'German' })).toHaveAttribute('data-state', 'active')
    expect(screen.getByRole('button', { name: 'Close editor' })).toBeDefined()
  })

  test('refuses to save until BOTH languages are complete, and names the one that is not', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await fillLocale(user, {
      name: 'Richtlinien-Monitoring',
      description: 'Beschreibung.',
      category: 'Recht',
      objective: 'Ziel.',
    })
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'English: name, short description, category label and objective are all required.',
    )
    expect(onSubmit).not.toHaveBeenCalled()
    // The message and the view agree: the incomplete language is now on screen.
    expect(screen.getByRole('tab', { name: 'English' })).toHaveAttribute('data-state', 'active')

    await fillLocale(user, {
      name: 'Regulation monitor',
      description: 'Description.',
      category: 'Compliance',
      objective: 'Objective.',
    })
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [input, id] = onSubmit.mock.calls[0]
    expect(id).toBeNull()
    expect(input.content.de.name).toBe('Richtlinien-Monitoring')
    expect(input.content.en.name).toBe('Regulation monitor')
  })

  test('a missing objective alone blocks the save', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.type(screen.getByLabelText('Name'), 'Name')
    await user.type(screen.getByLabelText('Short description'), 'Beschreibung.')
    await user.type(screen.getByLabelText('Category label'), 'Recht')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('German:')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('previews the compiled brief per locale, live', async () => {
    const user = userEvent.setup()
    renderForm({ template: TEMPLATE })

    // German carries research questions; the compiled brief numbers them.
    const de = await screen.findByTestId('template-preview-de')
    expect(de.textContent).toContain('# Objective')
    expect(de.textContent).toContain('1. Was ist neu?')

    // Editing updates the preview without a save.
    await user.type(screen.getByLabelText('Background & context'), 'Wien')
    await waitFor(() => expect(screen.getByTestId('template-preview-de').textContent).toContain('Wien'))

    // Each locale previews its OWN text, not the active tab's.
    await user.click(screen.getByRole('tab', { name: 'English' }))
    const en = await screen.findByTestId('template-preview-en')
    expect(en.textContent).toContain('Watch for new guidelines.')
    expect(en.textContent).not.toContain('Was ist neu?')
  })

  test('seeds every shared field from the template being edited and PATCHes by id', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ template: TEMPLATE })

    expect(await screen.findByText('Edit workflow template')).toBeDefined()
    expect(screen.getByLabelText('Sort order')).toHaveValue(3)
    expect(screen.getByRole('switch', { name: 'Published' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('switch', { name: 'Suggested schedule' })).toHaveAttribute(
      'data-state',
      'checked',
    )
    // The knowledge layer is always-on, so it is never offered as an extra source.
    expect(screen.queryByText('Base knowledge')).toBeNull()
    expect(screen.getByRole('checkbox', { name: /RIS/ })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [input, id] = onSubmit.mock.calls[0]
    expect(id).toBe('tpl-1')
    expect(input).toMatchObject({
      provenance: 'law',
      dataSources: ['ris'],
      scheduleCron: '0 6 * * 1',
      scheduleTimezone: 'Europe/Vienna',
      sortOrder: 3,
      published: true,
    })
    expect(input.content.de.definition.blocks.questions).toEqual(['Was ist neu?', 'Wen betrifft es?'])
  })

  test('carries a custom cron and its timezone into the payload', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ template: TEMPLATE })

    await screen.findByText('Edit workflow template')
    await user.click(screen.getByRole('combobox', { name: 'Cadence' }))
    await user.click(screen.getByRole('option', { name: 'Custom schedule' }))

    const cron = await screen.findByLabelText('Custom cron (5 fields)')
    await user.clear(cron)
    await user.type(cron, '15 4 * * 3')

    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const [input] = onSubmit.mock.calls[0]
    expect(input.scheduleCron).toBe('15 4 * * 3')
    expect(input.scheduleTimezone).toBe('Europe/Vienna')
  })

  test('turning the schedule off clears the cron rather than hiding it', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ template: TEMPLATE })

    await screen.findByText('Edit workflow template')
    await user.click(screen.getByRole('switch', { name: 'Suggested schedule' }))
    expect(screen.queryByRole('combobox', { name: 'Cadence' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].scheduleCron).toBeNull()
  })

  test('publishing is an explicit choice with its consequence spelled out', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ template: { ...TEMPLATE, published: false } })

    expect(
      await screen.findByText('When on, this template is visible in every organization’s gallery.'),
    ).toBeDefined()
    await user.click(screen.getByRole('switch', { name: 'Published' }))
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].published).toBe(true)
  })

  test('toggles additional data sources into the payload', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm({ template: TEMPLATE })

    await screen.findByText('Edit workflow template')
    await user.click(screen.getByRole('checkbox', { name: /Web search/ }))
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].dataSources).toEqual([
      'ris',
      'web_search',
    ])
  })

  test('an imported seed opens as a create, never carrying the file’s published flag', async () => {
    const seed: TemplateFormSeed = {
      provenance: 'office',
      dataSources: ['web_search'],
      scheduleCron: null,
      scheduleTimezone: 'Europe/Vienna',
      sortOrder: 7,
      published: false,
      content: TEMPLATE.content,
    }
    const { onSubmit } = renderForm({ seed })

    expect(await screen.findByText('New workflow template')).toBeDefined()
    expect(screen.getByLabelText('Name')).toHaveValue('Richtlinien-Monitoring')
    expect(screen.getByRole('switch', { name: 'Published' })).toHaveAttribute('data-state', 'unchecked')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('surfaces a save failure instead of closing on it', async () => {
    const user = userEvent.setup()
    const onSubmit = async () => {
      throw new Error('Template name already in use')
    }
    const { onOpenChange } = renderForm({ template: TEMPLATE, onSubmit })

    await screen.findByText('Edit workflow template')
    await user.click(screen.getByRole('button', { name: 'Save template' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Template name already in use')
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})
