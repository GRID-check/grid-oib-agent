'use client'

/**
 * Dev preview for the platform storage table.
 *
 * The fixture covers every row state the operator has to tell apart at a glance:
 * one tenant over its quota, one close to it, one comfortably within, one on the
 * inherited platform default, and one explicitly unlimited. Sizes span GB to MB
 * so the byte formatter is exercised across units, and one org has no display
 * name so the id fallback is visible.
 */

import type { JSX } from 'react'
import { notFound } from 'next/navigation'
import { HardDrive } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PlatformStorageTable } from '../../app/(shell)/platform/storage-table'

const GB = 1e9

const OVERVIEW = {
  organizations: [
    {
      organizationId: 'org_01HQZX3K8ACME',
      displayName: 'Acme Architektur GmbH',
      usedBytes: 52.6 * GB,
      documents: 1720,
      quotaBytes: 50 * GB,
      inherited: false,
    },
    {
      organizationId: 'org_01HQZX3K8NORD',
      displayName: 'Nordlicht Planung',
      usedBytes: 47.1 * GB,
      documents: 1533,
      quotaBytes: 50 * GB,
      inherited: false,
    },
    {
      organizationId: 'org_01HQZX3K8HOLZ',
      displayName: 'Holzbau Steiner',
      usedBytes: 12.4 * GB,
      documents: 402,
      quotaBytes: 100 * GB,
      inherited: false,
    },
    {
      organizationId: 'org_01HQZX3K8PILO',
      displayName: 'Piloti Interna',
      usedBytes: 3.2 * GB,
      documents: 96,
      quotaBytes: null,
      inherited: false,
    },
    {
      organizationId: 'org_01HQZX3K8NEWB',
      displayName: null,
      usedBytes: 240e6,
      documents: 11,
      quotaBytes: 50 * GB,
      inherited: true,
    },
  ],
  totals: { usedBytes: 115.54 * GB, documents: 3762, organizations: 5 },
}

// Module scope, not a useEffect: a shim installed from an effect loses the race
// with the child component's own mount-time fetch.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformStorageShim?: boolean }
  if (!w.__platformStorageShim) {
    w.__platformStorageShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/storage')) return Response.json(OVERVIEW)
      return real(input, init)
    }
  }
}

export default function PlatformStorageDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-8" data-testid="platform-storage-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Storage</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every tenant&apos;s consumption, and the quota that bounds it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="text-muted-foreground size-4" aria-hidden />
            Document storage
          </CardTitle>
          <CardDescription>
            Stored bytes per organization, and the quota that refuses further uploads. Quotas are a
            platform control — tenants can see their own number but never change it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PlatformStorageTable />
        </CardContent>
      </Card>
    </main>
  )
}
