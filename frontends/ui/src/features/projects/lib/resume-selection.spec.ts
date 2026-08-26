import { describe, expect, test } from 'vitest'

import {
  projectTouchedAt,
  RESUME_SLOTS,
  splitForResume,
  type ResumeCandidate,
} from './resume-selection'

const project = (id: string, overrides: Partial<ResumeCandidate> = {}): ResumeCandidate => ({
  id,
  profileUpdatedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
})

describe('splitForResume', () => {
  test('fills the rail with the viewer’s own activity, newest first', () => {
    const { resume, rest, basis } = splitForResume(
      [project('a'), project('b'), project('c'), project('d')],
      {
        a: '2026-08-01T09:00:00Z',
        b: '2026-08-03T09:00:00Z',
        c: '2026-08-02T09:00:00Z',
      }
    )

    expect(resume.map((p) => p.id)).toEqual(['b', 'c', 'a'])
    expect(rest.map((p) => p.id)).toEqual(['d'])
    expect(basis).toBe('activity')
  })

  test('falls back to project recency when the viewer has worked in nothing', () => {
    const { resume, rest, basis } = splitForResume([
      project('old', { createdAt: new Date('2026-01-01T00:00:00Z') }),
      project('newest', { createdAt: new Date('2026-06-01T00:00:00Z') }),
      project('middle', { createdAt: new Date('2026-03-01T00:00:00Z') }),
      project('oldest', { createdAt: new Date('2025-01-01T00:00:00Z') }),
    ])

    expect(resume.map((p) => p.id)).toEqual(['newest', 'middle', 'old'])
    expect(rest.map((p) => p.id)).toEqual(['oldest'])
    expect(basis).toBe('fallback')
  })

  test('tops a partly filled rail up from project recency, keeping activity first', () => {
    const { resume, basis } = splitForResume(
      [
        project('touched', { createdAt: new Date('2020-01-01T00:00:00Z') }),
        project('fresh', { createdAt: new Date('2026-07-01T00:00:00Z') }),
        project('stale', { createdAt: new Date('2026-02-01T00:00:00Z') }),
      ],
      { touched: '2026-08-01T09:00:00Z' }
    )

    // 'touched' is the oldest project on record and still leads the rail — the
    // viewer's own activity outranks project recency rather than merging with it.
    expect(resume.map((p) => p.id)).toEqual(['touched', 'fresh', 'stale'])
    expect(basis).toBe('activity')
  })

  test('prefers the profile write over creation when ordering untouched projects', () => {
    const { resume } = splitForResume([
      project('created-late', { createdAt: new Date('2026-05-01T00:00:00Z') }),
      project('edited-late', {
        createdAt: new Date('2024-01-01T00:00:00Z'),
        profileUpdatedAt: new Date('2026-08-01T00:00:00Z'),
      }),
    ])

    expect(resume.map((p) => p.id)).toEqual(['edited-late', 'created-late'])
  })

  test('treats an unparseable activity timestamp as no activity', () => {
    const { resume, basis } = splitForResume([project('a'), project('b')], { a: 'not-a-date' })

    expect(resume.map((p) => p.id)).toEqual(['a', 'b'])
    expect(basis).toBe('fallback')
  })

  test('returns a short rail and an empty list when there are fewer projects than slots', () => {
    const { resume, rest } = splitForResume([project('a'), project('b')])

    expect(resume).toHaveLength(2)
    expect(rest).toEqual([])
    expect(RESUME_SLOTS).toBe(3)
  })

  test('handles an empty project list', () => {
    expect(splitForResume([])).toEqual({ resume: [], rest: [], basis: 'fallback' })
  })

  test('accepts ISO strings as well as Dates for the fallback ordering', () => {
    expect(projectTouchedAt(project('a', { createdAt: '2026-04-01T00:00:00Z' }))).toBe(
      new Date('2026-04-01T00:00:00Z').getTime()
    )
    expect(projectTouchedAt(project('a', { createdAt: 'nonsense' }))).toBe(0)
  })
})
