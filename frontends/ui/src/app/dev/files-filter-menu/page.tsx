'use client'

/**
 * Dev preview for the Dateien FILTER MENU — every way of narrowing and ordering
 * the listing, which used to be an open strip in the page header.
 *
 * The strip showed its state by looking pressed. A popover cannot, so the count
 * on the trigger carries it instead — which makes the badge load-bearing rather
 * than decoration, and is the thing this shot exists to hold: the closed
 * trigger at rest, the closed trigger with three constraints on, and the open
 * menu with its five sections.
 *
 * Pinned open via `defaultOpen`, because a screenshot of a closed popover
 * photographs a button and proves nothing about what is inside it.
 *
 * German, like `/dev/files-header`: the copy that has to fit is German, and an
 * English shot understates every label's width.
 */

import { notFound } from 'next/navigation'
import { FileFilterMenu } from '@/features/documents/components/file-filter-menu'
import { NO_FILE_FILTERS } from '@/features/documents/lib/file-filters'
import { DEFAULT_FILE_SORT } from '@/features/documents/lib/file-sort'
import { I18nProvider } from '@/i18n'

const noop = (): void => {}

export default function FilesFilterMenuDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="bg-background min-h-dvh p-10" data-testid="files-filter-menu-dev">
        <p className="text-muted-foreground mb-6 font-mono text-xs">
          /dev/files-filter-menu — Filter + Sortierung
        </p>

        <section className="mb-8 space-y-3">
          <h2 className="text-muted-foreground text-sm font-medium">Geöffnet</h2>
          {/* Room for the portalled panel, which renders over the page. */}
          <div className="flex h-[560px] justify-end rounded-xl border p-4">
            <FileFilterMenu
              defaultOpen
              canCollaborate
              filters={{
                assignment: 'mine',
                agentAuthoredOnly: false,
                kinds: ['model'],
                statuses: ['failed'],
              }}
              onFiltersChange={noop}
              sort={{ key: 'name', direction: 'asc' }}
              onSortChange={noop}
            />
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="text-muted-foreground text-sm font-medium">Auslöser</h2>
          <div className="flex flex-wrap items-center gap-4 rounded-xl border p-4">
            <FileFilterMenu
              canCollaborate
              filters={NO_FILE_FILTERS}
              onFiltersChange={noop}
              sort={DEFAULT_FILE_SORT}
              onSortChange={noop}
            />
            {/* Three constraints, one badge — a dimension counts once however
                many values it holds, so "Dateityp: Grundriss + Schnitt" is one
                thing the reader can lift, not two. */}
            <FileFilterMenu
              canCollaborate
              filters={{
                assignment: 'unassigned',
                agentAuthoredOnly: true,
                kinds: ['floorplan', 'section'],
                statuses: [],
              }}
              onFiltersChange={noop}
              sort={DEFAULT_FILE_SORT}
              onSortChange={noop}
            />
          </div>
        </section>

      </main>
    </I18nProvider>
  )
}
