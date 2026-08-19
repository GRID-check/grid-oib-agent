/**
 * The model picker — tiles that open the viewer, offered instead of a prose
 * list of file names to retype.
 *
 * What is pinned here is that it lists only openable models, that each tile is
 * a real link into the viewer (so the click never round-trips the model), and
 * that it fails OPEN: a project with nothing to show renders nothing rather
 * than an empty picker, while a list that could not be read says so.
 *
 * Rendered in English — the default test locale.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { IfcModelPickerCard } from './IfcModelPickerCard'

const model = (filename: string, status = 'ready', extra: Record<string, unknown> = {}) => ({
  id: `id-${filename}`,
  documentId: `doc-${filename}`,
  projectId: 'p',
  filename,
  displayName: null,
  status,
  schemaVersion: 'IFC4',
  elementCount: 3,
  errorMessage: null,
  summary: null,
  updatedAt: '2026-02-11T09:00:00.000Z',
  ...extra,
})

/** Route the model-list request to its fixture. `never` holds the load open. */
function stubFetch(models: unknown | 'fail' | 'never'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/bim/models')) {
        if (models === 'never') return new Promise(() => {})
        if (models === 'fail') return { ok: false, status: 500, json: async () => ({}) }
        return { ok: true, json: async () => models }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

// `useProjectBimModels` collapses concurrent requests through a module-level
// map keyed by project, so each render needs its own id.
let nextProject = 0
const picker = (props: Partial<React.ComponentProps<typeof IfcModelPickerCard>> = {}) =>
  render(
    <IfcModelPickerCard
      title="Welches Modell?"
      note={null}
      projectId={`p${(nextProject += 1)}`}
      {...props}
    />
  )

describe('IfcModelPickerCard', () => {
  it('renders one tile per ready model, each a link into the viewer', async () => {
    stubFetch({ models: [model('haus-a.ifc'), model('haus-b.ifc')] })
    picker()

    const links = await screen.findAllByRole('link')
    expect(links).toHaveLength(2)
    // The click opens the viewer client-side (buildModelHref), never a turn.
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('/files?model=haus-a.ifc'))
    expect(links[1]).toHaveAttribute('href', expect.stringContaining('/files?model=haus-b.ifc'))
  })

  it('offers only models that can actually be opened', async () => {
    stubFetch({
      models: [model('ready.ifc', 'ready'), model('busy.ifc', 'extracting'), model('broken.ifc', 'failed')],
    })
    picker()

    const links = await screen.findAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('model=ready.ifc'))
  })

  it('renders nothing — not an empty picker — when the project has no readable model', async () => {
    stubFetch({ models: [] })
    const { container } = picker()
    // Wait for the list to settle, then assert the card drew nothing at all so
    // the written answer carries the turn.
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('says the list could not be read, rather than silently rendering nothing', async () => {
    stubFetch('fail')
    picker()
    await waitFor(() =>
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument()
    )
  })
})
