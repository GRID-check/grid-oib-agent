/**
 * @vitest-environment node
 */

import { describe, expect, test } from 'vitest'
import { researchSessionState, type ResearchSessionInput } from './research-session-state'

/** No research anywhere — the state every case starts from. */
const idle: ResearchSessionInput = {
  latestJobStatus: null,
  ephemeralStatus: null,
  isStreaming: false,
  streamOwnerConversationId: null,
  conversationId: 'session-1',
}

const state = (overrides: Partial<ResearchSessionInput> = {}) =>
  researchSessionState({ ...idle, ...overrides })

describe('researchSessionState', () => {
  test('a session that never ran research is in none of the three states', () => {
    expect(state()).toEqual({ isSuccessful: false, isFailed: false, isInProgress: false })
  })

  describe('persisted state (survives a reload or session switch)', () => {
    test('a completed run locks the composer', () => {
      expect(state({ latestJobStatus: 'success' }).isSuccessful).toBe(true)
    })

    test.each(['failure', 'interrupted'] as const)(
      'a %s run leaves the composer usable',
      (latestJobStatus) => {
        expect(state({ latestJobStatus })).toMatchObject({ isSuccessful: false, isFailed: true })
      }
    )

    test.each(['submitted', 'running'] as const)(
      'a %s run counts as in progress',
      (latestJobStatus) => {
        expect(state({ latestJobStatus }).isInProgress).toBe(true)
      }
    )
  })

  /*
    The pair the old inline scans got half right. Both are two-run sessions, and
    only the LATEST run describes the session — an "any message ever succeeded"
    scan agrees with the first case and contradicts the second.
  */
  describe('a session that ran research twice', () => {
    test('success after a failure locks the composer', () => {
      // The caller has already reduced the history to its latest job.
      expect(state({ latestJobStatus: 'success' })).toMatchObject({
        isSuccessful: true,
        isFailed: false,
      })
    })

    test('failure after a success does NOT lock the composer (UX-12)', () => {
      expect(state({ latestJobStatus: 'failure' })).toMatchObject({
        isSuccessful: false,
        isFailed: true,
      })
    })
  })

  describe('the live stream in this tab', () => {
    test('a stream on THIS conversation is in progress', () => {
      expect(
        state({
          isStreaming: true,
          ephemeralStatus: 'running',
          streamOwnerConversationId: 'session-1',
        }).isInProgress
      ).toBe(true)
    })

    test("a stream on ANOTHER conversation does not block this one's composer", () => {
      expect(
        state({
          isStreaming: true,
          ephemeralStatus: 'running',
          streamOwnerConversationId: 'session-2',
        })
      ).toEqual({ isSuccessful: false, isFailed: false, isInProgress: false })
    })

    test('a settled ephemeral success locks the composer before anything is persisted', () => {
      expect(state({ ephemeralStatus: 'success' }).isSuccessful).toBe(true)
    })

    test.each(['failure', 'interrupted'] as const)(
      'a settled ephemeral %s leaves the composer usable',
      (ephemeralStatus) => {
        expect(state({ ephemeralStatus })).toMatchObject({ isSuccessful: false, isFailed: true })
      }
    )

    test('an in-flight status is not read as an outcome', () => {
      // 'success' while still streaming is a status the run has not reached yet;
      // reading it as settled would lock the composer mid-run.
      expect(
        state({
          isStreaming: true,
          ephemeralStatus: 'success',
          streamOwnerConversationId: 'session-1',
        })
      ).toMatchObject({ isSuccessful: false, isFailed: false })
    })
  })

  test('a persisted success out-ranks an ephemeral failure', () => {
    // Whichever side reports the report, the session has one.
    expect(
      state({ latestJobStatus: 'success', ephemeralStatus: 'failure' })
    ).toMatchObject({ isSuccessful: true, isFailed: false })
  })
})
