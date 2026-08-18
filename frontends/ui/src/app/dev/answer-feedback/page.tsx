'use client'

/**
 * Dev preview for the platform's answer-feedback surface — the REAL
 * `AnswerFeedbackHealth`, fed a fixture over a stubbed fetch.
 *
 * The fetch shim is installed at MODULE SCOPE, not in an effect: the component
 * fetches in its own mount effect, which runs before a parent effect could have
 * replaced `window.fetch`, so a shim installed later would race the first load.
 *
 * The fixture carries the cases the surface exists to tell apart: a turn whose
 * conversation WAS persisted (question + answer + topics, the drill-in working)
 * and one whose turn was not (`message_id` has no FK to `messages`), which must
 * still be listed and must say why it is bare — plus a topic and an organization
 * below the rate floor, which must show counts and withhold a percentage.
 *
 * The digest is stubbed too, with a written-out example rather than a lorem
 * paragraph: it is the most prominent copy on the card and the screenshot is the
 * only place anybody reviews it before it ships.
 *
 * Not linked from anywhere; 404s outside development. Pinned to German — the
 * primary product language — with `fixedLocale`, so the evidence is the copy
 * that ships whoever captures it.
 */

import { notFound } from 'next/navigation'

import { AnswerFeedback } from '@/features/chat/components/AnswerFeedback'
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
    // Deliberately below the floor: one vote either way is 0% or 100%, which
    // would otherwise sort near the top looking like a verdict.
    { organizationId: 'org_planwerk', up: 1, down: 1, voters: 1 },
    { organizationId: 'org_stadtplan', up: 7, down: 1, voters: 3 },
  ],
  topics: [
    { topic: 'brandschutz', up: 41, down: 9, voters: 14 },
    { topic: 'energie', up: 33, down: 2, voters: 11 },
    { topic: 'schallschutz', up: 12, down: 6, voters: 7 },
    { topic: 'barrierefreiheit', up: 9, down: 1, voters: 5 },
    // Below the floor: counts, no rate.
    { topic: 'statik', up: 2, down: 1, voters: 2 },
  ],
  turns: [
    {
      id: 'f-1',
      organizationId: 'org_arch_buero',
      projectId: null,
      conversationId: 'c-atrium',
      messageId: 'm-1',
      verdict: 'down',
      reason: 'inaccurate',
      createdAt: ago(45),
      question: 'Gilt die 40-m-Grenze für Fluchtweglängen auch für das nördliche Treppenhaus?',
      answer:
        'Die maximale Fluchtweglänge beträgt 40 m. Für das nördliche Treppenhaus gilt dieselbe Grenze, da es als notwendiger Treppenraum ausgeführt ist.',
      conversationTitle: 'Atrium — Rauchabschnitte GK 4',
      topics: ['brandschutz'],
    },
    {
      id: 'f-2',
      organizationId: 'org_arch_buero',
      projectId: null,
      conversationId: 'c-brand',
      messageId: 'm-2',
      verdict: 'down',
      reason: 'wrong_source',
      createdAt: ago(210),
      question: 'Welche OIB-Richtlinie regelt die Brandabschnittsgrößen für Gebäudeklasse 4?',
      answer: 'Das ist in OIB-Richtlinie 2 geregelt, Punkt 3.1.',
      conversationTitle: 'Brandabschnitte',
      topics: ['brandschutz', 'allgemein'],
    },
    {
      id: 'f-3',
      organizationId: 'org_planwerk',
      projectId: null,
      conversationId: null,
      messageId: 'm-unpersisted',
      verdict: 'down',
      reason: 'other',
      createdAt: ago(1400),
      // The honest edge case: nothing to join, so the row carries the signal and
      // says why it carries nothing else.
      question: null,
      answer: null,
      conversationTitle: null,
      topics: [],
    },
  ],
}

