'use client'

/**
 * Dev preview for Platform → Feedback — the real `FeedbackTriage` with an
 * in-memory client, so the list, the filters, a deep-linked report and a
 * status change can be reviewed and screenshotted without a backend. 404s
 * outside development.
 *
 *   /dev/platform-feedback               an owner who may triage
 *   /dev/platform-feedback?focus=f2      as reached from an inbox row
 *   /dev/platform-feedback?readonly=1    Platform Support: view only
 *   /dev/platform-feedback?empty=1       nothing new
 */

import type { JSX } from 'react'
import * as React from 'react'
import { useSearchParams } from 'next/navigation'

import { PageHeader } from '@/components/ui/page-header'
import { I18nProvider, useTranslations } from '@/i18n'
import {
  FeedbackTriage,
  type FeedbackTriageClient,
} from '@/features/product-feedback/components/feedback-triage'
import type { ProductFeedbackReportView, ProductFeedbackStatus } from '@/lib/product-feedback/types'

const now = Date.now()
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

const CONTEXT = {
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
  viewport: '1512×864',
  locale: 'de-AT',
  timeZone: 'Europe/Vienna',
}

const SEED: ProductFeedbackReportView[] = [
  {
    id: 'f1',
    kind: 'bug',
    status: 'new',
    message:
      'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen, auch nach 10 Minuten. Nach einem Neuladen ist die Datei nicht im Projekt.',
    pagePath: '/app/projects/3f2a/files',
    context: CONTEXT,
    allowContact: true,
    organizationId: 'org_nord',
    organizationName: 'Architekturbüro Nord',
    reporter: { userId: 'u1', name: 'Maria Huber', email: 'maria.huber@buero-nord.at' },
    triagedBy: null,
    triagedAt: null,
    createdAt: ago(4),
    updatedAt: ago(4),
  },
  {
    id: 'f2',
    kind: 'idea',
    status: 'new',
    message:
      'Es wäre großartig, wenn ich eine Antwort direkt als Aktennotiz ins Archiv legen könnte, mit Quellenangaben.\n\nDerzeit kopiere ich alles händisch in Word.',
    pagePath: '/app/projects/3f2a/chat',
    context: CONTEXT,
    allowContact: true,
    organizationId: 'org_sued',
    organizationName: 'Ingenieurbüro Süd',
    reporter: { userId: 'u2', name: 'Thomas Leitner', email: 'leitner@ib-sued.at' },
    triagedBy: null,
    triagedAt: null,
    createdAt: ago(95),
    updatedAt: ago(95),
  },
  {
    id: 'f3',
    kind: 'praise',
    status: 'new',
    message:
      'Die Herleitung der OIB-2-Anforderungen hat uns heute einen halben Tag gespart. Danke!',
    pagePath: '/app/projects/9c1d/chat',
    context: {},
    allowContact: false,
    organizationId: 'org_nord',
    organizationName: 'Architekturbüro Nord',
    reporter: { userId: 'u3', name: 'Sabine Gruber', email: null },
    triagedBy: null,
    triagedAt: null,
    createdAt: ago(60 * 26),
    updatedAt: ago(60 * 26),
  },
  {
    id: 'f4',
    kind: 'question',
    status: 'in_progress',
    message:
      'Kann ich eigene Normen (z. B. ÖNORM B 1600) hochladen, damit Piloti sie berücksichtigt?',
    pagePath: '/app/archiv',
    context: CONTEXT,
    allowContact: true,
    organizationId: 'org_west',
    organizationName: 'Planungsgruppe West',
    reporter: { userId: 'u4', name: 'Lukas Berger', email: 'lb@pg-west.at' },
    triagedBy: 'owner@piloti.at',
    triagedAt: ago(60 * 20),
    createdAt: ago(60 * 48),
    updatedAt: ago(60 * 20),
  },
]

function memoryClient(empty: boolean): FeedbackTriageClient {
  let reports = empty ? [] : SEED.map((report) => ({ ...report }))
  const counts = () =>
    reports.reduce<Record<ProductFeedbackStatus, number>>(
      (acc, report) => ({ ...acc, [report.status]: acc[report.status] + 1 }),
      { new: 0, in_progress: 0, resolved: 0, dismissed: 0 }
    )
  return {
    list: async ({ status, kind }) => ({
      reports: reports.filter(
        (report) => (!status || report.status === status) && (!kind || report.kind === kind)
      ),
      counts: counts(),
      nextCursor: null,
    }),
    get: async (id) => reports.find((report) => report.id === id) ?? null,
    triage: async (id, status) => {
      reports = reports.map((report) =>
        report.id === id
          ? { ...report, status, triagedBy: 'owner@piloti.at', triagedAt: new Date().toISOString() }
          : report
      )
      const updated = reports.find((report) => report.id === id)
      if (!updated) throw new Error('unknown')
      return updated
    },
  }
}

/** The real page's header, so the capture shows the card in its context. */
function PreviewHeader(): JSX.Element {
  const t = useTranslations('platform')
  return (
    <PageHeader title={t('sections.feedback.title')} subtitle={t('sections.feedback.subtitle')} />
  )
}

function Preview(): JSX.Element {
  const params = useSearchParams()
  const empty = params.get('empty') === '1'
  const client = React.useMemo(() => memoryClient(empty), [empty])
  return (
    <I18nProvider initialLocale={params.get('lang') === 'en' ? 'en' : 'de'} fixedLocale>
      <div className="bg-background min-h-dvh px-4 py-8 md:px-8">
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
          <PreviewHeader />
          <FeedbackTriage
            canTriage={params.get('readonly') !== '1'}
            focusReportId={params.get('focus')}
            client={client}
          />
        </div>
      </div>
    </I18nProvider>
  )
}

export default function PlatformFeedbackDevPage(): JSX.Element {
  return (
    <React.Suspense>
      <Preview />
    </React.Suspense>
  )
}
