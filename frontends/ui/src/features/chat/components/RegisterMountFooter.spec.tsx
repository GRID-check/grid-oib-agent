/**
 * The standing mount control under a register-only answer (§10.3).
 *
 * Its whole claim is that the offer is DATA: the projects the answer's register
 * citations named, with the ids the wire carried. So the tests that matter are
 * the ones that keep it from becoming anything else — an offer read off the
 * prose, an offer for a project already in view, or an offer in a project chat,
 * where there is no mounting to do.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CitedDocument } from '../lib/citations'
import { RegisterMountFooter } from './RegisterMountFooter'

const mountProject = vi.fn()

interface Fake {
  scope: 'project' | 'workspace'
  mounts: Array<{ projectId: string }>
  mountsPending: string[]
  currentConversation: { id: string } | null
  mountProject: typeof mountProject
}

let state: Fake

vi.mock('../store', () => ({
  useChatStore: (selector: (s: Fake) => unknown) => selector(state),
}))

/** A citation as the model builds it; only the fields this footer reads matter. */
const doc = (over: Partial<CitedDocument>): CitedDocument => ({
  id: over.id ?? 'd1',
  title: over.title ?? 'Steckbrief',
  kind: 'projekt',
  tint: 'project',
  loci: [],
  ...over,
})

const steckbrief = doc({
  id: 'd1',
  shelf: 'register',
  projectId: 'p-see',
  projectName: 'Seestadt Nord',
})

beforeEach(() => {
  mountProject.mockClear()
  state = {
    scope: 'workspace',
    mounts: [],
    mountsPending: [],
    currentConversation: { id: 'conv-1' },
    mountProject,
  }
})

it('offers every project the register citations named, once each', async () => {
  render(
    <RegisterMountFooter
      documents={[steckbrief, doc({ ...steckbrief, id: 'd2', title: 'Steckbrief II' })]}
    />
  )

  const offers = screen.getAllByText('Seestadt Nord')
  expect(offers).toHaveLength(1)

  await userEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(mountProject).toHaveBeenCalledWith('conv-1', 'p-see', 'Seestadt Nord')
})

describe('where it stays silent', () => {
  it('in a project chat, which has no mounting to offer', () => {
    state.scope = 'project'
    const { container } = render(<RegisterMountFooter documents={[steckbrief]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('for a project already in view — the answer proves it was read', () => {
    state.mounts = [{ projectId: 'p-see' }]
    const { container } = render(<RegisterMountFooter documents={[steckbrief]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('for a citation from a project’s FILES, which is not a register offer', () => {
    const { container } = render(
      <RegisterMountFooter
        documents={[doc({ ...steckbrief, shelf: 'project', title: 'Brandschutz.pdf' })]}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('when the wire named no project id — an offer is never derived from a name', () => {
    const { container } = render(
      <RegisterMountFooter documents={[doc({ shelf: 'register', projectName: 'Seestadt Nord' })]} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
