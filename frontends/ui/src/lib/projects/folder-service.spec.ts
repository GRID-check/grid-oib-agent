import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/db/schema', () => ({
  projectFolders: {},
}))

import { validateFolderName, buildFolderPath } from './folders'

describe('folder service validation', () => {
  it('validates and builds folder paths correctly', () => {
    expect(validateFolderName('Plans').ok).toBe(true)
    expect(validateFolderName('')).toEqual({ ok: false, error: 'Folder name is required.' })
    expect(validateFolderName('..')).toEqual({ ok: false, error: 'Folder name cannot be . or ...' })
    expect(validateFolderName('CON')).toEqual({ ok: false, error: 'Folder name is reserved.' })
  })

  it('builds nested folder paths', () => {
    expect(buildFolderPath('Plans', 'Fire Safety')).toBe('Plans/Fire Safety')
    expect(buildFolderPath('', 'Root')).toBe('Root')
    expect(buildFolderPath(null, 'Root')).toBe('Root')
  })
})
