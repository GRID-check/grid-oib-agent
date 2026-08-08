/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { ApiRequestError } from '@/adapters/api/api-error'
import {
  getDeepResearchJobLoadFailureKind,
  isUnavailableDeepResearchJobError,
} from './deep-research-errors'

describe('deep research error classification', () => {
  test.each([
    'Failed to get job status: 404',
    'Failed to get job status: 410',
    'Job expired',
    'Job deleted',
    'Job not found',
  ])('classifies unavailable jobs as expired or deleted: %s', (message) => {
    const error = new Error(message)

    expect(getDeepResearchJobLoadFailureKind(error)).toBe('unavailable')
    expect(isUnavailableDeepResearchJobError(error)).toBe(true)
  })

  test.each([
    'Failed to get job status: 500 - PROXY_ERROR: fetch failed',
    'TypeError: Failed to fetch',
    'fetch failed',
    'ECONNREFUSED 127.0.0.1:8000',
    'NetworkError when attempting to fetch resource.',
  ])('classifies proxy and network failures as backend unreachable: %s', (message) => {
    const error = new Error(message)

    expect(getDeepResearchJobLoadFailureKind(error)).toBe('backend_unreachable')
    expect(isUnavailableDeepResearchJobError(error)).toBe(false)
  })

  test('keeps generic 500 errors distinct from unreachable backend failures', () => {
    expect(getDeepResearchJobLoadFailureKind(new Error('Failed to get job status: 500'))).toBe(
      'other'
    )
  })

  test.each([404, 410])('classifies a structured %s status as unavailable', (status) => {
    const error = new ApiRequestError(`Failed to get job status: ${status} - job gone`, status)

    expect(getDeepResearchJobLoadFailureKind(error)).toBe('unavailable')
    expect(isUnavailableDeepResearchJobError(error)).toBe(true)
  })

  test.each([
    'Failed to get job status: 401 - Signature has expired',
    'Failed to get job status: 500 - route not found',
    'Token expired, please sign in again',
    'The requested handler was not found',
  ])('does not misclassify free text mentioning expired/not-found as unavailable: %s', (message) => {
    const error = new Error(message)

    expect(getDeepResearchJobLoadFailureKind(error)).not.toBe('unavailable')
    expect(isUnavailableDeepResearchJobError(error)).toBe(false)
  })

  test('a structured non-404 status wins over unavailable-looking message text', () => {
    // A 500 whose detail happens to say "job not found" is a server error,
    // not a deleted job — the structured status is authoritative.
    const error = new ApiRequestError('Failed to get job status: 500 - job not found in cache', 500)

    expect(getDeepResearchJobLoadFailureKind(error)).toBe('other')
  })

  test('a structured 401 whose detail says the signature expired is not unavailable', () => {
    const error = new ApiRequestError('Failed to get job status: 401 - Signature has expired', 401)

    expect(getDeepResearchJobLoadFailureKind(error)).toBe('other')
  })
})
