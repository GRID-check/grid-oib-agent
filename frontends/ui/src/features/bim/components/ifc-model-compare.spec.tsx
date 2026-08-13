/**
 * "What changed since the version the authority already has."
 *
 * Four counts and three short lists — and every one of them is meaningless
 * without the pair of files it is the difference between. The base is a
 * control the reader can move after a run, and the request is the slowest in
 * the product, so both of the ways this panel can end up describing the wrong
 * comparison are ordinary use rather than edge cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import { IfcModelCompare } from './ifc-model-compare'

let fetchMock: ReturnType<typeof vi.fn>

function candidate(id: string, filename: string): BimModelHeaderView {
  return {
    id,
    documentId: `doc-${id}`,
    displayName: null,
    projectId: 'p1',
    filename,
    status: 'ready',
    schemaVersion: 'IFC4',
    elementCount: 100,
    errorMessage: null,
    summary: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const CANDIDATES = [candidate('m-v2', 'Haus-A_v2.ifc'), candidate('m-v1', 'Haus-A_v1.ifc')]

/** A comparison body with distinguishable counts. */
const comparison = (added: number) => ({
  comparison: {
    counts: { added, removed: 0, changed: 0 },
    unchangedCount: 0,
    added: [],
    removed: [],
    changed: [],
    truncated: false,
  },
})

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const ok = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('IfcModelCompare', () => {
  it('says nothing to compare against when this is the only revision', () => {
    render(<IfcModelCompare modelId="m-v3" candidates={[]} />)
    expect(screen.getByText(/Upload a second revision/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs on demand, not on mount — it reads both revisions in full', () => {
    render(<IfcModelCompare modelId="m-v3" candidates={CANDIDATES} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the revision the numbers are the difference to', async () => {
    fetchMock.mockResolvedValue(ok(comparison(17)))
    const user = userEvent.setup()
    render(<IfcModelCompare modelId="m-v3" candidates={CANDIDATES} />)

    await user.click(screen.getByRole('button', { name: /compare/i }))
    await waitFor(() => expect(screen.getByText(/Compared against Haus-A_v2.ifc/)).toBeInTheDocument())
  })

  it('keeps naming the revision it actually ran against after the select moves', async () => {
    // The select is a control, not a caption. Reading the label off it would
    // relabel a finished comparison the moment the reader browses the list —
    // "+17 Bauteile" measured against v2, presented as the difference to v1,
    // with nothing on screen to catch it.
    fetchMock.mockResolvedValue(ok(comparison(17)))
    const user = userEvent.setup()
    render(<IfcModelCompare modelId="m-v3" candidates={CANDIDATES} />)

    await user.click(screen.getByRole('button', { name: /compare/i }))
    await waitFor(() => expect(screen.getByText(/Compared against Haus-A_v2.ifc/)).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText(/compare against/i), 'm-v1')

    expect(screen.getByText(/Compared against Haus-A_v2.ifc/)).toBeInTheDocument()
    expect(screen.queryByText(/Compared against Haus-A_v1.ifc/)).not.toBeInTheDocument()
  })

  it('lets the last comparison asked for win, whatever order the answers arrive in', async () => {
    // Both entry points can fire while a request is out — the timeline asks
    // for one at any moment, and this request routinely takes seconds — so an
    // earlier answer landing last is ordinary rather than exotic.
    const first = deferred()
    const second = deferred()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const { rerender } = render(
      <IfcModelCompare
        modelId="m-v3"
        candidates={CANDIDATES}
        requested={{ baseModelId: 'm-v2', at: 1 }}
      />
    )
    rerender(
      <IfcModelCompare
        modelId="m-v3"
        candidates={CANDIDATES}
        requested={{ baseModelId: 'm-v1', at: 2 }}
      />
    )

    await act(async () => {
      second.resolve(ok(comparison(2)))
      await second.promise
    })
    await act(async () => {
      first.resolve(ok(comparison(1)))
      await first.promise
    })

    expect(screen.getByText(/Compared against Haus-A_v1.ifc/)).toBeInTheDocument()
    expect(screen.queryByText(/Compared against Haus-A_v2.ifc/)).not.toBeInTheDocument()
  })

  it('reports a failure rather than an empty comparison', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const user = userEvent.setup()
    render(<IfcModelCompare modelId="m-v3" candidates={CANDIDATES} />)

    await user.click(screen.getByRole('button', { name: /compare/i }))
    await waitFor(() => expect(screen.getByText(/could not be/i)).toBeInTheDocument())
  })
})