/** The praised half, served when the drill-in is switched to `verdict=up`. */
const LANDED = [
  {
    id: 'g-1',
    organizationId: 'org_arch_buero',
    projectId: null,
    conversationId: 'c-u-wert',
    messageId: 'm-11',
    verdict: 'up',
    reason: null,
    createdAt: ago(90),
    question: 'Welcher U-Wert gilt für Außenwände bei einer thermischen Sanierung im Bestand?',
    answer:
      'Für Außenwände gegen Außenluft fordert OIB-Richtlinie 6 einen U-Wert von höchstens 0,35 W/(m²·K); im Bestand gilt dieser Wert bei einer größeren Renovierung.',
    conversationTitle: 'Sanierung Gründerzeit — Wärmeschutz',
    topics: ['energie'],
  },
  {
    id: 'g-2',
    organizationId: 'org_stadtplan',
    projectId: null,
    conversationId: 'c-lift',
    messageId: 'm-12',
    verdict: 'up',
    reason: null,
    createdAt: ago(320),
    question: 'Ab wann ist ein Aufzug barrierefrei erforderlich?',
    answer:
      'OIB-Richtlinie 4 verlangt einen Aufzug, sobald mehr als eine Geschoßebene barrierefrei erschlossen werden muss.',
    conversationTitle: 'Wohnbau Nord — Erschließung',
    topics: ['barrierefreiheit'],
  },
]

const DIGEST = {
  digest: {
    headline:
      'In den letzten 30 Tagen wurden 147 Antworten bewertet, 87 % davon als hilfreich. Die Quote hat sich gegenüber dem Beginn des Zeitraums leicht verbessert. Bewertet wurde rund jede zehnte Antwort, die negativen Stimmen stammen von vier Personen.',
    strengths: [
      'Fragen zu Wärmeschutz und U-Werten werden fast durchgehend als hilfreich bewertet.',
      'Barrierefreiheits-Fragen liegen ebenfalls deutlich im positiven Bereich, wenn auch bei kleiner Stichprobe.',
    ],
    concerns: [
      'Die meisten negativen Bewertungen betreffen Fluchtweg- und Brandabschnittsfragen und sind als „ungenau" begründet.',
      'Fast alle negativen Stimmen stammen aus einer einzigen Organisation — die Quote der übrigen ist unauffällig.',
    ],
    recommendation:
      'Die als ungenau markierten Brandschutz-Antworten durchsehen und prüfen, ob die zitierte Stelle der OIB-Richtlinie 2 jeweils die richtige ist.',
    generatedAt: ago(22),
    windowDays: 30,
    votes: 147,
  },
  error: null,
}

/**
 * The per-answer footnote's own states, keyed by conversation id.
 *
 * `useAnswerFeedback` hydrates ONE GET per conversation, so giving each state
 * its own conversation is what lets five copies of the real component sit on
 * one page in five different states — no props, no test hooks, the same code
 * path a real answer takes.
 */
const TURN_STATES: Record<string, { messageId: string; verdict: string; reason: string | null; comment: string | null }[]> = {
  'af-rest': [],
  'af-up': [{ messageId: 'af-msg', verdict: 'up', reason: null, comment: null }],
  'af-down': [{ messageId: 'af-msg', verdict: 'down', reason: null, comment: null }],
  'af-note': [{ messageId: 'af-msg', verdict: 'down', reason: 'inaccurate', comment: null }],
  'af-sent': [
    {
      messageId: 'af-msg',
      verdict: 'down',
      reason: 'wrong_source',
      comment: 'Zitiert OIB-Richtlinie 2 statt 4.',
    },
  ],
  'af-inline': [],
}

