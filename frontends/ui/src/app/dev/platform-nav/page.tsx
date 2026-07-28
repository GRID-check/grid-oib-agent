'use client'

/**
 * Dev preview for the platform section nav. Renders the REAL nav in both of
 * its layouts (the `lg` rail and the narrow scrolling strip) so the active
 * state, spacing and wrapping can be reviewed and screenshotted without a
 * backend or the platform-owner gate. Not linked from anywhere; 404s outside
 * development.
 */

import { PlatformNav } from '@/features/platform/components/platform-nav'

export default function PlatformNavDevPage(): JSX.Element {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-8">
      <div>
        <h1 className="text-lg font-semibold">Platform — section nav</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The shared shell&apos;s section nav. Seven stacked admin domains became six routes; this is how you move
          between them.
        </p>
      </div>
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <div className="lg:w-52 lg:shrink-0">
          <PlatformNav />
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">
          Section content renders here.
        </div>
      </div>
    </main>
  )
}
