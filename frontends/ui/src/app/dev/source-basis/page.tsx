'use client'

/**
 * Datenbasis dev preview: the REAL `SourceBasisPicker` and `SourceBasisTrigger`
 * in the states that decide whether the control reads correctly, rendered
 * backend-free (visual/registry.mjs → `source-basis`).
 *
 * Why this surface needs its own evidence: the picker answers ONE question with
 * four rows whose states are not independent — three of them are derived from a
 * single `source_preset` on the wire, and the fourth from a data-source id. The
 * derivation is the thing under review, and it cannot be seen from one state.
 * Stacked here, each column is a different answer to "where may Piloti look?"
 * and the trigger above it is what the composer would then show.
 *
 * `?variant=` selects the captured scenario, one per capture. It is a query
 * parameter rather than three columns on one page because the layout store is
 * global: three live pickers would fight over one `activeSourcePreset` and all
 * three would render the last write.
 *
 *   (none)      — everything in scope, the state a fresh fetch produces
 *   `?variant=project` — narrowed to this project, web off
 *   `?variant=law`     — Baurecht only; documents and archive both off
 *
 * The rows are seeded through the real layout store rather than as props, so
 * the preview exercises the same derivation the composer does. Pinned to
 * German: it is the product's primary language, so that is the copy the
 * evidence should carry regardless of the locale cookie the capture runs with.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'

import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { I18nProvider } from '@/i18n'
import { SourceBasisPicker, SourceBasisTrigger } from '@/features/layout/components/source-basis'
import { useLayoutStore } from '@/features/layout/store'
import type { SourcePresetId } from '@/features/layout/types'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

/** The two sources a production deployment actually configures. */
const SOURCES = [
  {
    id: 'web_search',
    name: 'Web Search',
    description: 'Search the web for real-time information.',
    requires_auth: false,
  },
  {
    id: 'ris',
    name: 'RIS – Österreichisches Recht',
    description: 'Österreichisches Bundes- und Landesrecht.',
    requires_auth: false,
  },
]

interface Scenario {
  title: string
  preset: SourcePresetId | null
  enabledIds: string[]
}

const SCENARIOS: Record<string, Scenario> = {
  all: {
    title: 'Standard — alles im Zugriff',
    preset: null,
    enabledIds: ['web_search', 'ris'],
  },
  project: {
    title: 'Eingegrenzt — nur dieses Projekt, ohne Web',
    preset: 'project',
    enabledIds: ['ris'],
  },
  law: {
    title: 'Nur Baurecht — Unterlagen und Archiv aus',
    preset: 'law',
    enabledIds: ['ris'],
  },
}

export default function SourceBasisPreviewPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read the variant after mount, not during render, so the server and the
  // first client render agree.
  const [scenario, setScenario] = useState<Scenario | null>(null)
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('variant') ?? 'all'
    const next = SCENARIOS[requested] ?? SCENARIOS.all

    const apply = () =>
      useLayoutStore.setState({
        availableDataSources: SOURCES,
        enabledDataSourceIds: next.enabledIds,
        knowledgeLayerAvailable: true,
        activeSourcePreset: next.preset,
        dataSourcesLoading: false,
        dataSourcesError: null,
      })

    apply()
    setScenario(next)

    /*
      And then keep applying it, because seeding once loses a race this route
      cannot otherwise win. `providers.tsx` fires a real `fetchDataSources()`
      as soon as `availableDataSources` is null, and the providers live in the
      ROOT LAYOUT — which mounts before this page's chunk has even been
      evaluated. By the time anything here runs, the request is already in
      flight against a backend that is not there, and its rejection paints the
      picker's error state over the fixture a second later.

      Seeding earlier does not help (there is no "earlier" than the layout), and
      mocking the client would mean screenshotting a component wired to
      something other than the real store. So the fixture is simply reasserted
      whenever the store drifts off it. The guard settles immediately: the write
      it makes no longer satisfies its own condition.
    */
    return useLayoutStore.subscribe((state) => {
      if (
        state.dataSourcesError !== null ||
        state.dataSourcesLoading ||
        state.availableDataSources === null
      ) {
        apply()
      }
    })
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AppConfigProvider config={config}>
        <main
          data-testid="source-basis-preview"
          className="mx-auto flex w-full max-w-md flex-col gap-6 p-8 text-foreground"
        >
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Datenbasis</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Worin Piloti suchen darf — vier Wissensbestände statt einer Liste von
              Datenquellen.
            </p>
          </div>

          {scenario && (
            <section className="space-y-3">
              <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                {scenario.title}
              </h2>
              {/* The trigger above the picker it opens: the composer shows one
                  and the popover shows the other, and they have to agree. */}
              <SourceBasisTrigger pickerOpen />
              <div className="rounded-2xl border bg-popover p-3 shadow-md">
                <SourceBasisPicker />
              </div>
            </section>
          )}
        </main>
      </AppConfigProvider>
    </I18nProvider>
  )
}
