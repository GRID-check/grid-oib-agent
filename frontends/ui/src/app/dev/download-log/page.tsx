'use client'

/**
 * Dev preview for Organisation → Download-Protokoll (ADR-0087): the REAL view
 * and the REAL retention form, over fixtures, with no backend. Not linked from
 * anywhere; 404s outside development.
 *
 * The fixture is chosen for the states that are easy to get wrong: an explicit
 * download from an ordinary folder, opens in a folder with its own access list
 * (flagged), a version opened by number, the Archiv and a chat attachment (no
 * folder), a person who has left the organization (shown by id, said so), and a
 * project and a folder that no longer exist.
 *
 * A module-scope fetch shim (browser + dev only; it must not be a `useEffect`,
 * or it loses the race with the child's own first fetch) answers the log with
 * two pages, filtered by person and by part of a document name so the filters
 * visibly work, and the retention save.
 *
 *   `?empty=1`   no entries (the empty state)
 *   `?error=1`   the read is refused (the failure state)
 *
 * Pinned to German: the committed evidence carries the copy most users see.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/ui/page-header'
import { DownloadLogRetentionForm } from '@/features/organization/components/download-log-retention-form'
import { DownloadLogView } from '@/features/organization/components/download-log-view'
import { I18nProvider } from '@/i18n'

const MINUTE = 60_000
const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * MINUTE).toISOString()

const PEOPLE = [
  { id: 'user_01', name: 'Matthias Bigl', email: 'matthias.bigl@buero.at' },
  { id: 'user_02', name: 'Anna Weber', email: 'anna.weber@buero.at' },
  { id: 'user_03', name: 'Klaus Berger', email: 'klaus.berger@buero.at' },
]

const base = {
  scope: 'project',
  projectId: 'proj_1',
  projectName: 'Wohnbau Nord',
  versionId: null,
  folderId: null,
  folderPath: null,
  ownList: false,
}

const ENTRIES = [
  { ...base, id: 'e1', occurredAt: at(4), userId: 'user_02', person: { name: 'Anna Weber', email: 'anna.weber@buero.at' }, kind: 'download', access: 'download', documentId: 'd1', documentName: 'Einreichplan EG.pdf', folderId: 'f1', folderPath: 'Pläne' },
  { ...base, id: 'e2', occurredAt: at(31), userId: 'user_03', person: { name: 'Klaus Berger', email: 'klaus.berger@buero.at' }, kind: 'pdf', access: 'open', documentId: 'd2', documentName: 'Dienstvertrag Weber.pdf', folderId: 'f2', folderPath: 'Personal', ownList: true },
  { ...base, id: 'e3', occurredAt: at(95), userId: 'user_03', person: { name: 'Klaus Berger', email: 'klaus.berger@buero.at' }, kind: 'version', access: 'open', documentId: 'd3', documentName: 'Honorarnote 07.md', versionId: '8f3a1c52-0000-4000-8000-000000000001', folderId: 'f3', folderPath: 'Verträge/Honorare', ownList: true },
  { ...base, id: 'e4', occurredAt: at(180), userId: 'user_01', person: { name: 'Matthias Bigl', email: 'matthias.bigl@buero.at' }, kind: 'download', access: 'download', documentId: 'd4', documentName: 'Leistungsverzeichnis Rohbau.xlsx' },
  { ...base, id: 'e5', occurredAt: at(1500), userId: 'user_01', person: { name: 'Matthias Bigl', email: 'matthias.bigl@buero.at' }, kind: 'download', access: 'download', scope: 'archiv', projectId: null, projectName: null, documentId: 'd5', documentName: 'Normenübersicht ÖNORM.pdf' },
  { ...base, id: 'e6', occurredAt: at(2900), userId: 'user_gone', person: null, kind: 'download', access: 'download', scope: 'session', projectId: null, projectName: null, documentId: 'd6', documentName: 'Foto Baustelle 14.jpg' },
  { ...base, id: 'e7', occurredAt: at(5200), userId: 'user_02', person: { name: 'Anna Weber', email: 'anna.weber@buero.at' }, kind: 'download', access: 'download', projectId: 'proj_gone', projectName: null, documentId: 'd7', documentName: 'Altbestand.docx', folderId: 'f_gone', folderPath: null },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __downloadLogShim?: boolean }
  if (!w.__downloadLogShim) {
    w.__downloadLogShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/organization/download-log/retention')) {
        const { days } = JSON.parse(String(init?.body ?? '{}')) as { days: number }
        return Response.json({ days, previous: 365 })
      }
      if (url.startsWith('/api/organization/download-log')) {
        const page = new URLSearchParams(window.location.search)
        if (page.has('error')) return Response.json({ error: { message: 'Forbidden' } }, { status: 403 })
        const query = new URL(url, 'http://dev').searchParams
        const user = query.get('userId')
        const document = query.get('document')?.toLowerCase()
        const rows = page.has('empty')
          ? []
          : ENTRIES.filter((row) => (!user || row.userId === user) && (!document || row.documentName.toLowerCase().includes(document)))
        const second = query.get('cursor') === 'page2'
        const slice = second ? rows.slice(4) : rows.slice(0, 4)
        return Response.json({
          entries: slice,
          nextCursor: !second && rows.length > 4 ? 'page2' : null,
          retentionDays: 180,
        })
      }
      return real(input, init)
    }
  }
}

export default function DownloadLogDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="text-foreground mx-auto flex w-full max-w-6xl flex-col gap-8 p-4 sm:p-8" data-testid="download-log-preview">
        <PageHeader
          title="Download-Protokoll"
          subtitle="Wer welches Dokument heruntergeladen hat und wer eines in einem Ordner mit eigener Zugriffsliste geöffnet hat. Befristet aufbewahrt, nur für Sicherheit und Nachvollziehbarkeit."
        />
        <DownloadLogView people={PEOPLE} />
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Aufbewahrung des Download-Protokolls</h2>
          <DownloadLogRetentionForm initialDays={180} />
        </section>
      </main>
    </I18nProvider>
  )
}
