import { describe, expect, it } from 'vitest'
import {
  createPlatformTemplateSchema,
  updatePlatformTemplateSchema,
  type LocalizedTemplateContent,
} from './types'

const locale = (name: string): LocalizedTemplateContent => ({
  name,
  description: 'A short description.',
  category: 'Compliance',
  definition: { version: 1, blocks: { objective: 'Investigate X.' } },
})

const validContent = () => ({ de: locale('DE name'), en: locale('EN name') })

describe('createPlatformTemplateSchema', () => {
  it('accepts a both-locale payload and defaults provenance to auto', () => {
    const parsed = createPlatformTemplateSchema.safeParse({ content: validContent() })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.provenance).toBe('auto')
      expect(parsed.data.published).toBeUndefined()
    }
  })

  it('rejects a payload missing a locale', () => {
    const parsed = createPlatformTemplateSchema.safeParse({ content: { de: locale('only DE') } })
    expect(parsed.success).toBe(false)
  })

  it('rejects a locale whose objective is empty', () => {
    const content = validContent()
    content.en.definition.blocks.objective = ''
    expect(createPlatformTemplateSchema.safeParse({ content }).success).toBe(false)
  })

  it('rejects an invalid cron but accepts a valid one', () => {
    const bad = createPlatformTemplateSchema.safeParse({
      content: validContent(),
      scheduleCron: 'not-a-cron',
    })
    expect(bad.success).toBe(false)

    const good = createPlatformTemplateSchema.safeParse({
      content: validContent(),
      scheduleCron: '0 6 * * 1',
      scheduleTimezone: 'Europe/Vienna',
    })
    expect(good.success).toBe(true)
  })

  it('rejects an unknown timezone', () => {
    const parsed = createPlatformTemplateSchema.safeParse({
      content: validContent(),
      scheduleCron: '0 6 * * 1',
      scheduleTimezone: 'Mars/Olympus',
    })
    expect(parsed.success).toBe(false)
  })

  it('strips unknown envelope keys so an export re-imports', () => {
    const parsed = createPlatformTemplateSchema.safeParse({
      kind: 'grid.workflow-template',
      version: 1,
      id: 'ignored',
      content: validContent(),
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('kind' in parsed.data).toBe(false)
      expect('id' in parsed.data).toBe(false)
    }
  })
})

describe('updatePlatformTemplateSchema', () => {
  it('allows a bare publish toggle', () => {
    const parsed = updatePlatformTemplateSchema.safeParse({ published: true })
    expect(parsed.success).toBe(true)
  })

  it('still requires both locales when content is supplied', () => {
    const parsed = updatePlatformTemplateSchema.safeParse({ content: { en: locale('x') } })
    expect(parsed.success).toBe(false)
  })
})
