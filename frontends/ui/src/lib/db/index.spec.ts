/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveDbPoolMax } from './index'

describe('resolveDbPoolMax', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to 10 when GRID_DB_POOL_MAX is unset', () => {
    vi.stubEnv('GRID_DB_POOL_MAX', '')
    expect(resolveDbPoolMax()).toBe(10)
  })

  it('honours a valid positive override', () => {
    vi.stubEnv('GRID_DB_POOL_MAX', '25')
    expect(resolveDbPoolMax()).toBe(25)
  })

  it('floors a fractional value to an integer connection count', () => {
    vi.stubEnv('GRID_DB_POOL_MAX', '12.9')
    expect(resolveDbPoolMax()).toBe(12)
  })

  it('falls back to the default rather than disabling the bound on non-positive input', () => {
    vi.stubEnv('GRID_DB_POOL_MAX', '0')
    expect(resolveDbPoolMax()).toBe(10)
    vi.stubEnv('GRID_DB_POOL_MAX', '-5')
    expect(resolveDbPoolMax()).toBe(10)
  })

  it('falls back to the default on unparseable input', () => {
    vi.stubEnv('GRID_DB_POOL_MAX', 'not-a-number')
    expect(resolveDbPoolMax()).toBe(10)
  })
})
