'use client'

/**
 * Dev preview for the Dateien page HEADER — the row that carries the section
 * title, its description, and every control that acts on the listing.
 *
 * This surface had no committed evidence, and it is where a layout regression
 * actually landed: folder upload shipped as a SECOND full-width button, the
 * action side took the width it needed, and the header's `min-w-0` title block
 * gave up the rest — so „Dokumente, auf die sich Piloti in diesem Projekt
 * stützt." rendered as a four-word column beside it. Nothing photographed the
 * header, so nothing caught it.
 *
 * Three things answered it, and this route is what holds them honest: folder
 * upload folded back into ONE button with a menu, the filters folded into one
 * `FileFilterMenu`, and `PageHeader` given a title floor so the action side is
 * the one that yields. The narrow variant is the proof — it is the width where
 * the squeeze showed first.
 *
 * The composition is the one `ProjectFileWorkspace` builds: `PageHeader` with
 * the same children, in the same order, at the same widths. The REAL controls,
 * so the shot measures the real thing — the failure mode is width, and a
 * stand-in with different intrinsic widths would prove nothing.
 *
 * `?variant=narrow` renders it at a laptop width, which is where the squeeze
 * appeared first. The E-Mail-Eingang's entry carries its muted count (three
 * mails wait), and the upload menu offers „Per E-Mail senden …“ (ADR-0134).
 * Not linked from anywhere; 404s outside development.
 */

import type { JSX } from 'react'
import { use, useState } from 'react'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { usePhoneLayout } from '@/features/documents/hooks/use-phone-layout'
import type { FileView } from '@/features/documents/hooks/use-view-preference'
import { FileFilterMenu } from '@/features/documents/components/file-filter-menu'
import { NO_FILE_FILTERS, type FileFilters } from '@/features/documents/lib/file-filters'
import { DEFAULT_FILE_SORT, type FileSort } from '@/features/documents/lib/file-sort'
import { FilesHeaderControls } from '@/features/documents/components/files-header-controls'
import { ProjectUppyUpload } from '@/features/documents/components/project-uppy-upload'
import { I18nProvider, useTranslations } from '@/i18n'

function Header() {
  const tNav = useTranslations('nav')
  const phone = usePhoneLayout()
  const [view, setView] = useState<FileView>('cards')
  const [filters, setFilters] = useState<FileFilters>(NO_FILE_FILTERS)
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT)
  const [query, setQuery] = useState('')

  return (
    <PageHeader
      title={tNav('sections.files')}
      subtitle={tNav('sectionSubtitles.files')}
      action={
        <FilesHeaderControls
          phone={phone}
          view={view}
          onViewChange={setView}
          binHref="/app/projects/dev/files/bin"
          openPointsHref="/dev/open-points"
          inboundMail={{ href: '/dev/inbound-mail?variant=many', waiting: 3 }}
          renderFilter={(compact) => (
            <FileFilterMenu
              canCollaborate
              filters={filters}
              onFiltersChange={setFilters}
              sort={sort}
              onSortChange={setSort}
              compact={compact}
            />
          )}
          search={{ value: query, onChange: setQuery, onSubmit: () => {}, onClear: () => setQuery('') }}
          upload={phone ? undefined : <ProjectUppyUpload onUpload={() => {}} isUploading={false} allowFolders onSendByMail={() => {}} />}
        />
      }
    />
  )
}

export default function FilesHeaderDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const narrow = use(searchParams).variant === 'narrow'

  return (
    // German, pinned: the copy that squeezed is German, and it is the language
    // most users read. An English shot would understate the width the
    // description needs.
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="bg-background min-h-dvh py-10">
        <div className={narrow ? 'mx-auto max-w-[900px]' : 'mx-auto max-w-[1400px]'}>
          <p className="text-muted-foreground mb-4 px-4 font-mono text-xs md:px-8">
            /dev/files-header{narrow ? '?variant=narrow' : ''} — Dateien header + action row
          </p>
          <div className="border-border bg-background border-y px-4 py-4 md:px-8">
            <Header />
          </div>
        </div>
      </main>
    </I18nProvider>
  )
}
