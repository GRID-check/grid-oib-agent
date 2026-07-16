import { describe, expect, test } from 'vitest'
import { getDictionary } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { compilePreview, MAX_COMPILED_PROMPT_LENGTH } from './compile-preview'
import { isPlausibleCron, presetForCron } from './schedule'
import { resolveAllTemplates, resolveTemplate, WORKFLOW_TEMPLATES } from './templates'

// Translators scoped exactly like `useTranslations('workflows')` in the UI.
const translators = {
  en: createTranslator(getDictionary('en'), 'workflows'),
  de: createTranslator(getDictionary('de'), 'workflows'),
} as const

describe('workflow templates', () => {
  test('ships the two GRID default templates', () => {
    expect(WORKFLOW_TEMPLATES.map((template) => template.id)).toEqual([
      'regulatory-watch',
      'compliance-gap-check',
    ])
  })

  test('resolveTemplate returns null for an unknown id', () => {
    expect(resolveTemplate(translators.en, 'does-not-exist')).toBeNull()
  })

  for (const locale of ['en', 'de'] as const) {
    describe(`locale: ${locale}`, () => {
      const t = translators[locale]

      test('every template resolves with localized, non-key content', () => {
        const resolved = resolveAllTemplates(t)
        expect(resolved).toHaveLength(WORKFLOW_TEMPLATES.length)

        for (const template of resolved) {
          expect(template.name.length).toBeGreaterThan(0)
          expect(template.description.length).toBeGreaterThan(0)
          expect(template.definition.blocks.objective.length).toBeGreaterThan(0)
          // A missing key degrades to the dotted key path — guard against that.
          expect(template.name).not.toContain('templates.')
          expect(template.definition.blocks.objective).not.toContain('templates.')
          for (const question of template.definition.blocks.questions ?? []) {
            expect(question.length).toBeGreaterThan(0)
            expect(question).not.toContain('templates.')
          }
        }
      })

      test('each brief compiles to a non-empty prompt within the length cap', () => {
        for (const template of resolveAllTemplates(t)) {
          const compiled = compilePreview(template.definition)
          expect(compiled.length).toBeGreaterThan(0)
          expect(compiled.length).toBeLessThanOrEqual(MAX_COMPILED_PROMPT_LENGTH)
        }
      })
    })
  }

  test('regulatory-watch carries the weekly Vienna schedule and RIS + web sources', () => {
    const template = resolveTemplate(translators.en, 'regulatory-watch')
    expect(template).not.toBeNull()
    expect(template?.dataSources).toEqual(['ris', 'web_search'])
    expect(template?.scheduleTimezone).toBe('Europe/Vienna')
    // A valid 5-field cron string mapping to the weekly preset.
    expect(template?.scheduleCron).toBeDefined()
    expect(isPlausibleCron(template!.scheduleCron!)).toBe(true)
    expect(template!.scheduleCron!.trim().split(/\s+/)).toHaveLength(5)
    expect(presetForCron(template?.scheduleCron)).toBe('weekly')
  })

  test('compliance-gap-check is manual-only and knowledge-only', () => {
    const template = resolveTemplate(translators.en, 'compliance-gap-check')
    expect(template).not.toBeNull()
    expect(template?.dataSources).toEqual([])
    expect(template?.scheduleCron).toBeUndefined()
  })
})
