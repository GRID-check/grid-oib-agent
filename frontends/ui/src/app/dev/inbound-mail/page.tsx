'use client'

/**
 * Dev preview for the project Settings „E-Mail-Eingang" section, in every state
 * it has: ready with and without the rotate control, a long address, loading,
 * a failed load, and a deployment without an inbound mail domain or an
 * organization without the switch on (the section draws nothing, so that slot
 * is empty on purpose).
 *
 * The real component renders each one. A module-scope fetch shim answers the
 * address routes per project id, the same way `/dev/settings` serves its
 * panels, so the preview needs no session and no BFF route. Rotating works:
 * the shim mints a fresh address, so the confirm flow can be clicked through.
 */

import type { JSX, ReactNode } from 'react'
import { ProjectInboundMailCard } from '@/features/projects/components/project-inbound-mail-card'
import type {
  InboundAddressResponse,
  RotateInboundAddressResponse,
} from '@/lib/inbound-mail/contract'

const DOMAIN = 'piloti.at'

const ADDRESSES: Record<string, InboundAddressResponse> = {
  'preview-rotate': {
    enabled: true,
    address: `wohnbau-mariahilf.k7m2qx4hz9ab@${DOMAIN}`,
    canRotate: true,
  },
  'preview-member': {
    enabled: true,
    address: `wohnbau-mariahilf.k7m2qx4hz9ab@${DOMAIN}`,
    canRotate: false,
  },
  // A long project slug, so a phone shows where the address wraps: before the
  // `@` and the dots, not in the middle of the token.
  'preview-long': {
    enabled: true,
    address: `generalsanierung-schulzentrum-floridsdorf.k7m2qx4hz9ab@${DOMAIN}`,
    canRotate: true,
  },
  'preview-disabled': { enabled: false, address: null, canRotate: false },
}

// Fixed sample tokens the preview's "rotate" cycles through. Real tokens are
// minted server-side by `lib/inbound-mail/address.ts`; a second generator here
// would be a copy of it.
const PREVIEW_TOKENS = ['p3v6wn2cjt5d', 'x4hq7mz2rk6a', 'b2nw5tj3yc7e'] as const
let previewRotations = 0

function mintToken(): string {
  const token = PREVIEW_TOKENS[previewRotations % PREVIEW_TOKENS.length]
  previewRotations += 1
  return token
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __inboundMailShim?: boolean }
  if (!w.__inboundMailShim) {
    w.__inboundMailShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const match = /\/api\/projects\/([^/]+)\/inbound-address(\/rotate)?$/.exec(url)
      if (!match) return real(input, init)
      const [, projectId, rotate] = match
      if (projectId === 'preview-loading') return new Promise<Response>(() => {})
      if (projectId === 'preview-error') return Response.json({ error: 'boom' }, { status: 500 })
      if (rotate) {
        const body: RotateInboundAddressResponse = {
          address: `wohnbau-mariahilf.${mintToken()}@${DOMAIN}`,
        }
        return Response.json(body)
      }
      return Response.json(ADDRESSES[projectId] ?? { error: 'Not found' }, {
        status: ADDRESSES[projectId] ? 200 : 404,
      })
    }
  }
}

function State({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {children}
    </section>
  )
}

export default function InboundMailDevPage(): JSX.Element {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8" data-testid="inbound-mail-preview">
      <div>
        <h1 className="text-lg font-semibold">Project settings — Project email address</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The project&rsquo;s mail address. Shown to document writers; the rotate control only to project
          managers.
        </p>
      </div>

      <State label="Ready, project manager (can rotate)">
        <ProjectInboundMailCard projectId="preview-rotate" />
      </State>
      <State label="Ready, document writer (no rotate)">
        <ProjectInboundMailCard projectId="preview-member" />
      </State>
      <State label="Long address (wraps before @ and dots)">
        <ProjectInboundMailCard projectId="preview-long" />
      </State>
      <State label="Loading">
        <ProjectInboundMailCard projectId="preview-loading" />
      </State>
      <State label="Load failed">
        <ProjectInboundMailCard projectId="preview-error" />
      </State>
      <State label="Disabled (no inbound mail domain, or the organization switch is off): renders nothing">
        <ProjectInboundMailCard projectId="preview-disabled" />
      </State>
    </main>
  )
}
