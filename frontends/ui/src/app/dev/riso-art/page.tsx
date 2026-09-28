'use client'

/**
 * Riso-art dev preview: every place the app shows a riso print, with the real
 * components and fixture copy, so each can be looked at in light and dark
 * (toggle the theme, or `document.documentElement.classList.toggle('dark')`).
 *
 * `?show=not-found` renders the full-page not-found screen alone.
 * The `/dev` layout 404s this outside development.
 */

import type { JSX } from 'react'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

import { RisoPrint } from '@/components/brand/riso-print'
import { StatusScreen } from '@/components/brand/status-screen'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { useTranslations } from '@/i18n'

function Preview(): JSX.Element {
  const show = useSearchParams()?.get('show')
  const errors = useTranslations('errors')
  const projects = useTranslations('projects')
  const files = useTranslations('files')

  if (show === 'not-found') {
    return (
      <StatusScreen
        art={<RisoPrint id="vignetten/bauplatz/empty" />}
        code={errors('notFound.code')}
        title={errors('notFound.title')}
        description={errors('notFound.description')}
        actions={<Button>{errors('notFound.action')}</Button>}
      />
    )
  }

  return (
    <div className="min-h-dvh bg-background px-4 py-10 sm:px-10">
      <div className="mx-auto grid max-w-3xl gap-10">
        <section data-preview="no-projects">
          <EmptyState
            art={<RisoPrint id="vignetten/abstecken/empty" />}
            title={projects('list.empty.title')}
            description={projects('list.empty.description')}
            action={<Button>{projects('list.empty.action')}</Button>}
            className="min-h-96 justify-center"
          />
        </section>
        <section data-preview="no-documents">
          <EmptyState
            art={<RisoPrint id="vignetten/planschrank/empty" />}
            title={files('browser.noDocumentsTitle')}
            description={files('browser.noDocumentsDescription')}
            action={<Button>Upload</Button>}
          />
        </section>
      </div>
    </div>
  )
}

export default function RisoArtPreview(): JSX.Element {
  return (
    <Suspense>
      <Preview />
    </Suspense>
  )
}
