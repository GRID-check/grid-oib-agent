/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { describeRejections, isZdrListUnavailableResponse, MODEL_REJECTION_CODES, readRejectionDetails } from './rejections'

const tEn = createTranslator(en, 'organization')
const tDe = createTranslator(de, 'organization')

describe('rejection codes', () => {
  it('every code has copy in both languages', () => {
    for (const code of MODEL_REJECTION_CODES) {
      expect(tEn(`models.rejection.${code}`)).not.toContain('models.rejection')
      expect(tDe(`models.rejection.${code}`)).not.toContain('models.rejection')
    }
  })

  it('renders a 422 body per group in the reader’s language, never the English server message', () => {
    const details = {
      deep_research: [{ code: 'not_zdr', message: "model 'vendor/x' has no zero-data-retention endpoint", params: { model: 'vendor/x' } }],
      bogus: 'a legacy string detail is dropped',
    }
    expect(describeRejections(details, tDe, () => 'Tiefenrecherche')).toEqual([
      'Tiefenrecherche: vendor/x hat keinen Zero-Data-Retention-Endpunkt.',
    ])
    expect(Object.keys(readRejectionDetails(details))).toEqual(['deep_research'])
  })
})

describe('isZdrListUnavailableResponse', () => {
  it('is true only for a 503 naming the ZDR list', async () => {
    const named = Response.json({ details: { reason: 'zdr_list_unavailable' } }, { status: 503 })
    const other503 = Response.json({ error: 'catalog down' }, { status: 503 })
    const notJson = new Response('nope', { status: 503 })
    const other = Response.json({ details: { reason: 'zdr_list_unavailable' } }, { status: 500 })
    expect(await isZdrListUnavailableResponse(named)).toBe(true)
    expect(await isZdrListUnavailableResponse(other503)).toBe(false)
    expect(await isZdrListUnavailableResponse(notJson)).toBe(false)
    expect(await isZdrListUnavailableResponse(other)).toBe(false)
  })
})
