'use client'

/**
 * Dev preview for the project Settings „E-Mail-Eingang" section, in every state
 * it has: ready with and without the rotate control, loading, a failed load,
 * and a deployment without an inbound mail domain (the section draws nothing,
 * so that slot is empty on purpose).
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

const DOMAIN = 'piloti-post.at'

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
  'preview-disabled': { enabled: false, address: null, canRotate: false },
}

function mintToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  return Array.from({ length: 12 }, () => alphabet[Math.floor(Math.random() * 32)]).join('')
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
        <h1 className="text-lg font-semibold">Project settings — E-Mail-Eingang</h1>
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
      <State label="Loading">
        <ProjectInboundMailCard projectId="preview-loading" />
      </State>
      <State label="Load failed">
        <ProjectInboundMailCard projectId="preview-error" />
      </State>
      <State label="Disabled (no inbound mail domain): renders nothing">
        <ProjectInboundMailCard projectId="preview-disabled" />
      </State>
    </main>
  )
}
