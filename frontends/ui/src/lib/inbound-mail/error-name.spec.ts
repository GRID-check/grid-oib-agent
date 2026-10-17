/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { errorName } from './error-name'

describe('errorName', () => {
  it('names the class and code, never the message', () => {
    const drizzle = Object.assign(new Error('Failed query: … params: anna@buero-a.at'), {
      cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    })
    expect(errorName(drizzle)).toBe('Error:23505')
    expect(errorName('x')).toBe('string')
  })
})
