'use client'

/**
 * Dev preview for Organisation → Quarantäne (ADR-0077). Renders the REAL queue
 * from fixtures: a project file caught by a content term on two pages, an
 * Archiv file caught by an IBAN and a card number (masked, as the job stores
 * them), a chat attachment whose scan was only partly checked, and a row whose
 * verdict could not be read. `?empty=1` shows the empty state instead.
 *
 * A module-scope fetch shim (browser + dev only) serves the queue and the
 * projects list and answers release and delete with success, so a row can be
 * released or deleted and leaves the list. Not linked from anywhere and 404s
 * outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'

import { PageHeader } from '@/components/ui/page-header'
import { QuarantineQueue } from '@/features/organization/components/quarantine-queue'

const HOUR = 3_600_000
const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * HOUR).toISOString()

const ITEMS = [
  {
    id: 'doc-1',
    filename: 'Honorarvereinbarung_Wohnbau_Nord_unterschrieben.pdf',
    scope: 'project',
    projectId: 'proj_1',
    conversationId: null,
    uploadedBy: 'user_01',
    quarantinedAt: at(2),
    verdict: {
      reasons: [{ kind: 'term', term: 'Honorarvereinbarung', count: 3, pages: [1, 4] }],
      checked: 'full',
    },
  },
  {
    id: 'doc-2',
    filename: 'Lieferantenstammdaten 2026.xlsx',
    scope: 'archiv',
    projectId: null,
    conversationId: null,
    uploadedBy: 'user_02',
    quarantinedAt: at(26),
    verdict: {
      reasons: [
        { kind: 'iban', sample: 'AT61 •••• •••• •••• 3456', count: 12 },
        { kind: 'credit_card', sample: '•••• 4242', count: 1 },
      ],
      checked: 'full',
    },
  },
  {
    id: 'doc-3',
    filename: 'Scan_Personalakte.pdf',
    scope: 'session',
    projectId: null,
    conversationId: 'conv_1',
    uploadedBy: 'user_03',
    quarantinedAt: at(75),
    verdict: {
      reasons: [{ kind: 'at_svnr', sample: '•••• ••••12', count: 1, pages: [2] }],
      checked: 'partial',
    },
  },
  {
    id: 'doc-4',
    filename: 'Altbestand.docx',
    scope: 'project',
    projectId: 'proj_gone',
    conversationId: null,
    uploadedBy: 'user_01',
    quarantinedAt: at(400),
    verdict: null,
  },
]

const PROJECTS = [
  { id: 'proj_1', name: 'Wohnbau Nord' },
  { id: 'proj_2', name: 'Sanierung Hauptplatz' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __quarantineShim?: boolean }
  if (!w.__quarantineShim) {
    w.__quarantineShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const empty = new URLSearchParams(window.location.search).has('empty')
      if (url.startsWith('/api/quarantine')) return Response.json({ items: empty ? [] : ITEMS })
      if (url.startsWith('/api/projects')) return Response.json(PROJECTS)
      if (url.includes('/quarantine/release')) return Response.json({ id: 'doc', status: 'pending', jobId: null })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return real(input, init)
    }
  }
}

export default function QuarantineDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8" data-testid="quarantine-preview">
      <PageHeader
        title="Quarantäne"
        subtitle="Dateien, die die Inhaltsprüfung zurückgehalten hat. Kein Modell hat sie gelesen. Wer sie prüfen darf, gibt sie hier frei oder löscht sie."
      />
      <QuarantineQueue />
    </main>
  )
}
