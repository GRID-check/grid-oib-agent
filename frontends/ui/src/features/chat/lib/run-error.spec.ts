/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { getErrorMeta } from './error-registry'
import { isZdrPolicyRefusal, runErrorCard } from './run-error'

/** OpenRouter's documented refusal when no endpoint satisfies `provider.zdr`. */
const OPENROUTER_REFUSAL = 'No endpoints found matching your data policy (Zero data retention). Visit https://openrouter.ai/settings/privacy'
/** `ZDR_MODEL_REFUSED_MESSAGE` in src/aiq_agent/common/canned_replies.py, verbatim. */
const CANNED_REFUSAL =
  'Diese Frage konnte nicht beantwortet werden, weil das eingestellte Modell keinen Anbieter ohne Datenspeicherung hat und Ihre Organisation Zero Data Retention verlangt. Eine Administratorin oder ein Administrator muss unter Organisation → Modelle ein Modell mit Zero-Data-Retention-Anbieter wählen.'

describe('isZdrPolicyRefusal', () => {
  it.each([
    OPENROUTER_REFUSAL,
    'openai.APIStatusError: Error code: 404 - {"error":{"message":"No endpoints found matching your data policy","code":404}}',
    'NO ENDPOINTS FOUND MATCHING YOUR DATA POLICY',
    CANNED_REFUSAL,
  ])('recognises %s', (text) => {
    expect(isZdrPolicyRefusal(text)).toBe(true)
  })

  // Internal faults that merely MENTION ZDR are bugs to retry and report, not
  // "an admin must choose a model".
  it.each([
    'ZdrRoutingError: cannot pin provider for request',
    'ZDR policy lookup failed: HTTP 500',
    'zero data retention setting could not be read',
    'Rate limit exceeded',
    'Reasoning is mandatory for this endpoint and cannot be disabled',
    '',
    null,
    undefined,
  ])('leaves %s alone', (text) => {
    expect(isZdrPolicyRefusal(text)).toBe(false)
  })
})

describe('runErrorCard', () => {
  it('maps a data-policy refusal to its own non-retryable code, keeping the raw text as details', () => {
    const card = runErrorCard({ code: 'workflow_error', message: OPENROUTER_REFUSAL })
    expect(card).toEqual({ code: 'agent.zdr_refused', details: OPENROUTER_REFUSAL })
    // No `message`: the banner renders the localized registry copy instead.
    expect(card.message).toBeUndefined()
    expect(getErrorMeta(card.code).retryable).toBe(false)
    expect(getErrorMeta(card.code).messageKey).toBe('errorRegistry.zdrRefused.message')
  })

  it('maps the backend’s canned ZDR answer the same way', () => {
    expect(runErrorCard({ code: 'workflow_error', message: CANNED_REFUSAL }).code).toBe('agent.zdr_refused')
  })

  it('keeps every other failure on its wire code, with its message', () => {
    expect(runErrorCard({ code: 'workflow_error', message: 'boom' })).toEqual({
      code: 'agent.workflow_error',
      message: 'boom',
    })
    expect(runErrorCard({ code: 'auth_error', message: 'expired' }).code).toBe('auth.session_expired')
    expect(runErrorCard({ code: 'interaction_expired', message: 'late' }).code).toBe('agent.response_interrupted')
    expect(runErrorCard({ code: 'something_new', message: 'x' }).code).toBe('agent.response_failed')
    expect(runErrorCard(undefined)).toEqual({ code: 'agent.response_failed' })
  })

  it('leaves other errors retryable', () => {
    expect(getErrorMeta('agent.workflow_error').retryable).not.toBe(false)
  })
})
