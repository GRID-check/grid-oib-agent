'use client'

/**
 * The project's Model page: pick a model, see it, filter it, inspect it.
 *
 * Layout is deliberately explorer-left / viewport-right rather than the
 * viewer-first arrangement a 3D tool would choose. The data is what answers
 * questions and it is what is always available; the picture is the fastest way
 * to find the element you then ask about. Selection is bidirectional — clicking
 * a row highlights it in the viewport, clicking geometry selects the row — so
 * neither half is a dead end.
 */

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { supportsWebGpu, type BimViewerElement } from '../lib/model-index'
import {
  pickDefaultModel,
  useBimElementDetail,
  useBimElements,
  useBimModelSource,
  useProjectBimModels,
  type BimModelHeaderView,
} from '../hooks/use-bim-model'
import {
  IfcElementTable,
  IfcModelHealthPanel,
  IfcModelOverview,
  IfcPropertyPanel,
  IfcSpatialTree,
} from './ifc-model-explorer'
import { IfcModelCompare } from './ifc-model-compare'
import { IfcModelViewer } from './ifc-model-viewer'

export interface IfcModelWorkspaceProps {
  projectId: string
}

function StatusBadge({ status }: { status: BimModelHeaderView['status'] }): JSX.Element {
  const t = useTranslations('bim')
  const variant =
    status === 'ready' ? 'success' : status === 'failed' ? 'destructive' : 'info'
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>
}

export function IfcModelWorkspace({ projectId }: IfcModelWorkspaceProps): JSX.Element {
  const t = useTranslations('bim')
  const { data: models, isLoading } = useProjectBimModels(projectId)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [storey, setStorey] = useState<string | null>(null)
  const [selectedGlobalId, setSelectedGlobalId] = useState<string | null>(null)

  const model = useMemo(() => {
    if (!models) return null
    return models.find((candidate) => candidate.id === selectedModelId) ?? pickDefaultModel(models)
  }, [models, selectedModelId])

  const modelId = model?.status === 'ready' ? model.id : null
  const { data: elements } = useBimElements(modelId)
  const detail = useBimElementDetail(modelId, selectedGlobalId)
  // Only mint the presigned source URL when a viewport can actually use it.
  const webGpu = useMemo(() => supportsWebGpu(), [])
  const sourceUrl = useBimModelSource(modelId, webGpu)

  const handleSelect = useCallback((element: BimViewerElement | null) => {
    setSelectedGlobalId(element?.globalId ?? null)
  }, [])

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  if (!models || models.length === 0) {
    return (
      <div className="space-y-4 p-6">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <Boxes className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">{t('empty.title')}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{t('empty.description')}</p>
          <Button asChild size="sm">
            <Link href={`/app/projects/${projectId}/files`}>{t('empty.action')}</Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {models.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {models.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => {
                setSelectedModelId(candidate.id)
                setStorey(null)
                setSelectedGlobalId(null)
              }}
              aria-pressed={candidate.id === model?.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                candidate.id === model?.id ? 'border-primary bg-muted' : 'hover:bg-muted/60'
              }`}
            >
              <span className="truncate">{candidate.filename}</span>
              <StatusBadge status={candidate.status} />
            </button>
          ))}
        </div>
      )}

      {model && model.status !== 'ready' && (
        <p className="rounded-lg border bg-muted/40 p-4 text-sm">
          <StatusBadge status={model.status} />{' '}
          <span className="ml-2">{model.errorMessage ?? t(`status.${model.status}`)}</span>
        </p>
      )}

      {model?.status === 'ready' && model.summary && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="flex min-h-0 flex-col gap-5 overflow-auto pr-1">
            <IfcModelOverview summary={model.summary} filename={model.filename} />
            {model.summary.health && (
              <IfcModelHealthPanel
                health={model.summary.health}
                onShowElements={(globalIds) => setSelectedGlobalId(globalIds[0] ?? null)}
              />
            )}
            <IfcSpatialTree
              summary={model.summary}
              selectedStorey={storey}
              onSelectStorey={(next) => {
                setStorey(next)
                setSelectedGlobalId(null)
              }}
            />
            <IfcElementTable
              elements={elements ?? []}
              storeyFilter={storey}
              selectedGlobalId={selectedGlobalId}
              onSelect={handleSelect}
            />
            <IfcModelCompare
              modelId={model.id}
              candidates={models.filter(
                (candidate) => candidate.id !== model.id && candidate.status === 'ready'
              )}
            />
          </div>

          <div className="flex min-h-0 flex-col gap-4">
            <IfcModelViewer
              sourceUrl={sourceUrl}
              elements={elements ?? []}
              isolatedStorey={storey}
              selectedGlobalId={selectedGlobalId}
              onSelect={handleSelect}
              className="h-[420px] min-h-64"
            />
            <section
              aria-labelledby="bim-properties-heading"
              className="min-h-0 flex-1 overflow-auto rounded-lg border p-3"
            >
              <h2 id="bim-properties-heading" className="mb-2 text-sm font-semibold">
                {t('properties.title')}
              </h2>
              <IfcPropertyPanel
                element={detail.data}
                isLoading={detail.isLoading}
                error={detail.error}
              />
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
