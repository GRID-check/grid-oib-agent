import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { WorkflowTemplates } from './workflow-templates'
import type { PlatformTemplate } from '@/adapters/api/platform-workflow-templates-client'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

// The editor Sheet is mounted (closed) from the first render and fetches the
// data-source catalogue on mount; that call is not what these tests are about.
vi.mock('@/adapters/api/data-sources-client', () => ({
  createDataSourcesClient: () => ({
    getDataSources: async () => ({ data_sources: [], knowledge_layer: true, vlm_available: false }),
  }),
}))

function template(overrides: Partial<PlatformTemplate> = {}): PlatformTemplate {
  const name = overrides.id ?? 'tpl-1'
  return {
    id: 'tpl-1',
    provenance: 'law',
    dataSources: ['ris', 'web_search'],
    agentType: 'deep_researcher',
    scheduleCron: '0 6 * * 1',
    scheduleTimezone: 'Europe/Vienna',
    published: true,
    sortOrder: 0,
    createdByEmail: 'owner@grid.example',
    createdAt: '2026-07-10T09:00:00Z',
    updatedAt: '2026-07-20T09:00:00Z',
    content: {
      de: {
        name: `${name} DE`,
        description: 'Deutsche Kurzbeschreibung.',
        category: 'Recht',
        definition: { version: 1, blocks: { objective: 'Ziel.' } },
      },
      en: {
        name: 'Regulation monitor',
        description: 'Watches for new OIB guidelines.',
        category: 'Compliance',
        definition: { version: 1, blocks: { objective: 'Objective.' } },
      },
    },
    ...overrides,
  }
}

const DRAFT = template({
  id: 'tpl-2',
  published: false,
  sortOrder: 1,
  scheduleCron: null,
  dataSources: [],
  content: {
    de: {
      name: 'Entwurf DE',
      description: 'Entwurf.',
      category: 'Projekt',
      definition: { version: 1, blocks: { objective: 'Ziel.' } },
    },
    en: {
      name: 'Documentation check',
      description: 'Looks for gaps in project documents.',
      category: 'Project',
      definition: { version: 1, blocks: { objective: 'Objective.' } },
    },
  },
})

