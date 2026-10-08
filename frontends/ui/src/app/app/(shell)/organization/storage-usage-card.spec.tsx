import { render, screen } from '@/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { StorageUsageCard } from './storage-usage-card'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const GB = 1e9

describe('StorageUsageCard', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          usage: {
            project: { bytes: 38.4 * GB, documents: 1284 },
            archiv: { bytes: 2.6 * GB, documents: 96 },
            total: { bytes: 41 * GB, documents: 1380 },
          },
          quotaBytes: 50 * GB,
          effectiveMaxUploadFileBytes: 250e6,
        })
      )
    )
  })

  // A member whose file was refused for its size lands here to find out why,
  // so the per-file limit sits beside the quota. Read-only: no control for it.
  test('names the organization upload limit, read-only, beside the quota', async () => {
    render(<StorageUsageCard />)

    expect(await screen.findByTestId('storage-max-file-size')).toHaveTextContent('250 MB')
    expect(screen.getByText('Largest file per upload')).toBeDefined()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(
      screen.getByText(/storage quota and the largest file you can upload are set by Piloti/)
    ).toBeDefined()
  })
})
