'use client'

/**
 * Dev preview for Platform → Basiswissen (ADR-0016). Renders the REAL manager
 * the way the route does (PageHeader, then the component) with fixture data:
 * the four corpus numbers, the toolbar, the sortable table and the pager, and
 * below it the read-only support role, which sees the same corpus without a
 * single write control. The fixture carries every lifecycle state worth seeing
 * (indexing, failed, outdated, no longer listed), so the status column and the
 * Issues number are reviewed with real content. A module-scope fetch shim
 * (browser + dev only) serves the corpus status. Pinned to German, the primary
 * product language. Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { SectionLabel } from '@/components/ui/section-label'
import { BaseKnowledge } from '@/app/app/(shell)/platform/base-knowledge'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { I18nProvider, useTranslations } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'

/** Each fixture document with the type it really has, so the type column reads true. */
const DOCUMENTS: [title: string, docClass: string][] = [
  ['OIB-Richtlinie 2 — Brandschutz, Ausgabe 2023', 'oib_richtlinie'],
  ['OIB-Leitfaden Barrierefreiheit', 'oib_leitfaden'],
  ['OIB-Erläuterungen zu Richtlinie 4', 'oib_erlaeuterung'],
  ['OIB-Begriffsbestimmungen 2023', 'oib_begriffe'],
  ['OIB-Referenzdokument Energieausweis', 'oib_referenz'],
  ['OIB-Änderungsdokument 2023/2019', 'oib_aenderung'],
  ['ÖNORM B 1600 — Barrierefreies Bauen', 'norm_extern'],
  ['Wiener Bauordnung — Konsolidierte Fassung', 'gesetz'],
  ['Praxisnotiz Fluchtwegbreiten', 'sonstiges'],
  ['OIB-Richtlinie 3 — Hygiene, Ausgabe 2023', 'oib_richtlinie'],
  ['OIB-Richtlinie 5 — Schallschutz, Ausgabe 2023', 'oib_richtlinie'],
  ['ÖNORM B 8110-1 — Wärmeschutz', 'norm_extern'],
  ['Niederösterreichische Bautechnikverordnung', 'gesetz'],
  ['Merkblatt Rauchwarnmelder', 'sonstiges'],
]

/** Lifecycle per row, by index: the states the Issues number and the status column exist for. */
const STATES: Record<number, string> = { 3: 'pending', 8: 'stale', 11: 'failed', 13: 'removed' }

// 14 rows: more than one page (10), so the pager is exercised in the shot.
const FILES = DOCUMENTS.map(([title, docClass], index) => ({
  fileName: `base-dokument-${String(index + 1).padStart(2, '0')}.pdf`,
  state: STATES[index] ?? 'ingested',
  sizeBytes: 240_000 + index * 61_000,
  chunkCount: STATES[index] === 'pending' || STATES[index] === 'failed' ? 0 : 38 + index * 11,
  ingestedSha256: null,
  currentSha256: null,
  ingestedAt: '2026-07-14T09:00:00Z',
  summary:
    index === 0
      ? 'Brandschutzanforderungen für Gebäude: Tragfähigkeit im Brandfall, Brandabschnitte, Fluchtwege und Rauchableitung.'
      : null,
  docClass,
  docClassSuggestion: index === 8 ? 'oib_leitfaden' : null,
  displayTitle: title,
}))

const STATUS = {
  collectionName: 'oib_base',
  collectionExists: true,
  collectionUpdatedAt: '2026-07-20T09:00:00Z',
  summary: {
    totalFiles: FILES.length,
    ingested: FILES.filter((f) => f.state === 'ingested').length,
    stale: FILES.filter((f) => f.state === 'stale').length,
    pending: FILES.filter((f) => f.state === 'pending').length,
    failed: FILES.filter((f) => f.state === 'failed').length,
    removed: FILES.filter((f) => f.state === 'removed').length,
    inconsistent: 0,
    totalChunks: FILES.reduce((sum, f) => sum + f.chunkCount, 0),
  },
  files: FILES,
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformKnowledgeShim?: boolean }
  if (!w.__platformKnowledgeShim) {
    w.__platformKnowledgeShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/knowledge-base')) {
        return Response.json(STATUS)
      }
      return real(input, init)
    }
  }
}

function Preview(): JSX.Element {
  const t = useTranslations('platform')
  return (
    <main
      className="mx-auto flex max-w-5xl flex-col gap-12 px-4 py-8 md:px-8"
      data-testid="platform-knowledge-preview"
    >
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t('sections.knowledge.title')}
          subtitle={t('sections.knowledge.subtitle')}
        />
        <BaseKnowledge />
      </div>

      {/* The read-only support role: the corpus and every detail, no write control. */}
      <section className="flex flex-col gap-6">
        <SectionLabel as="h2">Nur Lesezugriff (platform:settings:view)</SectionLabel>
        <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
          <BaseKnowledge />
        </PlatformAccessProvider>
      </section>
    </main>
  )
}

export default function PlatformKnowledgeDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Preview />
    </I18nProvider>
  )
}
