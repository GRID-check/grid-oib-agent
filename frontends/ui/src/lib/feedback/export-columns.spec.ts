/**
 * @vitest-environment node
 */

/**
 * The export's one column list, and the three things that must agree with it:
 * the dictionary that labels it, the documentation that explains it, and the
 * script that reads it by name.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import { feedbackExportRecord, feedbackWeeklyRecord } from '@/test-utils/feedback-export-fixtures'
import {
  FEEDBACK_EXPORT_COLUMNS,
  FEEDBACK_WEEKLY_COLUMNS,
  helpfulRate,
  isoWeekLabel,
  utcDay,
} from './export-columns'

const voteKeys = FEEDBACK_EXPORT_COLUMNS.map((column) => column.key)
const weekKeys = FEEDBACK_WEEKLY_COLUMNS.map((column) => column.key)
const valueOf = (key: string, record = feedbackExportRecord()) =>
  FEEDBACK_EXPORT_COLUMNS.find((column) => column.key === key)!.value(record, de)

describe('the column keys', () => {
  it('are unique snake_case, in both tables', () => {
    for (const keys of [voteKeys, weekKeys]) {
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  /** `scripts/feedback_to_cases.py` reads these by name. */
  it('keep the names the answer-suite converter reads', () => {
    expect(voteKeys).toEqual(expect.arrayContaining(['verdict', 'question', 'expected_answer', 'reason', 'voted_at']))
  })

  it('put one 1/0 column per topic tag right after the topic list, in the vocabulary’s order', () => {
    const at = voteKeys.indexOf('topics')
    expect(voteKeys.slice(at + 1, at + 1 + CONVERSATION_TAG_KEYS.length)).toEqual(
      CONVERSATION_TAG_KEYS.map((topic) => `topic_${topic}`)
    )
  })

  it('never carry the voter’s user id or e-mail', () => {
    expect(voteKeys.some((key) => /user_id|email|e_mail/.test(key))).toBe(false)
  })
})

describe('the dictionary', () => {
  /** A column is typed against its dictionary key; this catches the other direction, a label nobody renders. */
  it('labels exactly the columns that exist, in both languages', () => {
    const fixedVoteKeys = voteKeys.filter((key) => !key.startsWith('topic_'))
    for (const dictionary of [en, de]) {
      expect(Object.keys(dictionary.feedbackExport.columns).sort()).toEqual([...fixedVoteKeys].sort())
      expect(Object.keys(dictionary.feedbackExport.weeklyColumns).sort()).toEqual([...weekKeys].sort())
    }
  })

  it('gives every column a label and a description', () => {
    for (const dictionary of [en, de]) {
      for (const column of [...FEEDBACK_EXPORT_COLUMNS, ...FEEDBACK_WEEKLY_COLUMNS]) {
        expect(column.label(dictionary).trim(), column.key).not.toBe('')
        expect(column.description(dictionary).trim(), column.key).not.toBe('')
        expect(column.label(dictionary), column.key).not.toContain('{')
        expect(dictionary.feedbackExport.formats[column.format], column.key).toBeTruthy()
      }
    }
  })
})

/**
 * The data dictionary in the docs is read by people who never open the code.
 * It drifted the moment a column was added and nobody remembered the page, so
 * its key tables are held to the definitions here, in order.
 */
describe('docs/technical-reference/answer-feedback-export.md', () => {
  const doc = readFileSync(join(process.cwd(), '..', '..', 'docs', 'technical-reference', 'answer-feedback-export.md'), 'utf8')

  /** The first-column backticked keys of the table under `heading`. */
  const tableKeys = (heading: string): string[] => {
    const start = doc.indexOf(`## ${heading}`)
    expect(start, heading).toBeGreaterThan(-1)
    const rest = doc.slice(start + heading.length + 3)
    const section = rest.slice(0, rest.search(/\n## /) === -1 ? undefined : rest.search(/\n## /))
    return [...section.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((match) => match[1])
  }

  it('lists the vote columns the code defines, in the same order', () => {
    expect(tableKeys('Vote columns')).toEqual(voteKeys)
  })

  it('lists the weekly columns the code defines, in the same order', () => {
    expect(tableKeys('Weekly columns')).toEqual(weekKeys)
  })
})

describe('derived values', () => {
  it('counts a vote as changed only past a second after its first cast', () => {
    const at = new Date('2026-10-06T08:00:00.000Z')
    expect(valueOf('vote_changed', feedbackExportRecord({ firstVotedAt: at, votedAt: new Date(at.getTime() + 400) }))).toBe(
      false
    )
    expect(valueOf('vote_changed', feedbackExportRecord({ firstVotedAt: at, votedAt: new Date(at.getTime() + 1500) }))).toBe(
      true
    )
  })

  it('buckets by the first cast, so a row lands in the same week as on the weekly sheet', () => {
    const record = feedbackExportRecord({
      firstVotedAt: new Date('2026-10-04T23:30:00.000Z'), // Sunday, W40
      votedAt: new Date('2026-10-05T07:00:00.000Z'), // re-voted Monday, W41
    })
    expect(valueOf('iso_week', record)).toBe('2026-W40')
    expect(valueOf('vote_date', record)).toEqual(new Date('2026-10-04T00:00:00.000Z'))
  })

  it('labels ISO weeks the way Postgres does at the year boundary', () => {
    expect(isoWeekLabel(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01') // a Thursday
    expect(isoWeekLabel(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53') // a Friday
    expect(isoWeekLabel(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01') // a Monday
    expect(isoWeekLabel(new Date('2026-10-09T23:59:59Z'))).toBe('2026-W41')
    expect(utcDay(new Date('2026-10-09T23:59:59Z')).toISOString()).toBe('2026-10-09T00:00:00.000Z')
  })

  it('reads the reason in the reader’s language, and none on a helpful vote', () => {
    expect(valueOf('reason_label')).toBe('Ungenau')
    expect(valueOf('reason_label', feedbackExportRecord({ verdict: 'up', reason: null }))).toBeNull()
  })

  it('reports the browser’s duration in seconds, and the answer’s length', () => {
    expect(valueOf('client_duration_s')).toBeCloseTo(41.23)
    expect(valueOf('answer_chars')).toBe(feedbackExportRecord().answer!.length)
    expect(valueOf('answer_chars', feedbackExportRecord({ answer: null }))).toBeNull()
  })

  it('withholds a helpful rate under five votes, where a percentage is noise', () => {
    expect(helpfulRate(2, 2)).toBeNull()
    expect(helpfulRate(4, 1)).toBe(0.8)
    const coverage = FEEDBACK_WEEKLY_COLUMNS.find((column) => column.key === 'coverage')!
    expect(coverage.value(feedbackWeeklyRecord({ answers: 0, ratedAnswers: 0 }), de)).toBeNull()
  })
})
