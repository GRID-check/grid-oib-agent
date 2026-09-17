'use client'

/**
 * Dev preview for Platform → Lessons: the failure-learning register. Renders
 * the REAL `PlatformLessons` with a fetch shim serving `/api/platform/lessons`,
 * so every register state is reviewable without a backend: an auditor-held
 * candidate, active lessons (one with its root cause already addressed), and a
 * capacity-evicted retirement. The bandage callout is part of the surface —
 * the framing is the feature.
 *
 * The shim is installed at MODULE scope, not in an effect: a child's effect
 * fires first and would race a parent's fetch patch.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { I18nProvider } from '@/i18n'
import { PlatformLessons } from '@/app/app/(shell)/platform/lessons/platform-lessons'

const LESSONS = [
  {
    id: '5f0a4c88-0000-4000-8000-000000000001',
    content:
      'Bei Fragen zu Fluchtweglängen zuerst prüfen, welche OIB-Richtlinie die Frage tatsächlich betrifft, bevor zitiert wird — nicht aus der zuletzt abgerufenen Richtlinie weiterzitieren.',
    category: 'wrong_source' as const,
    status: 'active' as const,
    heldReason: null,
    reportCount: 7,
    orgCount: 3,
    lastReportedAt: '2026-08-24T10:00:00Z',
    retiredReason: null,
    rootCauseStatus: 'open' as const,
    rootCauseNote: null,
  },
  {
    id: '5f0a4c88-0000-4000-8000-000000000002',
    content:
      'Wenn ein hochgeladener Plan keine lesbaren Maße liefert, das ausdrücklich sagen und nachfragen — keine Werte aus ähnlichen Projekten übernehmen.',
    category: 'inaccurate' as const,
    status: 'active' as const,
    heldReason: null,
    reportCount: 4,
    orgCount: 2,
    lastReportedAt: '2026-08-20T10:00:00Z',
    retiredReason: null,
    rootCauseStatus: 'addressed' as const,
    rootCauseNote: 'Retrieval-Fallback seit 0067 geschlossen.',
  },
  {
    id: '5f0a4c88-0000-4000-8000-000000000003',
    content:
      'Bei Terminfragen zur Einreichung keine Fristen schätzen, sondern auf die zuständige Behörde verweisen.',
    category: 'other' as const,
    status: 'candidate' as const,
    heldReason: 'audit_flagged',
    reportCount: 1,
    orgCount: 1,
    lastReportedAt: '2026-08-25T08:00:00Z',
    retiredReason: null,
    rootCauseStatus: 'open' as const,
    rootCauseNote: null,
  },
  {
    id: '5f0a4c88-0000-4000-8000-000000000004',
    content: 'Antworten auf Schallschutz-Fragen nicht mit veralteten ÖNORM-Ständen belegen.',
    category: 'inaccurate' as const,
    status: 'retired' as const,
    heldReason: null,
    reportCount: 2,
    orgCount: 1,
    lastReportedAt: '2026-07-02T10:00:00Z',
    retiredReason: 'evicted_capacity',
    rootCauseStatus: 'open' as const,
    rootCauseNote: null,
  },
]

const PROVENANCE = {
  lesson: LESSONS[0],
  events: [
    {
      id: 'ev-1',
      action: 'created',
      actor: 'system:distiller',
      actorEmail: null,
      detail: {},
      createdAt: '2026-08-10T09:00:00Z',
    },
    {
      id: 'ev-2',
      action: 'activated',
      actor: 'system:distiller',
      actorEmail: null,
      detail: { automatic: true },
      createdAt: '2026-08-10T09:00:01Z',
    },
    {
      id: 'ev-3',
      action: 'report_linked',
      actor: 'system:distiller',
      actorEmail: null,
      detail: {},
      createdAt: '2026-08-24T10:00:00Z',
    },
  ],
  reports: [
    {
      id: 'rp-1',
      feedbackId: '9c1c0e00-0000-4000-8000-00000000aaaa',
      outcome: 'created',
      orgHash: '3f1a9c0d22b84e55', // pragma: allowlist secret (fixture pseudonym, not a credential)
      canonicalSummary:
        'Eine Frage zu Fluchtweglängen wurde mit einem Abschnitt aus der falschen OIB-Richtlinie belegt.',
      reason: 'wrong_source',
      createdAt: '2026-08-10T08:58:00Z',
    },
    {
      id: 'rp-2',
      feedbackId: '9c1c0e00-0000-4000-8000-00000000bbbb',
      outcome: 'linked',
      orgHash: '77e02b4c91d04f10', // pragma: allowlist secret (fixture pseudonym, not a credential)
      canonicalSummary: 'Erneut wurde bei einer Fluchtweg-Frage die falsche Richtlinie zitiert.',
      reason: 'wrong_source',
      createdAt: '2026-08-24T10:00:00Z',
    },
  ],
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformLessonsShim?: boolean }
  if (!w.__platformLessonsShim) {
    w.__platformLessonsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/platform/lessons' && (!init?.method || init.method === 'GET')) {
        return Response.json({
          lessons: LESSONS,
          counts: { candidate: 1, active: 2, retired: 1 },
        })
      }
      if (url === '/api/platform/lessons' && init?.method === 'POST') {
        return Response.json({
          result: { processed: 2, created: 1, linked: 1, skipped: 0, deferred: 0 },
        })
      }
      if (url.startsWith('/api/platform/lessons/') && init?.method === 'PATCH') {
        return Response.json({ lesson: LESSONS[0] })
      }
      if (url.startsWith('/api/platform/lessons/')) {
        return Response.json(PROVENANCE)
      }
      return real(input, init)
    }
  }
}

export default function PlatformLessonsDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        className="mx-auto flex max-w-4xl flex-col gap-6 p-8"
        data-testid="platform-lessons-preview"
      >
        <PlatformLessons />
      </main>
    </I18nProvider>
  )
}
