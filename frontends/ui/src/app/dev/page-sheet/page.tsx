'use client'

/**
 * Dev preview for the page sheet — the third overlay intent beside the modal
 * and the side sheet: a whole PLACE risen near-fullscreen over the current
 * page (visual/registry.mjs → `page-sheet*`). Not linked anywhere and 404s
 * outside development.
 *
 * `?variant=reading` renders the narrower reading-width column the history
 * sheet uses; the default is the full 1400px place (Archiv, Postfach).
 *
 * The stand-in page behind the sheet is deliberately busy: whether the scrim
 * dims it legibly, and whether the sheet's top margin shows the app
 * underneath, is the whole visual claim this surface makes.
 */

import { useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { PageSheet } from '@/components/ui/page-sheet'
import { Skeleton } from '@/components/ui/skeleton'

export default function PageSheetDevPage(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'default'
  // Real open state so the preview exercises the whole lifecycle — the
  // entrance, the pull-down dismissal, the exit — not just the resting frame.
  const [open, setOpen] = useState(true)
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const reading = variant === 'reading'

  return (
    <div className="bg-background text-foreground min-h-dvh" data-testid="page-sheet-preview">
      {/* The page the sheet covers. */}
      <div className="space-y-4 p-8">
        <h1 className="text-lg font-semibold">/dev/page-sheet — the page underneath</h1>
        <Button variant="outline" onClick={() => setOpen(true)} data-testid="reopen-sheet">
          Reopen sheet
        </Button>
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full rounded-xl" />
        ))}
      </div>

      <PageSheet
        open={open}
        onOpenChange={setOpen}
        title={reading ? 'Chat history' : 'Archiv'}
        subtitle={
          reading
            ? '12 chats'
            : 'Documents the whole organization shares, independent of any project.'
        }
        closeLabel="Close"
        width={reading ? 'reading' : 'wide'}
        bodyClassName="overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-6 md:px-8">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </PageSheet>
    </div>
  )
}
