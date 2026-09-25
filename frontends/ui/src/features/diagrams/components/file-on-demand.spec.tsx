/**
 * Where this product's view draws a diagram, mermaid's SVG is only the FILE,
 * and the file is drawn when the reader files it — not on mount.
 *
 * Every mermaid render waits behind one global lock, and in dark mode a render
 * on mount was two full layouts per diagram (the unseen dark copy, then the
 * paper one) for a file most readers never make.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiagramModel } from '../model'

const renderer = vi.fn()
vi.mock('../render-diagram', () => ({ diagramRendererFor: () => renderer }))

const MODEL: DiagramModel = {
  kind: 'shares',
  items: [
    { label: 'Wohnen', value: 3 },
    { label: 'Büro', value: 1 },
  ],
}
vi.mock('../parse-mermaid', () => ({ parseMermaid: async () => MODEL }))

import { DiagramCard } from '@/features/grid-cards/components/DiagramCard'
import { DiagramFilingProvider } from '../diagram-filing-context'
import { clearDiagramModelCache } from '../use-diagram-model'
import { MermaidDiagram } from './mermaid-diagram'

const SOURCE = 'pie\n  "Wohnen" : 3\n  "Büro" : 1'

beforeEach(() => {
  clearDiagramModelCache()
  renderer.mockReset()
  renderer.mockImplementation(({ theme }: { theme: string }) =>
    Promise.resolve(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-theme="${theme}"/>`
    )
  )
  document.documentElement.classList.add('dark')
})

afterEach(() => {
  document.documentElement.className = ''
  vi.unstubAllGlobals()
})

const SURFACES = {
  fence: () => <MermaidDiagram source={SOURCE} />,
  card: () => <DiagramCard title="Nutzflächen" source={SOURCE} />,
}

describe.each(Object.entries(SURFACES))(
  'the %s, drawn by its own view inside a project',
  (_name, Surface) => {
    it('renders no mermaid on mount, and the paper copy only when filed', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ svg: { documentId: 'doc-1' }, pdf: { documentId: 'doc-2' } }),
      })
      vi.stubGlobal('fetch', fetchMock)
      render(
        <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
          <Surface />
        </DiagramFilingProvider>
      )
      expect(await screen.findByText('Wohnen')).toBeInTheDocument()
      const button = await screen.findByRole('button', { name: /file in project/i })
      expect(button).not.toBeDisabled()
      expect(renderer).not.toHaveBeenCalled()

      await userEvent.click(button)
      const filed = () => fetchMock.mock.calls.find(([url]) => String(url).endsWith('/diagrams'))
      await waitFor(() => expect(filed()).toBeDefined())
      expect(renderer).toHaveBeenCalledTimes(1)
      expect(renderer.mock.calls[0][0]).toMatchObject({ source: SOURCE, theme: 'light' })
      const body = JSON.parse((filed()?.[1] as { body: string }).body)
      expect(body.svg).toContain('data-theme="light"')
    })
  }
)
