'use client'

/**
 * The composer subject bar — what native chat shows when Ask Piloti is
 * about a file. Fetch-free: the fixture carries the whole subject identity
 * (title, filename, shelf), so the status lookup never fires.
 */

import { I18nProvider } from '@/i18n'
import { ComposerSubjectBar } from '@/features/documents/components/composer-subject-bar'

export default function ComposerSubjectPreviewPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div className="mx-auto w-full max-w-[680px] space-y-8 p-6">
        <div className="rounded-xl border bg-card p-3 shadow-xs">
          <ComposerSubjectBar
            subject={{
              resourceType: 'document',
              resourceId: 'doc-brandschutz',
              title: 'Brandschutzplan_EG.pdf',
              filename: 'Brandschutzplan_EG.pdf',
              shelf: 'project',
            }}
            projectId="proj-1"
            onClear={() => undefined}
            onResolved={() => undefined}
          />
          <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-[13px]">
            Frage zu Brandschutzplan_EG.pdf…
          </div>
        </div>
      </div>
    </I18nProvider>
  )
}
