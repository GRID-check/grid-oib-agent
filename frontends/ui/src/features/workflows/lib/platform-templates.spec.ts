/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { PLATFORM_TEMPLATE_ID_PREFIX, resolveGalleryTemplate } from './templates'
import type { GalleryTemplate } from '@/adapters/api/platform-workflow-templates-client'

const gallery = (dataSources: string[] | null): GalleryTemplate => ({
  id: 'abc-123',
  provenance: 'law',
  dataSources,
  scheduleCron: '0 6 * * 1',
  scheduleTimezone: 'Europe/Vienna',
  content: {
    de: {
      name: 'DE Name',
      description: 'DE desc',
      category: 'Recht',
      definition: { version: 1, blocks: { objective: 'DE Ziel' } },
    },
    en: {
      name: 'EN Name',
      description: 'EN desc',
      category: 'Law',
      definition: { version: 1, blocks: { objective: 'EN objective' } },
    },
  },
})

describe('resolveGalleryTemplate', () => {
  it('resolves the requested locale and prefixes the synthetic id', () => {
    const resolved = resolveGalleryTemplate(gallery(['ris']), 'de')
    expect(resolved.id).toBe(`${PLATFORM_TEMPLATE_ID_PREFIX}abc-123`)
    expect(resolved.name).toBe('DE Name')
    expect(resolved.category).toBe('Recht')
    expect(resolved.definition.blocks.objective).toBe('DE Ziel')
    expect(resolved.dataSources).toEqual(['ris'])
    expect(resolved.scheduleCron).toBe('0 6 * * 1')
  })

  it('uses the English content for the en locale', () => {
    expect(resolveGalleryTemplate(gallery(['ris']), 'en').name).toBe('EN Name')
  })

  it('falls back to English for an unsupported locale', () => {
    expect(resolveGalleryTemplate(gallery(null), 'fr').name).toBe('EN Name')
  })

  it('maps a null (all-sources) data source list to an empty array', () => {
    // Matches how the builder + built-in templates treat "no additional sources".
    expect(resolveGalleryTemplate(gallery(null), 'de').dataSources).toEqual([])
  })
})
