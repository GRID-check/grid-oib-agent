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

import { useState } from 'react'
import { notFound } from 'next/navigation'

import { AnswerFeedback } from '@/features/chat/components/AnswerFeedback'
import { AnswerFeedbackHealth } from '@/features/platform/components/answer-feedback-health'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { I18nProvider } from '@/i18n'

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

/**
 * The trend fills its window back from TODAY, so the fixture's days are
 * relative too: dated fixtures fell out of the window and the chart rendered
 * as "not enough days" in every capture taken a month later.
 */
const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)

const DAILY_SHAPE: [number, number, number][] = [
  [29, 7, 3],
  [28, 8, 3],
  [27, 5, 1],
  [26, 5, 1],
  [25, 2, 0],
  [24, 7, 1],
  [23, 9, 2],
  [20, 7, 1],
  [19, 10, 1],
  [18, 5, 1],
  [17, 2, 0],
  [16, 10, 1],
  [15, 7, 1],
  [14, 6, 1],
  [13, 6, 1],
  [12, 8, 1],
  [11, 6, 1],
  [10, 7, 1],
  [8, 5, 1],
  [7, 7, 1],
  [6, 9, 2],
  [5, 11, 1],
  [4, 11, 1],
  [3, 7, 1],
  [2, 8, 0],
  [1, 8, 1],
  [0, 9, 1],
]

const TRACE = (id: string): string => `https://cloud.langfuse.com/project/piloti-prod/traces/${id}`

const FIXTURE = {
  windowDays: 30,
  answers: 1284,
  // 19 down-votes, but from only 4 people — the number that stops the headline
  // rate being read as "19 users had a bad experience".
  totals: { up: 128, down: 19, voters: 31, downVoters: 4 },
  reasons: [
    { reason: 'inaccurate', count: 11 },
    { reason: 'wrong_source', count: 5 },
    // A NULL reason and an explicit 'other' both mean "other": the bar adds them.
    { reason: 'other', count: 2 },
    { reason: null, count: 1 },
  ],
  daily: DAILY_SHAPE.map(([n, up, down]) => ({ day: daysAgo(n), up, down })),
  organizations: [
    {
      organizationId: 'org_arch_buero',
      organizationName: 'Architekturbüro Hofer & Partner',
      up: 120,
      down: 17,
      voters: 28,
    },
    // Deliberately below the floor: one vote either way is 0% or 100%, which
    // would otherwise sort near the top looking like a verdict.
    {
      organizationId: 'org_planwerk',
      organizationName: 'Planwerk Graz',
      up: 1,
      down: 1,
      voters: 1,
    },
    // No name from the server: the row falls back to the id, in mono.
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
      organizationName: 'Architekturbüro Hofer & Partner',
      projectId: null,
      conversationId: 'c-atrium',
      messageId: 'm-1',
      verdict: 'down',
      reason: 'inaccurate',
      createdAt: ago(45),
      question: 'Gilt die 40-m-Grenze für Fluchtweglängen auch für das nördliche Treppenhaus?',
      answer:
        'Die maximale Fluchtweglänge beträgt 40 m. Für das nördliche Treppenhaus gilt dieselbe Grenze, da es als notwendiger Treppenraum ausgeführt ist.',
      conversationTitle: 'Atrium, Rauchabschnitte GK 4',
      topics: ['brandschutz'],
      comment:
        'Das nördliche Treppenhaus ist ein Sicherheitstreppenhaus, da gilt eine andere Regel.',
      expectedAnswer:
        'Bei Sicherheitstreppenhäusern darf die Fluchtweglänge laut OIB-RL 2, Punkt 5.1.3 bis zu 50 m betragen.',
      langfuseTraceUrl: TRACE('7c1e2f04a9'),
    },
    {
      id: 'f-2',
      organizationId: 'org_arch_buero',
      organizationName: 'Architekturbüro Hofer & Partner',
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
      comment: null,
      expectedAnswer: 'OIB-RL 2, Tabelle 1b, nicht Punkt 3.1.',
      langfuseTraceUrl: TRACE('b31d9e6c20'),
    },
    {
      id: 'f-3',
      organizationId: 'org_planwerk',
      organizationName: 'Planwerk Graz',
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
      comment: null,
      expectedAnswer: null,
      // No trace either: the Langfuse button must not appear for this one.
      langfuseTraceUrl: null,
    },
  ],
  langfuse: { projectUrl: 'https://cloud.langfuse.com/project/piloti-prod' },
}

