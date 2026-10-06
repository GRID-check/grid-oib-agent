'use client'

/**
 * Dev preview for Organisation → Sensible Daten (ADR-0079). Renders the REAL
 * form twice, with fixtures and no backend:
 *
 *  - an admin while Piloti's suggestion is still in force (the hint, both
 *    buttons, every list editable);
 *  - a member without `org:settings:manage` (read-only: chips without remove
 *    buttons, no typing surface, no buttons, the note saying who may edit).
 *
 * A module-scope fetch shim (browser + dev only) serves the policy endpoint and
 * echoes a save back as the office's own list, so the round trip can be tried.
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { ScanSearch } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UploadScreeningCard } from '@/features/organization/components/upload-screening-card'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'

const STATE = {
  policy: SUGGESTED_SCREENING_POLICY,
  suggested: true,
  suggestion: SUGGESTED_SCREENING_POLICY,
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __uploadScreeningShim?: boolean }
  if (!w.__uploadScreeningShim) {
    w.__uploadScreeningShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/organization/upload-screening')) {
        if (init?.method === 'PUT') return Response.json({ policy: JSON.parse(String(init.body)), suggested: false })
        return Response.json(STATE)
      }
      return real(input, init)
    }
  }
}

export default function UploadScreeningDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const views: Array<{ title: string; canEdit: boolean }> = [
    { title: 'Admin, suggestion in force', canEdit: true },
    { title: 'Member, read-only', canEdit: false },
  ]

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-8" data-testid="upload-screening-preview">
      <div>
        <h1 className="text-lg font-semibold">Organisation — Sensible Daten</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The upload-screening policy (ADR-0079): name gate in the browser, content gate before any model.
        </p>
      </div>
      {views.map((view) => (
        <Card key={view.title}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScanSearch className="size-4 text-muted-foreground" aria-hidden />
              {view.title}
            </CardTitle>
            <CardDescription>Piloti prüft jeden Upload gegen diese Listen. Was anschlägt, liest kein Modell.</CardDescription>
          </CardHeader>
          <CardContent>
            <UploadScreeningCard canEdit={view.canEdit} />
          </CardContent>
        </Card>
      ))}
    </main>
  )
}
