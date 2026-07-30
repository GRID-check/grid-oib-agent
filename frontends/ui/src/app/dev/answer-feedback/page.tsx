'use client'

/**
 * Dev preview for the platform's answer-feedback surface — the REAL
 * `AnswerFeedbackHealth`, fed a fixture over a stubbed fetch.
 *
 * The fetch shim is installed at MODULE SCOPE, not in an effect: the component
 * fetches in its own mount effect, which runs before a parent effect could have
 * replaced `window.fetch`, so a shim installed later would race the first load.
 *
 * The fixture is chosen to carry the two cases the surface exists to tell apart:
 * a defect whose turn WAS persisted (question + answer, the drill-in working)
 * and one whose turn was not (`message_id` has no FK to `messages`), which must
 * still be listed and must say why it is bare.
 *
 * Not linked from anywhere; 404s outside development. Pinned to German — the
 * primary product language — with `fixedLocale`, so the evidence is the copy
 * that ships whoever captures it.
 */

import { notFound } from 'next/navigation'

import { AnswerFeedbackHealth } from '@/features/platform/components/answer-feedback-health'
import { I18nProvider } from '@/i18n'

const ago = (minutes: number): string => new Date(Date.parse('2026-07-30T10:00:00Z') - minutes * 60_000).toISOString()

const FIXTURE = {
  windowDays: 30,
  answers: 1284,
  // 19 down-votes, but from only 4 people — the number that stops the headline
  // rate being read as "19 users had a bad experience".
  totals: { up: 128, down: 19, voters: 31, downVoters: 4 },
  reasons: [
    { reason: 'inaccurate', count: 11 },
    { reason: 'wrong_source', count: 5 },
    { reason: 'other', count: 3 },
  ],
  daily: [
    { day: '2026-07-01', up: 7, down: 3 },
    { day: '2026-07-02', up: 8, down: 3 },
    { day: '2026-07-03', up: 5, down: 1 },
    { day: '2026-07-04', up: 5, down: 1 },
    { day: '2026-07-05', up: 2, down: 0 },
    { day: '2026-07-06', up: 7, down: 1 },
    { day: '2026-07-07', up: 9, down: 2 },
    { day: '2026-07-10', up: 7, down: 1 },
    { day: '2026-07-11', up: 10, down: 1 },
    { day: '2026-07-12', up: 5, down: 1 },
    { day: '2026-07-13', up: 2, down: 0 },
    { day: '2026-07-14', up: 10, down: 1 },
    { day: '2026-07-15', up: 7, down: 1 },
    { day: '2026-07-16', up: 6, down: 1 },
    { day: '2026-07-17', up: 6, down: 1 },
    { day: '2026-07-18', up: 8, down: 1 },
    { day: '2026-07-19', up: 6, down: 1 },
    { day: '2026-07-20', up: 7, down: 1 },
    { day: '2026-07-22', up: 5, down: 1 },
    { day: '2026-07-23', up: 7, down: 1 },
    { day: '2026-07-24', up: 9, down: 2 },
    { day: '2026-07-25', up: 11, down: 1 },
    { day: '2026-07-26', up: 11, down: 1 },
    { day: '2026-07-27', up: 7, down: 1 },
    { day: '2026-07-28', up: 8, down: 0 },
    { day: '2026-07-29', up: 8, down: 1 },
    { day: '2026-07-30', up: 9, down: 1 },
  ],
  organizations: [
    { organizationId: 'org_arch_buero', up: 120, down: 17, voters: 28 },
    // Deliberately below the floor: one down-vote out of two is 50%, which would
    // otherwise sort near the top looking like a problem.
    { organizationId: 'org_planwerk', up: 1, down: 1, voters: 1 },
    { organizationId: 'org_stadtplan', up: 7, down: 1, voters: 3 },
  ],
  defects: [
    {
      id: 'f-1',
      organizationId: 'org_arch_buero',
      projectId: null,
      conversationId: 'c-atrium',
      messageId: 'm-1',
      reason: 'inaccurate',
      createdAt: ago(45),
      question: 'Gilt die 40-m-Grenze für Fluchtweglängen auch für das nördliche Treppenhaus?',
      answer:
        'Die maximale Fluchtweglänge beträgt 40 m. Für das nördliche Treppenhaus gilt dieselbe Grenze, da es als notwendiger Treppenraum ausgeführt ist.',
      conversationTitle: 'Atrium — Rauchabschnitte GK 4',
    },
    {
      id: 'f-2',
      organizationId: 'org_arch_buero',
      projectId: null,
      conversationId: 'c-brand',
      messageId: 'm-2',
      reason: 'wrong_source',
      createdAt: ago(210),
      question: 'Welche OIB-Richtlinie regelt die Brandabschnittsgrößen für Gebäudeklasse 4?',
      answer: 'Das ist in OIB-Richtlinie 2 geregelt, Punkt 3.1.',
      conversationTitle: 'Brandabschnitte',
    },
    {
      id: 'f-3',
      organizationId: 'org_planwerk',
      projectId: null,
      conversationId: null,
      messageId: 'm-unpersisted',
      reason: 'other',
      createdAt: ago(1400),
      // The honest edge case: nothing to join, so the row carries the signal and
      // says why it carries nothing else.
      question: null,
      answer: null,
      conversationTitle: null,
    },
  ],
}

if (typeof window !== 'undefined') {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/platform/answer-feedback')) {
      return new Response(JSON.stringify(FIXTURE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return real(input, init)
  }
}

export default function AnswerFeedbackPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="answer-feedback-preview"
        className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8"
      >
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Antwort-Feedback</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Was Nutzer von ihren Antworten hielten — und die Fragen hinter den misslungenen.
          </p>
        </header>
        <AnswerFeedbackHealth />
      </main>
    </I18nProvider>
  )
}
