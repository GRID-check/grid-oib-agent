/**
 * SourceBasisPicker — the body of the Datenbasis popover.
 *
 * One question, one list. It used to ask the same question three times in two
 * grammars: an "Immer dabei" section naming the knowledge layer, an "Externe
 * Quellen" section listing whatever `GET /v1/data_sources` returned, and a row
 * of preset chips underneath that overrode both. An architect had to learn what
 * a "data source" is, and how it differs from a "preset", before they could
 * answer "where should Piloti look?".
 *
 * Now the reader meets the four bodies of knowledge they already think in —
 * Baurecht & Richtlinien, Projektunterlagen, Büroarchiv, Web — and each row
 * owns whatever machinery stands behind it (`source-basis-model`).
 *
 * The explanatory sentence at the top is gone with the sections. Four named
 * rows with switches do not need to be told they set where Piloti may look, and
 * the sentence's other half — that the Herleitung reports what was actually
 * used — was being paid for on every open by every reader forever.
 */

'use client'

import { type FC, useCallback, useMemo } from 'react'
import { Layers } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ItemList } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/adapters/auth'
import { useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../../store'
import { SourceBasisRow } from './SourceBasisRow'
import {
  buildSourceCategories,
  selectionFromCategories,
  wireForSelection,
  type SourceCategoryId,
  type SourceCategoryLabels,
} from './source-basis-model'

/** Build the locale-dependent copy the model must not hard-code. */
export const useSourceCategoryLabels = (): SourceCategoryLabels => {
  const t = useTranslations('research')
  return useMemo(
    () => ({
      law: {
        name: t('sourceBasis.categories.law.name'),
        description: t('sourceBasis.categories.law.description'),
      },
      project: {
        name: t('sourceBasis.categories.project.name'),
        description: t('sourceBasis.categories.project.description'),
      },
      office: {
        name: t('sourceBasis.categories.office.name'),
        description: t('sourceBasis.categories.office.description'),
      },
      web: {
        name: t('sourceBasis.categories.web.name'),
        description: t('sourceBasis.categories.web.description'),
      },
      lawLockedReason: t('sourceBasis.categories.law.lockedReason'),
      signInRequired: t('sourceBasis.signInReason'),
    }),
    [t]
  )
}

export const SourceBasisPicker: FC = () => {
  const t = useTranslations('research')
  const tc = useTranslations('common')
  const { idToken } = useAuth()
  const labels = useSourceCategoryLabels()

  const enabledDataSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
  const availableDataSources = useLayoutStore((s) => s.availableDataSources)
  const knowledgeLayerAvailable = useLayoutStore((s) => s.knowledgeLayerAvailable)
  const activeSourcePreset = useLayoutStore((s) => s.activeSourcePreset)
  const dataSourcesLoading = useLayoutStore((s) => s.dataSourcesLoading)
  const dataSourcesError = useLayoutStore((s) => s.dataSourcesError)
  const applySourcePreset = useLayoutStore((s) => s.applySourcePreset)
  const fetchDataSources = useLayoutStore((s) => s.fetchDataSources)
  const saveDataSourcesToConversation = useChatStore((s) => s.saveDataSourcesToConversation)
  const isBusy = useIsCurrentSessionBusy()

  const categories = useMemo(
    () =>
      buildSourceCategories({
        sources: availableDataSources,
        enabledIds: enabledDataSourceIds,
        activePreset: activeSourcePreset,
        knowledgeLayerAvailable,
        hasValidToken: !!idToken,
        labels,
      }),
    [
      availableDataSources,
      enabledDataSourceIds,
      activeSourcePreset,
      knowledgeLayerAvailable,
      idToken,
      labels,
    ]
  )

  /**
   * One switch is one write of the whole answer: which shelves the turn may
   * read (the preset) AND which data sources it may call. They were two
   * controls that could disagree; now neither can be set without the other.
   */
  const handleToggle = useCallback(
    (id: SourceCategoryId, next: boolean) => {
      const selection = { ...selectionFromCategories(categories), [id]: next }
      const { preset, enabledIds } = wireForSelection(selection, availableDataSources)
      applySourcePreset(preset, enabledIds)
      saveDataSourcesToConversation?.(enabledIds)
    },
    [categories, availableDataSources, applySourcePreset, saveDataSourcesToConversation]
  )

  return (
    <div className="flex max-h-[min(70vh,460px)] flex-col gap-3">
      <div className="flex items-center gap-2">
        <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-semibold">{t('sourceBasis.label')}</span>
      </div>

      {isBusy && (
        <p className="text-xs text-muted-foreground" role="note">
          {t('sourceBasis.lockedBusy')}
        </p>
      )}

      <div className="scroll-fade-bottom min-h-0 flex-1 overflow-y-auto pb-1">
        {dataSourcesLoading ? (
          <div className="space-y-2" aria-busy="true" aria-label={t('dataSources.loading')}>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : dataSourcesError ? (
          <Alert variant="destructive">
            <AlertDescription className="space-y-2">
              <span className="block">{t('dataSources.unableToLoad')}</span>
              <span className="block text-xs">{dataSourcesError}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchDataSources()}
                aria-label={t('dataSources.retryAria')}
              >
                {tc('actions.retry')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <ItemList as="ul" aria-label={t('sourceBasis.label')}>
            {categories.map((entry) => (
              <SourceBasisRow
                key={entry.id}
                entry={entry}
                isBusy={isBusy}
                onToggle={handleToggle}
              />
            ))}
          </ItemList>
        )}
      </div>
    </div>
  )
}
