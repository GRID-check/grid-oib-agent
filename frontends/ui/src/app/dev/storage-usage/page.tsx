'use client'

/**
 * Dev preview for the organization storage panel.
 *
 * The fixture is deliberately adversarial: the org sits at 82% of its quota, so
 * the meter is visibly filling without being in the error state, and the two
 * scopes differ by an order of magnitude so the byte formatter is exercised at
 * both GB and MB. The admin variant renders the quota editor; the member
 * variant is the same reading with no way to change it, which is what most
 * people who land here actually see.
 */

import { notFound } from 'next/navigation'
import { HardDrive } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StorageUsageCard } from '../../app/organization/storage-usage-card'

const GB = 1e9

const STORAGE = {
  usage: {
    project: { bytes: 38.4 * GB, documents: 1284 },
    archiv: { bytes: 2.6 * GB, documents: 96 },
    total: { bytes: 41 * GB, documents: 1380 },
  },
  quotaBytes: 50 * GB,
  canManage: true,
}

// Module scope, not a useEffect: a shim installed from an effect loses the race
// with the child component's own mount-time fetch.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __storageUsageShim?: boolean }
  if (!w.__storageUsageShim) {
    w.__storageUsageShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/organization/storage')) return Response.json(STORAGE)
      return real(input, init)
    }
  }
}

export default function StorageUsageDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="storage-usage-preview">
      <div>
        <h1 className="text-lg font-semibold">Organization — Storage</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Stored bytes against the quota that refuses new uploads.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="text-muted-foreground size-4" aria-hidden />
            Document storage — admin
          </CardTitle>
          <CardDescription>
            Every uploaded document is kept so it can be re-read, re-embedded and audited. The quota
            is what stops one organization filling the shared disk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StorageUsageCard isAdmin />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="text-muted-foreground size-4" aria-hidden />
            Document storage — member
          </CardTitle>
          <CardDescription>
            Every uploaded document is kept so it can be re-read, re-embedded and audited. Ask an
            administrator if you need more room.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StorageUsageCard isAdmin={false} />
        </CardContent>
      </Card>
    </main>
  )
}
