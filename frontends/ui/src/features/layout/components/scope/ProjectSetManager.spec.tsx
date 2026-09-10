/**
 * A Sammlung is a LABEL over projects, so the promises this panel has to keep
 * are about AUTHORITY, not about forms:
 *
 *  - `editable` comes off the wire and is never inferred, so a set this reader
 *    may not change offers no control that could only 403;
 *  - a set they may not change is still SHOWN, because it is the office's
 *    shared vocabulary and the picker's rows are unexplainable without it;
 *  - deleting asks first, and says what is lost — which is the label and
 *    nothing else;
 *  - a refusal is a sentence, and a duplicate name has its own.
 */

import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSetManager } from './ProjectSetManager'
import { ProjectSetRefusedError } from '@/adapters/api'

vi.mock('@/adapters/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/adapters/api')>()
  return {
    ...actual,
    projectSetsClient: {
      list: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      addProjects: vi.fn(),
      removeProjects: vi.fn(),
    },
  }
})

const { projectSetsClient } = await import('@/adapters/api')
const client = projectSetsClient as unknown as Record<string, ReturnType<typeof vi.fn>>

const summary = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 's1',
  name: 'Bezirk 3',
  description: 'Alles im dritten Bezirk',
  createdBy: 'u1',
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z',
  projectCount: 2,
  editable: true,
  ...over,
})

const projects = [
  { id: 'p1', name: 'Seestadt Nord' },
  { id: 'p2', name: 'Rosenhügel' },
]

beforeEach(() => {
  vi.clearAllMocks()
  client.list.mockResolvedValue([summary()])
  client.get.mockResolvedValue({ ...summary(), projects: [projects[0]!] })
})

describe('the list', () => {
  it('names each Sammlung and how many projects this reader may read of it', () => {
    render(<ProjectSetManager sets={[summary()]} projects={projects} />)

    expect(screen.getByText('Bezirk 3')).toBeInTheDocument()
    expect(screen.getByText(/2 projects/)).toBeInTheDocument()
  })

  it('shows a set this reader may not change, WITHOUT controls that could only fail', () => {
    render(<ProjectSetManager sets={[summary({ editable: false })]} projects={projects} />)

    expect(screen.getByText('Bezirk 3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete „Bezirk 3/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
  })

  it('names the absence rather than showing an empty box', () => {
    render(<ProjectSetManager sets={[]} projects={projects} />)
    expect(screen.getByText('No collection yet.')).toBeInTheDocument()
  })
})

describe('creating', () => {
  it('sends the name and the description, then opens the new set', async () => {
    client.create.mockResolvedValue({ ...summary({ id: 's9', name: 'Bezirk 4' }), projects: [] })
    client.get.mockResolvedValue({ ...summary({ id: 's9', name: 'Bezirk 4' }), projects: [] })
    render(<ProjectSetManager sets={[]} projects={projects} />)

    await userEvent.click(screen.getByTestId('new-project-set'))
    await userEvent.type(screen.getByLabelText('Name'), 'Bezirk 4')
    await userEvent.type(screen.getByLabelText('Description (optional)'), 'Vierter')
    await userEvent.click(screen.getByTestId('create-project-set'))

    await waitFor(() =>
      expect(client.create).toHaveBeenCalledWith({ name: 'Bezirk 4', description: 'Vierter' })
    )
  })

  it('says a name is taken in its own words, not "that did not work"', async () => {
    client.create.mockRejectedValue(
      new ProjectSetRefusedError('taken', 409, 'duplicate_name')
    )
    render(<ProjectSetManager sets={[]} projects={projects} />)

    await userEvent.click(screen.getByTestId('new-project-set'))
    await userEvent.type(screen.getByLabelText('Name'), 'Bezirk 3')
    await userEvent.click(screen.getByTestId('create-project-set'))

    expect(await screen.findByTestId('project-set-error')).toHaveTextContent(
      'A collection with that name already exists.'
    )
  })
})

describe('one Sammlung’s projects', () => {
  it('adds from the same readable project list the picker uses', async () => {
    client.addProjects.mockResolvedValue({ ...summary(), projects })
    render(<ProjectSetManager sets={[summary()]} projects={projects} initialSetId="s1" />)

    await screen.findByText('Projects in this collection')
    await userEvent.click(await screen.findByText('Rosenhügel'))

    await waitFor(() => expect(client.addProjects).toHaveBeenCalledWith('s1', ['p2']))
  })

  it('never offers a project the set already holds', async () => {
    render(<ProjectSetManager sets={[summary()]} projects={projects} initialSetId="s1" />)

    await screen.findByText('Projects in this collection')
    const addRows = screen.getAllByTestId('project-set-add-row')
    expect(addRows).toHaveLength(1)
    expect(addRows[0]).toHaveTextContent('Rosenhügel')
  })

  it('removes a project by name, which edits the label and not the project', async () => {
    client.removeProjects.mockResolvedValue({ ...summary({ projectCount: 0 }), projects: [] })
    render(<ProjectSetManager sets={[summary()]} projects={projects} initialSetId="s1" />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove Seestadt Nord from this collection' })
    )

    await waitFor(() => expect(client.removeProjects).toHaveBeenCalledWith('s1', ['p1']))
  })

  it('locks the name field and says why for a set this reader may not change', async () => {
    client.get.mockResolvedValue({
      ...summary({ editable: false }),
      projects: [projects[0]!],
    })
    render(
      <ProjectSetManager
        sets={[summary({ editable: false })]}
        projects={projects}
        initialSetId="s1"
      />
    )

    expect(await screen.findByLabelText('Name')).toBeDisabled()
    expect(
      screen.getByText('Only whoever created it — or a project administrator — can change it.')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('project-set-add-row')).not.toBeInTheDocument()
  })
})

describe('deleting', () => {
  it('asks first, and says the projects survive it', async () => {
    render(<ProjectSetManager sets={[summary()]} projects={projects} />)

    await userEvent.click(screen.getByRole('button', { name: 'Delete „Bezirk 3"?' }))

    const dialog = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'))
    expect(
      within(dialog).getByText(/The collection goes, the projects stay/)
    ).toBeInTheDocument()
    expect(client.remove).not.toHaveBeenCalled()
  })

  it('deletes only after the confirmation', async () => {
    client.remove.mockResolvedValue(undefined)
    client.list.mockResolvedValue([])
    render(<ProjectSetManager sets={[summary()]} projects={projects} />)

    await userEvent.click(screen.getByRole('button', { name: 'Delete „Bezirk 3"?' }))
    await userEvent.click(await screen.findByTestId('confirm-delete-project-set'))

    await waitFor(() => expect(client.remove).toHaveBeenCalledWith('s1'))
  })
})
