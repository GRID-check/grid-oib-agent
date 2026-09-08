/**
 * The transcript's record of what this conversation was allowed to read.
 *
 * What the list itself has to get right is narrow: one notice per mount, the
 * undo bound to the notice it stands under, and the ONE refusal — a fact about
 * the last attempt, never a history — rendered as the sentence its code earns.
 * The cap is the only refusal with something to do about it, so it is the only
 * one that arrives with a control.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MountNoticeEntry, MountRefusal } from '../stores'
import { MountNotices } from './MountNotices'

const unmountProject = vi.fn()
const setDeepResearchIntent = vi.fn()

interface Fake {
  mountNotices: MountNoticeEntry[]
  mountRefusal: MountRefusal | null
  mountCap: number
  currentConversation: { id: string } | null
  unmountProject: typeof unmountProject
}

let state: Fake

vi.mock('../store', () => ({
  useChatStore: (selector: (s: Fake) => unknown) => selector(state),
}))

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: (selector: (s: { setDeepResearchIntent: typeof setDeepResearchIntent }) => unknown) =>
    selector({ setDeepResearchIntent }),
}))

beforeEach(() => {
  unmountProject.mockClear()
  setDeepResearchIntent.mockClear()
  state = {
    mountNotices: [],
    mountRefusal: null,
    mountCap: 5,
    currentConversation: { id: 'conv-1' },
    unmountProject,
  }
})

it('renders nothing when nothing has happened', () => {
  const { container } = render(<MountNotices />)
  expect(container).toBeEmptyDOMElement()
})

describe('the history', () => {
  beforeEach(() => {
    state.mountNotices = [
      { id: 'n1', projectId: 'p1', projectName: 'Seestadt Nord', by: 'agent' },
      { id: 'n2', projectId: 'p2', projectName: 'Rosenhügel', by: 'user', undone: true },
    ]
  })

  it('keeps every mount, including the one that was taken back', () => {
    render(<MountNotices />)
    expect(screen.getByText('Piloti added project Seestadt Nord.')).toBeInTheDocument()
    expect(screen.getByText('Rosenhügel removed again.')).toBeInTheDocument()
  })

  it('binds the undo to the notice it stands under, not to the project alone', async () => {
    render(<MountNotices />)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(unmountProject).toHaveBeenCalledWith('conv-1', 'p1', 'n1')
  })
})

describe('a refusal', () => {
  it('states the reason, and only the last attempt', () => {
    state.mountRefusal = { code: 'no_access', projectName: 'Seestadt Nord' }
    render(<MountNotices />)
    expect(screen.getByText('Seestadt Nord could not be added.')).toBeInTheDocument()
    expect(screen.queryByTestId('mount-cap-notice')).toBeNull()
  })

  it('offers deep research at the cap, with the number the SERVER stated', async () => {
    state.mountRefusal = { code: 'cap', cap: 3 }
    render(<MountNotices />)

    expect(screen.getByText(/cannot read more than 3 projects/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Start as Deep Research' }))
    expect(setDeepResearchIntent).toHaveBeenCalledWith(true)
  })

  it('falls back to the cap the conversation knows when the refusal carried none', () => {
    state.mountRefusal = { code: 'cap' }
    render(<MountNotices />)
    expect(screen.getByText(/cannot read more than 5 projects/)).toBeInTheDocument()
  })
})