if (typeof window !== 'undefined') {
  const real = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    // The per-answer thumbs: hydration per conversation, writes always accepted.
    if (url.includes('/api/feedback/answers')) {
      const conversationId = new URL(url, 'http://x').searchParams.get('conversationId') ?? ''
      return new Response(JSON.stringify({ feedback: TURN_STATES[conversationId] ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // Checked FIRST: the digest path contains the health path as a prefix.
    if (url.includes('/api/platform/answer-feedback/digest')) {
      return new Response(JSON.stringify(DIGEST), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/platform/answer-feedback')) {
      const landed = url.includes('verdict=up')
      return new Response(JSON.stringify({ ...FIXTURE, turns: landed ? LANDED : FIXTURE.turns }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return real(input, init)
  }
}

/**
 * The footnote's progressive disclosure, left to right: what a reader sees
 * before they vote, and each step the vote opens. Every card carries a REAL
 * (short) answer above the row, because "is this a footnote or does it
 * outweigh the answer?" is the defect that cannot be judged without one.
 */
const FOOTNOTE_STATES = [
  {
    id: 'af-rest',
    label: 'In Ruhe',
    caption: 'Unter jeder Antwort — quiet bis zum Hover.',
    wide: false,
    answer: 'Für Gebäudeklasse 4 beträgt die maximale Fluchtweglänge 40 m.',
  },
  {
    id: 'af-up',
    label: 'Hilfreich',
    caption: 'Die Stimme ist gespeichert — und damit fertig.',
    wide: false,
    answer: 'Für Gebäudeklasse 4 beträgt die maximale Fluchtweglänge 40 m.',
  },
  {
    id: 'af-down',
    label: 'Nicht hilfreich — Grund wählen',
    caption: 'Die Stimme steht bereits; der Grund ist der zweite, freiwillige Akt.',
    // The down states run full width: the thread column they ship in is ~680px,
    // and a half-width preview card would wrap the reason row for reasons that
    // have nothing to do with the design.
    wide: true,
    answer: 'Für Gebäudeklasse 4 beträgt die maximale Fluchtweglänge 40 m.',
  },
  {
    id: 'af-note',
    label: 'Hinweis offen',
    caption: 'Erst nach dem Grund — Senden bleibt bis zum ersten Zeichen deaktiviert und blass.',
    wide: true,
    answer: 'Für Gebäudeklasse 4 beträgt die maximale Fluchtweglänge 40 m.',
  },
  {
    id: 'af-sent',
    label: 'Hinweis gesendet',
    caption: 'Der zweite Akt schließt sich; Stimme und Grund bleiben stehen.',
    wide: true,
    answer: 'Für Gebäudeklasse 4 beträgt die maximale Fluchtweglänge 40 m.',
  },
] as const

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
            Was Nutzer von ihren Antworten hielten — was gelungen ist, was nicht, und die Fragen dahinter.
          </p>
        </header>

        <section data-testid="answer-feedback-states" className="space-y-3">
          <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            Die Fußnote unter der Antwort — jeder Zustand
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {FOOTNOTE_STATES.map((state) => (
              <div
                key={state.id}
                className={`flex flex-col gap-2 rounded-lg border bg-card p-4 ${state.wide ? 'md:col-span-2' : ''}`}
              >
                <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                  {state.label}
                </p>
                <div className="rounded-lg border bg-background px-4 py-3">
                  <p className="text-sm leading-relaxed text-foreground">{state.answer}</p>
                  <div className="mt-2.5">
                    <AnswerFeedback messageId="af-msg" conversationId={state.id} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{state.caption}</p>
              </div>
            ))}

            {/* The placement that actually ships: `compact`, inside the answer's
                merged meta row (confidence · spacer · thumbs · timestamp). */}
            <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
              <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                Kompakt — in der Meta-Zeile der Antwort
              </p>
              <div className="rounded-lg border bg-background px-4 py-3">
                <p className="text-sm leading-relaxed text-foreground">
                  Für Gebäudeklasse 4 beträgt die maximale Fluchtweglänge 40 m.
                </p>
                <div className="mt-2.5 flex min-h-6 flex-wrap items-center gap-2">
                  <span className="inline-flex h-6 items-center rounded-md bg-muted px-2 text-[11px] text-muted-foreground">
                    Sichere Antwort
                  </span>
                  <span className="flex-1" aria-hidden="true" />
                  <AnswerFeedback compact messageId="af-msg" conversationId="af-inline" />
                  <span className="text-[11px] text-muted-foreground">09:41</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Gleiche Ruhe-Zeile, gleiche Höhe wie der Rest der Meta-Zeile.
              </p>
            </div>
          </div>
        </section>

        <AnswerFeedbackHealth />
      </main>
    </I18nProvider>
  )
}
