'use client'

/**
 * Dev preview for the organization storage panel.
 *
 * Two fixtures, because the meter has two states and only one of them is
 * reassuring. The first sits at 82% of quota — visibly filling, not yet an
 * error. The second is over, which is what a tenant whose uploads just started
 * failing actually sees: the critical fill, the limit tick, and the sentence
 * that explains it. The scopes differ by an order of magnitude so the byte
 * formatter is exercised at both GB and MB.
 *
 * There is no admin variant, because there is no editor for any role — the
 * quota belongs to the platform operator (ADR-0042).
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
}

const OVER_QUOTA = {
  usage: {
    project: { bytes: 49.2 * GB, documents: 1602 },
    archiv: { bytes: 3.4 * GB, documents: 118 },
    total: { bytes: 52.6 * GB, documents: 1720 },
  },
  quotaBytes: 50 * GB,
}

// Module scope, not a useEffect: a shim installed from an effect loses the race
// with the child component's own mount-time fetch.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __storageUsageShim?: boolean; __storageCall?: number }
  if (!w.__storageUsageShim) {
    w.__storageUsageShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Both cards fetch the SAME url, so the shim varies by call order rather
      // than by query string: first mount gets the within-quota fixture, second
      // gets the over-quota one. A prop would have meant adding a preview-only
      // parameter to the production component.
      if (url.startsWith('/api/organization/storage')) {
        w.__storageCall = (w.__storageCall ?? 0) + 1
        return Response.json(w.__storageCall === 1 ? STORAGE : OVER_QUOTA)
      }
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
            Document storage — within quota
          </CardTitle>
          <CardDescription>
            Every uploaded document is kept so it can be re-read, re-embedded and audited. The quota
            is what stops one organization filling the shared disk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StorageUsageCard />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="text-muted-foreground size-4" aria-hidden />
            Document storage — over quota
          </CardTitle>
          <CardDescription>
            The same panel once the quota is reached: the fill steps to the critical colour, a tick
            marks where the quota sat, and uploads are refused until space is freed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StorageUsageCard />
        </CardContent>
      </Card>
    </main>
  )
}
