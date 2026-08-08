/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildFolderPath,
  normalizeFolderName,
  normalizeFolderPath,
  pathSegments,
  validateFolderName,
} from './folders'

describe('folder utilities', () => {
  it('normalizes a user-supplied folder name', () => {
    expect(normalizeFolderName('  Fire Safety  ')).toBe('Fire Safety')
    expect(normalizeFolderName('Plans/Fire')).toBe('Plans Fire')
    expect(normalizeFolderName('A\\B')).toBe('A B')
    expect(normalizeFolderName('A\u0000B')).toBe('A B')
  })

  it('rejects unsafe folder names', () => {
    expect(validateFolderName('Plans')).toEqual({ ok: true, name: 'Plans' })
    expect(validateFolderName('')).toEqual({ ok: false, error: 'Folder name is required.' })
    expect(validateFolderName(' . ')).toEqual({ ok: false, error: 'Folder name is required.' })
    expect(validateFolderName('..')).toEqual({ ok: false, error: 'Folder name cannot be . or ...' })
    expect(validateFolderName('CON')).toEqual({ ok: false, error: 'Folder name is reserved.' })
  })

  it('builds stable slash-separated paths from parent path and name', () => {
    expect(buildFolderPath(null, 'Plans')).toBe('Plans')
    expect(buildFolderPath('', 'Plans')).toBe('Plans')
    expect(buildFolderPath('Plans', 'Fire Safety')).toBe('Plans/Fire Safety')
    expect(buildFolderPath('/Plans//', 'Fire/Safety')).toBe('Plans/Fire Safety')
  })

  it('normalizes paths and removes traversal segments', () => {
    expect(normalizeFolderPath(' /Plans//Fire Safety/ ')).toBe('Plans/Fire Safety')
    expect(normalizeFolderPath('../Plans/./Fire')).toBe('Plans/Fire')
    expect(normalizeFolderPath('')).toBe('')
  })

  it('returns normalized path segments', () => {
    expect(pathSegments('Plans/Fire Safety/Level 01')).toEqual(['Plans', 'Fire Safety', 'Level 01'])
  })
})
