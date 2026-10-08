/**
 * The Project Memory panel marks a restricted note (ADR-0086) with the folder
 * lock, naming the folders it came from. The API sends such a note only to a
 * reader cleared for it, so the panel's job is the mark, not the filter.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { makeMemoryItem } from '@/test-utils/db-fixtures'
import { ProjectMemoryPanel } from './project-memory-panel'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

const wire = (overrides: Parameters<typeof makeMemoryItem>[0] & { restrictedFolderNames?: string[] }) => ({
  ...makeMemoryItem(overrides),
  createdAt: '2026-10-01T09:00:00Z',
  updatedAt: '2026-10-02T09:00:00Z',
  lastReferencedAt: null,
  ...(overrides.restrictedFolderNames ? { restrictedFolderNames: overrides.restrictedFolderNames } : {}),
})

describe('ProjectMemoryPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            wire({ id: 'open', content: 'Flachdach extensiv begrünt.' }),
            wire({
              id: 'restricted',
              content: 'Honorar LP 5–8 pauschal 184.000 €.',
              restrictedFolderIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
              restrictedFolderNames: ['Verträge'],
            }),
          ],
        })
      )
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('marks only the restricted note, naming its folder', async () => {
    render(<ProjectMemoryPanel projectId="p1" />)

    await screen.findByText('Honorar LP 5–8 pauschal 184.000 €.')
    const marks = screen.getAllByTestId('memory-restricted')
    expect(marks).toHaveLength(1)
    expect(marks[0].querySelector('[data-roles]')?.getAttribute('data-roles')).toBe('Verträge')
    expect(screen.getByText('Flachdach extensiv begrünt.')).toBeInTheDocument()
  })
})
