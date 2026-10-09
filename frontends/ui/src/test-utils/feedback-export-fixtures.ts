/**
 * Fixtures for the answer-feedback export: one fully populated vote row, one
 * that rated a turn nobody stored, a week, and the export around them.
 *
 * Shared by the column, renderer and route specs and by the script that writes
 * a sample workbook, so all of them describe the same rows.
 */

import type { FeedbackExportRecord, FeedbackWeeklyRecord } from '@/lib/feedback/export-columns'
import type { FeedbackExport } from '@/lib/feedback/export-service'

/** A down-vote on a stored, researched answer, with everything the joins can reach. */
export function feedbackExportRecord(overrides: Partial<FeedbackExportRecord> = {}): FeedbackExportRecord {
  return {
    feedbackId: '7c1e0d52-5a51-4bb6-9d3b-1b2f0c6a9e01',
    organizationId: 'org_01HZXPLANUNGSBUERO',
    organizationName: 'Planungsbüro Huber',
    projectId: '3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    projectName: 'Wohnanlage Innsbruck West',
    bundesland: 'tirol',
    conversationId: 's_8d1f2e',
    conversationFound: true,
    conversationTitle: 'Fluchtwege im Stiegenhaus',
    messageId: '0f0f0f0f-0000-4000-8000-000000000002',
    voterKey: 'a1b2c3d4e5f6',
    verdict: 'down',
    reason: 'inaccurate',
    comment: 'Der Wert gilt nur für Neubau, nicht für Sanierung.',
    expectedAnswer: 'Höchstens 40 m Fluchtweglänge laut OIB-RL 2, Punkt 5.1.1',
    firstVotedAt: new Date('2026-10-06T08:15:00.000Z'),
    votedAt: new Date('2026-10-06T08:17:30.000Z'),
    question: 'Wie lang darf der Fluchtweg in GK 4 sein, und warum?',
    answer: 'Höchstens 40 m, gemessen bis zum Ausgang ins Freie.',
    answeredAt: new Date('2026-10-06T08:14:10.000Z'),
    topics: ['brandschutz', 'nutzungssicherheit'],
    answerMode: 'deep',
    answerConfidence: 'medium',
    confidenceCappedReason: 'quote_unverified',
    sourcesCited: 4,
    citationsRemoved: 1,
    researchTruncated: false,
    skills: ['oib-rl-2'],
    clientDurationMs: 41_230,
    traceId: '0f0f0f0f000040008000000000000002',
    jobId: null,
    llmCalls: 9,
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini'],
    tokensTotal: 48_210,
    costUsd: 0.183421,
    lessonId: '5b6c7d8e-9f00-4a1b-8c2d-3e4f5a6b7c8d',
    lessonStatus: 'candidate',
    lessonsHoldout: false,
    appUrl:
      'https://app.piloti.example/app/projects/3f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/chat?session=s_8d1f2e#message-0f0f0f0f-0000-4000-8000-000000000002',
    langfuseTraceUrl: 'https://langfuse.piloti.example/project/p1/traces/0f0f0f0f000040008000000000000002',
    ...overrides,
  }
}

/** An up-vote on a turn that was never stored: no answer, no cost, no link. */
export function unstoredFeedbackExportRecord(overrides: Partial<FeedbackExportRecord> = {}): FeedbackExportRecord {
  return feedbackExportRecord({
    feedbackId: '7c1e0d52-5a51-4bb6-9d3b-1b2f0c6a9e02',
    projectId: null,
    projectName: null,
    bundesland: null,
    conversationId: 's_unsaved',
    conversationFound: false,
    conversationTitle: null,
    messageId: 'af-msg',
    voterKey: 'f6e5d4c3b2a1',
    verdict: 'up',
    reason: null,
    comment: null,
    expectedAnswer: null,
    firstVotedAt: new Date('2026-10-07T12:00:00.000Z'),
    votedAt: new Date('2026-10-07T12:00:00.000Z'),
    question: null,
    answer: null,
    answeredAt: null,
    topics: [],
    answerMode: null,
    answerConfidence: null,
    confidenceCappedReason: null,
    sourcesCited: null,
    citationsRemoved: null,
    researchTruncated: null,
    skills: [],
    clientDurationMs: null,
    traceId: null,
    llmCalls: null,
    models: [],
    tokensTotal: null,
    costUsd: null,
    lessonId: null,
    lessonStatus: null,
    lessonsHoldout: null,
    appUrl: null,
    langfuseTraceUrl: null,
    ...overrides,
  })
}

export function feedbackWeeklyRecord(overrides: Partial<FeedbackWeeklyRecord> = {}): FeedbackWeeklyRecord {
  return {
    organizationId: 'org_01HZXPLANUNGSBUERO',
    organizationName: 'Planungsbüro Huber',
    isoWeek: '2026-W41',
    weekStart: '2026-10-05',
    answers: 40,
    ratedAnswers: 8,
    up: 6,
    down: 3,
    ...overrides,
  }
}

export function feedbackExport(overrides: Partial<FeedbackExport> = {}): FeedbackExport {
  return {
    generatedAt: new Date('2026-10-09T09:30:00.000Z'),
    windowFrom: new Date('2026-09-10T00:00:00.000Z'),
    windowTo: new Date('2026-10-09T09:30:00.000Z'),
    scope: 'all',
    applied: {
      windowDays: 30,
      verdict: null,
      reason: null,
      organizationId: null,
      topic: null,
      query: null,
      organizationName: null,
    },
    records: [feedbackExportRecord(), unstoredFeedbackExportRecord()],
    truncated: false,
    cap: 5000,
    totals: { votes: 2, up: 1, down: 1, voters: 2, organizations: 1 },
    weeks: [feedbackWeeklyRecord()],
    weeksTruncated: false,
    ...overrides,
  }
}