/** A fetch double that answers the four platform-template routes by method. */
function apiFetch(rows: PlatformTemplate[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ templates: rows }) }
    if (method === 'PATCH') {
      const id = url.split('/').pop() as string
      const patch = JSON.parse(String(init?.body)) as Partial<PlatformTemplate>
      const current = rows.find((row) => row.id === id) as PlatformTemplate
      return { ok: true, status: 200, json: async () => ({ ...current, ...patch }) }
    }
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Partial<PlatformTemplate>
      return { ok: true, status: 201, json: async () => ({ ...template({ id: 'tpl-new' }), ...body }) }
    }
    return { ok: true, status: 204, json: async () => ({}) }
  })
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for “${name}”` }))
}

describe('WorkflowTemplates', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('renders the section chrome and one table row per template', async () => {
    vi.stubGlobal('fetch', apiFetch([template(), DRAFT]))

    render(<WorkflowTemplates />)

    expect(await screen.findByText('Regulation monitor')).toBeDefined()
    const card = screen.getByTestId('platform-workflow-templates')
    expect(within(card).getByText('Workflow templates')).toBeDefined()

    // Every column the owner compares templates on is present…
    for (const column of ['Template', 'Category', 'Tint', 'Data sources', 'Cadence', 'Published']) {
      expect(within(card).getByRole('columnheader', { name: column })).toBeDefined()
    }
    // …and populated from the row.
    const row = screen.getByText('Regulation monitor').closest('tr') as HTMLElement
    expect(within(row).getByText('Compliance')).toBeDefined()
    expect(within(row).getByText('Regulation')).toBeDefined()
    expect(within(row).getByText('ris')).toBeDefined()
    expect(within(row).getByText('Weekly, Monday 06:00')).toBeDefined()
    expect(within(row).getByText('Published')).toBeDefined()

    // A template with no extra sources and no cron says so rather than showing a gap.
    const draftRow = screen.getByText('Documentation check').closest('tr') as HTMLElement
    expect(within(draftRow).getByText('Base knowledge only')).toBeDefined()
    expect(within(draftRow).getByText('On demand')).toBeDefined()
    expect(within(draftRow).getByText('Draft')).toBeDefined()
  })

  test('orders rows by sortOrder, not by arrival', async () => {
    vi.stubGlobal('fetch', apiFetch([template({ id: 'tpl-2', sortOrder: 5 }), template({ sortOrder: 1 })]))

    render(<WorkflowTemplates />)
    await screen.findAllByText('Regulation monitor')

    const names = screen.getAllByRole('button', { name: /^Edit “/ }).map((node) => node.textContent)
    expect(names[0]).toContain('Regulation monitor')
  })

  test('filters the table by search text', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', apiFetch([template(), DRAFT]))

    render(<WorkflowTemplates />)
    await screen.findByText('Regulation monitor')

    await user.type(screen.getByLabelText('Filter templates'), 'documentation')

    await waitFor(() => expect(screen.queryByText('Regulation monitor')).toBeNull())
    expect(screen.getByText('Documentation check')).toBeDefined()
  })

  test('filters by publish state and offers a way back when nothing matches', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', apiFetch([template(), DRAFT]))

    render(<WorkflowTemplates />)
    await screen.findByText('Regulation monitor')

    await user.click(screen.getByRole('combobox', { name: 'Publish state' }))
    await user.click(screen.getByRole('option', { name: 'Drafts only' }))

    await waitFor(() => expect(screen.queryByText('Regulation monitor')).toBeNull())
    expect(screen.getByText('Documentation check')).toBeDefined()

    // Narrow it to nothing, then recover with the offered escape hatch.
    await user.type(screen.getByLabelText('Filter templates'), 'zzz')
    expect(await screen.findByText('No template matches')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('Regulation monitor')).toBeDefined()
  })

  test('shows the shared skeleton while loading and the shared empty state when there is nothing', async () => {
    vi.stubGlobal('fetch', apiFetch([]))

    render(<WorkflowTemplates />)
    expect(screen.getByTestId('section-loading')).toBeDefined()

    expect(await screen.findByText('No templates yet')).toBeDefined()
    expect(screen.queryByTestId('platform-template-list')).toBeNull()
  })

  test('shows a retryable error instead of a permanent skeleton on failure', async () => {
    const user = userEvent.setup()
    const failing = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ templates: [template()] }) })
    vi.stubGlobal('fetch', failing)

    render(<WorkflowTemplates />)

    expect(await screen.findByText('The templates could not be loaded.')).toBeDefined()
    await user.click(screen.getByRole('button', { name: /Retry/i }))
    expect(await screen.findByText('Regulation monitor')).toBeDefined()
  })

  test('publishing from the row PATCHes and confirms the cross-organization consequence', async () => {
    const user = userEvent.setup()
    const fetchSpy = apiFetch([DRAFT])
    vi.stubGlobal('fetch', fetchSpy)

    render(<WorkflowTemplates />)
    await screen.findByText('Documentation check')

    await user.click(
      screen.getByRole('switch', { name: 'Publish “Documentation check” to every organization' }),
    )

    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(String(patch?.[0])).toContain('/api/platform/workflow-templates/tpl-2')
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ published: true })
    })
    expect(toast.success).toHaveBeenCalledWith('Template published to every organization.')
  })

  test('reverts the optimistic publish flip when the PATCH fails', async () => {
    const user = userEvent.setup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return { ok: true, status: 200, json: async () => ({ templates: [DRAFT] }) }
        }
        return { ok: false, status: 500, text: async () => '' }
      }),
    )

    render(<WorkflowTemplates />)
    const toggle = await screen.findByRole('switch', {
      name: 'Publish “Documentation check” to every organization',
    })

    await user.click(toggle)

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The publish state could not be changed.'))
    expect(
      screen.getByRole('switch', { name: 'Publish “Documentation check” to every organization' }),
    ).toHaveAttribute('data-state', 'unchecked')
  })

  test('deleting asks first, then removes the row', async () => {
    const user = userEvent.setup()
    const fetchSpy = apiFetch([template(), DRAFT])
    vi.stubGlobal('fetch', fetchSpy)

    render(<WorkflowTemplates />)
    await screen.findByText('Regulation monitor')

    await openRowMenu(user, 'Regulation monitor')
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(await screen.findByText('Delete “Regulation monitor”?')).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Delete template' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/tpl-1') && (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
    await waitFor(() => expect(screen.queryByText('Regulation monitor')).toBeNull())
  })

  test('exports a row as importable JSON that carries no ids or author', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', apiFetch([template()]))
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock')
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<WorkflowTemplates />)
    await screen.findByText('Regulation monitor')

    await openRowMenu(user, 'Regulation monitor')
    await user.click(await screen.findByRole('menuitem', { name: 'Export as JSON' }))

    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    const exported = JSON.parse(await createObjectURL.mock.calls[0][0].text())
    expect(exported.kind).toBe('grid.workflow-template')
    expect(exported.content.de.name).toBe('tpl-1 DE')
    expect(exported.id).toBeUndefined()
    expect(exported.createdByEmail).toBeUndefined()
    // Round-trips: the export is exactly what the importer accepts.
    expect(exported.published).toBeUndefined()
  })

  test('opens the editor Sheet from a row, pre-filled with that template', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', apiFetch([template()]))

    render(<WorkflowTemplates />)
    await user.click(await screen.findByRole('button', { name: 'Edit “Regulation monitor”' }))

    expect(await screen.findByText('Edit workflow template')).toBeDefined()
    expect(screen.getByLabelText('Name')).toHaveValue('tpl-1 DE')
  })

  test('JSON import is behind a deliberate action and seeds an unpublished draft', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', apiFetch([template()]))

    render(<WorkflowTemplates />)
    await screen.findByText('Regulation monitor')

    // The dropzone is not page furniture — it only exists once import is chosen.
    expect(screen.queryByTestId('template-import-dropzone')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Import JSON' }))
    expect(await screen.findByTestId('template-import-dropzone')).toBeDefined()

    const payload = {
      kind: 'grid.workflow-template',
      provenance: 'office',
      published: true,
      content: {
        de: {
          name: 'Importiert',
          description: 'Beschreibung.',
          category: 'Büro',
          definition: { version: 1, blocks: { objective: 'Ziel.' } },
        },
        en: {
          name: 'Imported',
          description: 'Description.',
          category: 'Office',
          definition: { version: 1, blocks: { objective: 'Objective.' } },
        },
      },
    }
    await user.upload(
      screen.getByTestId('template-import-input'),
      new File([JSON.stringify(payload)], 'tpl.json', { type: 'application/json' }),
    )

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Template file loaded — review and save.'))
    expect(await screen.findByText('New workflow template')).toBeDefined()
    expect(screen.getByLabelText('Name')).toHaveValue('Importiert')
    // An import never arrives published, whatever the file claimed.
    expect(screen.getByRole('switch', { name: 'Published' })).toHaveAttribute('data-state', 'unchecked')
  })

  test('rejects a file that is not a template export', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', apiFetch([template()]))

    render(<WorkflowTemplates />)
    await screen.findByText('Regulation monitor')

    await user.click(screen.getByRole('button', { name: 'Import JSON' }))
    await user.upload(
      await screen.findByTestId('template-import-input'),
      new File(['{"nope":true}'], 'tpl.json', { type: 'application/json' }),
    )

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That file is not a valid template export.'),
    )
    expect(screen.queryByText('New workflow template')).toBeNull()
  })

  test('pages a long list instead of rendering every row', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 12 }, (_, index) =>
      template({ id: `tpl-${index}`, sortOrder: index }),
    )
    vi.stubGlobal('fetch', apiFetch(many))

    render(<WorkflowTemplates />)
    await screen.findByText('1–10 of 12')
    expect(screen.getAllByRole('button', { name: /^Edit “/ })).toHaveLength(10)

    await user.click(screen.getByRole('button', { name: /Next/i }))
    expect(await screen.findByText('11–12 of 12')).toBeDefined()
  })
})
