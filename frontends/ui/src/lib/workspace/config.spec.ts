/**
 * @vitest-environment node
 */
/**
 * The mount cap has one implementation (ADR-0054 §Confirmation), so it has one
 * test. What is worth asserting is not that a number is read — it is which of
 * the three wrong answers each bad input gets: garbage falls back, an
 * out-of-band number clamps, and neither is allowed to look like the other.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_MOUNTED_PROJECTS,
  MAX_MAX_MOUNTED_PROJECTS,
  MIN_MAX_MOUNTED_PROJECTS,
  maxMountedProjects,
} from './config'

const VARIABLE = 'GRID_WORKSPACE_MAX_MOUNTED_PROJECTS'

function set(value: string | undefined): void {
  if (value === undefined) delete process.env[VARIABLE]
  else process.env[VARIABLE] = value
}

afterEach(() => set(undefined))

describe('maxMountedProjects', () => {
  it('defaults to 5 when the variable is unset', () => {
    set(undefined)
    expect(maxMountedProjects()).toBe(DEFAULT_MAX_MOUNTED_PROJECTS)
    expect(DEFAULT_MAX_MOUNTED_PROJECTS).toBe(5)
  })

  it('takes an in-band override', () => {
    set('8')
    expect(maxMountedProjects()).toBe(8)
  })

  it('re-reads the environment per call, so a change is not stuck at import time', () => {
    set('3')
    expect(maxMountedProjects()).toBe(3)
    set('7')
    expect(maxMountedProjects()).toBe(7)
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not a number', 'five'],
    ['trailing junk', '5x'],
    ['fractional', '2.5'],
    ['infinite', 'Infinity'],
  ])('falls back to the default for %s, rather than clamping it', (_label, raw) => {
    set(raw)
    expect(maxMountedProjects()).toBe(DEFAULT_MAX_MOUNTED_PROJECTS)
  })

  it.each([
    ['zero', '0'],
    ['negative', '-4'],
  ])('clamps %s up to the floor, so a mount is always possible', (_label, raw) => {
    set(raw)
    expect(maxMountedProjects()).toBe(MIN_MAX_MOUNTED_PROJECTS)
  })

  it('clamps an unmeasured ceiling down to the band, not to what was asked for', () => {
    set('200')
    expect(maxMountedProjects()).toBe(MAX_MAX_MOUNTED_PROJECTS)
    expect(MAX_MAX_MOUNTED_PROJECTS).toBe(20)
  })

  it('accepts the band edges unchanged', () => {
    set(String(MIN_MAX_MOUNTED_PROJECTS))
    expect(maxMountedProjects()).toBe(MIN_MAX_MOUNTED_PROJECTS)
    set(String(MAX_MAX_MOUNTED_PROJECTS))
    expect(maxMountedProjects()).toBe(MAX_MAX_MOUNTED_PROJECTS)
  })
})
