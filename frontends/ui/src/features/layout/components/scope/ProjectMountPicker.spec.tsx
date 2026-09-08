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

const props = {
  mountedIds: [] as string[],
  capReached: false,
  cap: 5,
  onMount: vi.fn(),
  onDeepResearch: vi.fn(),
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => projects })
    // `vi.stubGlobal`, not an assignment: happy-dom defines `fetch` as a
    // read-only property on the window, so `global.fetch = …` throws.
    vi.stubGlobal('fetch', fetchMock)

    render(<ProjectMountPicker {...props} />)

    await waitFor(() =>
      expect(screen.getByText('The project list could not be loaded.')).toBeInTheDocument()
    )

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.getByText('Seestadt Nord')).toBeInTheDocument())
  })
})
