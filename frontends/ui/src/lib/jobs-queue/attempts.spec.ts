import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLastAttempt, maxAttempts } from './attempts'

describe('maxAttempts', () => {
  it('reads the runner’s own knob', () => {
    expect(maxAttempts({ GRID_BFF_JOBS_MAX_ATTEMPTS: '5' })).toBe(5)
  })

  it.each(['', '0', '-2', 'many'])('falls back to the default for %j', (raw) => {
    expect(maxAttempts({ GRID_BFF_JOBS_MAX_ATTEMPTS: raw })).toBe(3)
  })

  it('names the last attempt, and only that one', () => {
    expect(isLastAttempt(2, {})).toBe(false)
    expect(isLastAttempt(3, {})).toBe(true)
    expect(isLastAttempt(1, { GRID_BFF_JOBS_MAX_ATTEMPTS: '1' })).toBe(true)
  })

  // Two readers of one name: the runner decides when a job is dead and a handler
  // must know it is on the last claim. A changed default on one side only would
  // bury jobs without the row ever saying why, or say "failed" a claim early.
  it('uses the default the runner uses', () => {
    const runner = readFileSync(join(__dirname, '..', '..', '..', 'workers', 'jobs', 'index.js'), 'utf8')
    const declared = runner.match(/toInt\(env\.GRID_BFF_JOBS_MAX_ATTEMPTS,\s*(\d+)\)/)

    expect(declared).not.toBeNull()
    expect(maxAttempts({})).toBe(Number(declared?.[1]))
  })
})
