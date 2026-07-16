import { describe, expect, it } from 'vitest'
import { archivCollectionName } from './collection'

describe('archivCollectionName', () => {
  it('derives a deterministic, org-scoped collection name', () => {
    expect(archivCollectionName('org_01HZ')).toBe('archiv_org_01HZ')
    // Pure function of the org id — same input, same output.
    expect(archivCollectionName('org_01HZ')).toBe(archivCollectionName('org_01HZ'))
  })

  it('sanitizes characters outside the collection-name charset', () => {
    expect(archivCollectionName('org/../evil id')).toBe('archiv_org____evil_id')
    expect(archivCollectionName('a.b:c')).toBe('archiv_a_b_c')
  })

  it('preserves hyphens and underscores (as project collections do)', () => {
    expect(archivCollectionName('org-1_test')).toBe('archiv_org-1_test')
  })
})
