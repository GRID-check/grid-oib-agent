import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { MemorySettings } from './memory-settings'

const ITEM = {
  id: 'mem1',
  projectId: 'p1',
  organizationId: 'org-1',
  content: 'Bauherr bevorzugt Sichtbeton an der Nordfassade.',
  kind: 'preference',
  scope: 'project',
  confidence: 'high',
  verification: 'unverified',
  provenanceType: 'agent',
  pinned: false,
  conflictsWithId: null,
  createdAt: '2026-05-02T10:00:00Z',
  updatedAt: '2026-05-02T10:00:00Z',
  lastReferencedAt: null,
}

afterEach(() => vi.restoreAllMocks())

describe('MemorySettings', () => {
  test('a reader without write access gets the list, no controls, and the reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ items: [ITEM] }))
    render(<MemorySettings projectId="p1" canWrite={false} />)

    expect(await screen.findByText(ITEM.content)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add memory/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pin' })).not.toBeInTheDocument()
    expect(screen.getByText(/Changing it needs write access/)).toBeInTheDocument()
  })

  test('a writer gets the controls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ items: [ITEM] }))
    render(<MemorySettings projectId="p1" canWrite />)

    expect(await screen.findByText(ITEM.content)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add memory/i })).toBeInTheDocument()
    expect(screen.queryByText(/Changing it needs write access/)).not.toBeInTheDocument()
  })
})
