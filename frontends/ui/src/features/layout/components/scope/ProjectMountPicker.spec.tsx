/**
 * The picker's job is to be pressable exactly where mounting is possible and to
 * SAY SO everywhere it is not. Its three refusals — already in view, at the cap,
 * the list could not be fetched — are three different sentences, and none of
 * them is an empty list.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectMountPicker } from './ProjectMountPicker'

const projects = [
  { id: 'a', name: 'Seestadt Nord' },
  { id: 'b', name: 'Rosenhügel' },
]

const sets = [
  {
    id: 's1',
    name: 'Bezirk 3',
    description: null,
    createdBy: 'u1',
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z',
    projectCount: 3,
    editable: true,
  },
]

const props = {
  mountedIds: [] as string[],
  capReached: false,
  cap: 5,
  onMount: vi.fn(),
  onDeepResearch: vi.fn(),
  // Both lists are given, so no test in this file depends on a network stub
  // except the one that is ABOUT the network.
  sets: [] as typeof sets,
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('ready', () => {
  it('mounts the project the reader picked', async () => {
    const onMount = vi.fn()
    render(<ProjectMountPicker {...props} onMount={onMount} projects={projects} />)

    await userEvent.click(screen.getByText('Seestadt Nord'))

    expect(onMount).toHaveBeenCalledWith('a', 'Seestadt Nord')
  })

  it('keeps an already-mounted project in place, disabled and badged', async () => {
    const onMount = vi.fn()
    render(
      <ProjectMountPicker {...props} mountedIds={['a']} onMount={onMount} projects={projects} />
    )

    const rows = screen.getAllByTestId('project-mount-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('in view')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Seestadt Nord'))
    expect(onMount).not.toHaveBeenCalled()
  })
})

describe('at the cap', () => {
  it('disables every row WITH the reason visible on it', () => {
    render(<ProjectMountPicker {...props} capReached projects={projects} />)

    for (const row of screen.getAllByTestId('project-mount-row')) {
      expect(row).toHaveAttribute('aria-disabled', 'true')
    }
    expect(screen.getAllByText(/cannot read more than 5 projects/).length).toBeGreaterThan(0)
  })

  it('offers deep research in the footer', async () => {
    const onDeepResearch = vi.fn()
    render(
      <ProjectMountPicker {...props} capReached onDeepResearch={onDeepResearch} projects={projects} />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Start as Deep Research' }))

    expect(onDeepResearch).toHaveBeenCalled()
  })
})

describe('no readable project', () => {
  it('names that fact rather than showing an empty list', () => {
    render(<ProjectMountPicker {...props} projects={[]} />)
    expect(screen.getByText('There is no further project you can read.')).toBeInTheDocument()
  })
})

describe('fetch error', () => {
  it('offers a retry inside the list, and recovers', async () => {
    // Routed by URL, not by call order: the picker asks for TWO lists and the
    // Sammlungen answer must not be able to stand in for the projects one.
    let projectsAttempt = 0
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/workspace/project-sets')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ sets: [] }) })
      }
      projectsAttempt += 1
      return Promise.resolve(
        projectsAttempt === 1
          ? { ok: false, status: 500 }
          : { ok: true, status: 200, json: async () => projects }
      )
    })
    // `vi.stubGlobal`, not an assignment: happy-dom defines `fetch` as a
    // read-only property on the window, so `global.fetch = …` throws.
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ProjectMountPicker
        mountedIds={[]}
        capReached={false}
        cap={5}
        onMount={vi.fn()}
        onDeepResearch={vi.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByText('The project list could not be loaded.')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.getByText('Seestadt Nord')).toBeInTheDocument())
  })

  it('loses only the Sammlungen group when the Sammlungen call fails', async () => {
    const fetchMock = vi.fn((url: string) =>
      url.startsWith('/api/workspace/project-sets')
        ? Promise.resolve({ ok: false, status: 500 })
        : Promise.resolve({ ok: true, status: 200, json: async () => projects })
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ProjectMountPicker
        mountedIds={[]}
        capReached={false}
        cap={5}
        onMount={vi.fn()}
        onMountSet={vi.fn()}
        onDeepResearch={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByText('Seestadt Nord')).toBeInTheDocument())
    expect(screen.queryByTestId('project-set-row')).not.toBeInTheDocument()
  })
})

describe('the Sammlungen group', () => {
  it('leads the list and states how many projects THIS reader would mount', () => {
    render(<ProjectMountPicker {...props} sets={sets} onMountSet={vi.fn()} projects={projects} />)

    const row = screen.getByTestId('project-set-row')
    expect(row).toHaveTextContent('Bezirk 3')
    expect(row).toHaveTextContent('3 projects')
    // The coarser gesture comes first: a reader who has a Sammlung wants it
    // before they start naming projects one at a time.
    const rows = screen.getAllByTestId(/^project-(set|mount)-row$/)
    expect(rows[0]).toBe(row)
  })

  it('mounts the whole set on Enter', async () => {
    const onMountSet = vi.fn()
    render(<ProjectMountPicker {...props} sets={sets} onMountSet={onMountSet} projects={projects} />)

    await userEvent.click(screen.getByText('Bezirk 3'))

    expect(onMountSet).toHaveBeenCalledWith('s1', 'Bezirk 3')
  })

  it('disables a set at the cap WITH the reason on the row, like a project', () => {
    const onMountSet = vi.fn()
    render(
      <ProjectMountPicker
        {...props}
        capReached
        sets={sets}
        onMountSet={onMountSet}
        projects={projects}
      />
    )

    expect(screen.getByTestId('project-set-row')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getAllByText(/cannot read more than 5 projects/).length).toBeGreaterThan(0)
  })

  it('disables a set this reader may read nothing of, and says why', async () => {
    const onMountSet = vi.fn()
    render(
      <ProjectMountPicker
        {...props}
        sets={[{ ...sets[0]!, projectCount: 0 }]}
        onMountSet={onMountSet}
        projects={projects}
      />
    )

    const row = screen.getByTestId('project-set-row')
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveTextContent('No readable project')

    await userEvent.click(screen.getByText('Bezirk 3'))
    expect(onMountSet).not.toHaveBeenCalled()
  })

  it('is absent entirely for a reader with no Sammlung', () => {
    render(<ProjectMountPicker {...props} onMountSet={vi.fn()} projects={projects} />)
    expect(screen.queryByTestId('project-set-row')).not.toBeInTheDocument()
    expect(screen.queryByText('Collections')).not.toBeInTheDocument()
  })
})

describe('the footer', () => {
  it('leads to the Sammlungen manager', async () => {
    const onManageSets = vi.fn()
    render(<ProjectMountPicker {...props} onManageSets={onManageSets} projects={projects} />)

    await userEvent.click(screen.getByRole('button', { name: 'Manage collections' }))

    expect(onManageSets).toHaveBeenCalled()
  })
})
