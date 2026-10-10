import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileItem } from '../file-types'
import { PilotiReading } from './piloti-reading'

/**
 * What Piloti made of a citable document: the facts line, the type and
 * discipline chips it assigned, and the way to correct them. The editor it
 * opens is specced on its own in `document-tags-editor.spec.tsx`; here it is
 * only checked that the reading opens it, closes it and lets go of it when
 * the reader moves to another file.
 */
const fileFixture = (overrides: Partial<FileItem> = {}): FileItem => ({
  id: 'doc-1',
  filename: 'plan.pdf',
  displayName: null,
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  ...overrides,
})

describe('PilotiReading', () => {
  describe('the facts line', () => {
    it('states the page count alone for a text-only document', () => {
      render(<PilotiReading file={fileFixture({ pageCount: 4, contentTypes: ['text'] })} canManage />)

      expect(screen.getByText('4 pages read')).toBeInTheDocument()
    })

    it('uses the singular for one page', () => {
      render(<PilotiReading file={fileFixture({ pageCount: 1 })} canManage />)

      expect(screen.getByText('1 page read')).toBeInTheDocument()
    })

    it('formats a large page count with the locale separator', () => {
      render(<PilotiReading file={fileFixture({ pageCount: 1234 })} canManage />)

      expect(screen.getByText('1,234 pages read')).toBeInTheDocument()
    })

    it('appends the content kinds after a dot when something beyond text is present', () => {
      render(
        <PilotiReading
          file={fileFixture({ pageCount: 4, contentTypes: ['text', 'table', 'drawing'] })}
          canManage
        />
      )

      expect(screen.getByText('4 pages read · Text, Tables, Drawings')).toBeInTheDocument()
    })

    it('names the content kinds alone when there is no page count', () => {
      render(<PilotiReading file={fileFixture({ contentTypes: ['text', 'image'] })} canManage />)

      expect(screen.getByText('Text, Images')).toBeInTheDocument()
    })

    it('omits the content kinds for a plain-text document, and the line when there is nothing to say', () => {
      render(<PilotiReading file={fileFixture({ pageCount: null, contentTypes: ['text'] })} canManage />)

      expect(screen.queryByText('Text')).toBeNull()
      expect(screen.queryByText(/pages? read/)).toBeNull()
      expect(screen.getByText('Piloti did not recognise a document type.')).toBeInTheDocument()
    })

    it('omits the page part when the count is zero', () => {
      render(<PilotiReading file={fileFixture({ pageCount: 0, contentTypes: ['text'] })} canManage />)

      expect(screen.queryByText(/pages? read/)).toBeNull()
    })
  })

  describe('the type and discipline chips', () => {
    it('marks the document type chip, and leaves a discipline chip unmarked', () => {
      render(
        <PilotiReading file={fileFixture({ tags: ['Grundriss', 'Brandschutz'] })} canManage />
      )

      expect(screen.getByTestId('piloti-reading-type')).toHaveTextContent('Grundriss')
      expect(screen.getByText('Brandschutz')).not.toHaveAttribute('data-testid')
    })

    it('shows the chips as static text, with no remove affordance', () => {
      render(<PilotiReading file={fileFixture({ tags: ['Grundriss', 'Brandschutz'] })} canManage />)

      expect(screen.getByText('Piloti reads this as')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /remove tag/i })).toBeNull()
      expect(screen.queryByRole('textbox', { name: /add tag/i })).toBeNull()
    })
  })

  describe('correcting the reading', () => {
    it('opens the editor on Correct, explains that the choice stays, and closes it on Done', async () => {
      const user = userEvent.setup()
      render(<PilotiReading file={fileFixture({ tags: ['Grundriss'] })} canManage />)

      expect(screen.queryByTestId('piloti-reading-editor')).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Correct' }))

      const editor = screen.getByTestId('piloti-reading-editor')
      expect(within(editor).getByRole('textbox', { name: /add tag/i })).toBeInTheDocument()
      expect(screen.getByText('Your choice stays, even when Piloti reads the file again.')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Done' }))

      expect(screen.queryByTestId('piloti-reading-editor')).toBeNull()
      expect(screen.queryByText('Your choice stays, even when Piloti reads the file again.')).toBeNull()
      expect(screen.getByRole('button', { name: 'Correct' })).toBeInTheDocument()
    })

    it('offers Assign instead of Correct when Piloti found no type, and opens the editor from it', async () => {
      const user = userEvent.setup()
      render(<PilotiReading file={fileFixture({ tags: [] })} canManage />)

      expect(screen.getByText('Piloti did not recognise a document type.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull()

      await user.click(screen.getByRole('button', { name: 'Assign' }))

      expect(screen.getByTestId('piloti-reading-editor')).toBeInTheDocument()
    })

    it('shows no Correct or Assign to a viewer who cannot manage the document', () => {
      render(<PilotiReading file={fileFixture({ tags: ['Grundriss'] })} canManage={false} />)

      expect(screen.getByText('Grundriss')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull()
      expect(screen.queryByTestId('piloti-reading-editor')).toBeNull()
    })

    it('shows no Assign to a viewer who cannot manage an untagged document', () => {
      render(<PilotiReading file={fileFixture({ tags: [] })} canManage={false} />)

      expect(screen.getByText('Piloti did not recognise a document type.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull()
    })

    it('closes the editor when the reader moves to another file', async () => {
      const user = userEvent.setup()
      const { rerender } = render(
        <PilotiReading file={fileFixture({ id: 'doc-1', tags: ['Grundriss'] })} canManage />
      )
      await user.click(screen.getByRole('button', { name: 'Correct' }))
      expect(screen.getByTestId('piloti-reading-editor')).toBeInTheDocument()

      rerender(<PilotiReading file={fileFixture({ id: 'doc-2', tags: ['Grundriss'] })} canManage />)

      expect(screen.queryByTestId('piloti-reading-editor')).toBeNull()
      expect(screen.getByRole('button', { name: 'Correct' })).toBeInTheDocument()
    })
  })
})