/** The praised half, served when the drill-in is switched to `verdict=up`. */
const LANDED = [
  {
    id: 'g-1',
    organizationId: 'org_arch_buero',
    organizationName: 'Architekturbüro Hofer & Partner',
    projectId: null,
    conversationId: 'c-u-wert',
    messageId: 'm-11',
    verdict: 'up',
    reason: null,
    createdAt: ago(90),
    question: 'Welcher U-Wert gilt für Außenwände bei einer thermischen Sanierung im Bestand?',
    answer:
      'Für Außenwände gegen Außenluft fordert OIB-Richtlinie 6 einen U-Wert von höchstens 0,35 W/(m²·K); im Bestand gilt dieser Wert bei einer größeren Renovierung.',
    conversationTitle: 'Sanierung Gründerzeit, Wärmeschutz',
    topics: ['energie'],
    comment: null,
    expectedAnswer: null,
    langfuseTraceUrl: TRACE('e90a11c7d2'),
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
    conversationTitle: 'Wohnbau Nord, Erschließung',
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
      'Fast alle negativen Stimmen stammen aus einer einzigen Organisation, die Quote der übrigen ist unauffällig.',
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
const TURN_STATES: Record<
  string,
  { messageId: string; verdict: string; reason: string | null; comment: string | null }[]
> = {
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
      // Enough of the server's filtering that every control in the preview does
      // something visible: the window trims the days, the drill-in filters trim
      // the rows. The aggregates stay whole, which is what the server does for
      // reason and free text.
      const params = new URL(url, 'http://x').searchParams
      const windowDays = Number(params.get('days') ?? 30)
      const q = (params.get('q') ?? '').toLowerCase()
      const turns = (params.get('verdict') === 'up' ? LANDED : FIXTURE.turns).filter(
        (turn) =>
          (!params.get('reason') || turn.reason === params.get('reason')) &&
          (!params.get('org') || turn.organizationId === params.get('org')) &&
          (!params.get('topic') || (turn.topics as string[]).includes(params.get('topic') ?? '')) &&
          (!q || `${turn.question ?? ''} ${turn.answer ?? ''}`.toLowerCase().includes(q))
      )
      const daily = FIXTURE.daily.filter((point) => point.day >= daysAgo(windowDays - 1))
      return new Response(JSON.stringify({ ...FIXTURE, windowDays, daily, turns }), {
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
  // The window belongs to the page (the quality workspace); this stands in for
  // its control so the preview exercises the `days` prop the way the page does.
  const [days, setDays] = useState(30)

  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="answer-feedback-preview"
        className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-6 md:px-8 md:py-8"
      >
        <section className="flex flex-col gap-4">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Antwort-Feedback</h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Plattform → Antwortqualität → Bewertungen, aus Fixtures.
              </p>
            </div>
            <ToggleGroup
              type="single"
              size="sm"
              value={String(days)}
              onValueChange={(value) => value && setDays(Number(value))}
              aria-label="Zeitraum"
            >
              {[7, 30, 90].map((option) => (
                <ToggleGroupItem key={option} value={String(option)}>
                  {option} Tage
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </header>
          <AnswerFeedbackHealth days={days} />
        </section>

        <section data-testid="answer-feedback-states" className="space-y-3">
          <h2 className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
            Die Fußnote unter der Antwort — jeder Zustand
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {FOOTNOTE_STATES.map((state) => (
              <div
                key={state.id}
                className={`bg-card flex flex-col gap-2 rounded-lg border p-4 ${state.wide ? 'md:col-span-2' : ''}`}
              >
                <p className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
                  {state.label}
                </p>
                <div className="bg-background rounded-lg border px-4 py-3">
                  <p className="text-foreground text-sm leading-relaxed">{state.answer}</p>
                  <div className="mt-2.5">
                    <AnswerFeedback messageId="af-msg" conversationId={state.id} />
                  </div>
                </div>
                <p className="text-muted-foreground text-xs">{state.caption}</p>
              </div>
            ))}

            {/* The `compact` placement is NOT rebuilt here. A hand-built meta
                row is a fork of the answer footer, and this one had already
                drifted from it — it carried a confidence chip and a timestamp
                the footer has since moved behind „Antwortdetails", and it never
                carried the copy actions at all. So it showed the resting row
                on a row that no longer exists, and the open disclosure — the
                state that actually broke the footer's layout — was never on it.
                The real thing, in the real card, is one route away. */}
            <div className="bg-card flex flex-col gap-2 rounded-lg border p-4">
              <p className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">
                Kompakt — in der Meta-Zeile der Antwort
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Die Fußnote in der echten Antwort-Fußzeile, in Ruhe und offen:{' '}
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[11px]">
                  /dev/chat-turn?variant=feedback-open
                </code>
                . Hier steht die Komponente für sich — die Zeile, die sie tragen muss, steht dort.
              </p>
            </div>
          </div>
        </section>
      </main>
    </I18nProvider>
  )
}
