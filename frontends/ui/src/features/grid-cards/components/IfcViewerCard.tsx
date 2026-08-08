'use client'

/**
 * The `ifc_viewer` card: the answer, shown on the actual building.
 *
 * The agent does not know model ids and must not invent them, so the card names
 * the model by FILE NAME — the string `ifc_query` reported in the same turn —
 * and this component resolves it against the models actually in scope for the
 * project. A name that resolves to nothing renders as a stated absence, not as
 * an empty viewport.
 *
 * Highlights are IFC GlobalIds. Ones the model does not contain are counted and
 * shown: colouring two of three walls while saying nothing would turn a partly
 * wrong answer into a confidently wrong picture.
 */

import { useMemo } from 'react'
import Link from 'next/link'
import { Boxes, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { IfcModelViewer } from '@/features/bim/components/ifc-model-viewer'
import { resolveHighlights, supportsWebGpu, type BimHighlightGroup } from '@/features/bim/lib/model-index'
import {
  pickDefaultModel,
  useBimElements,
  useBimModelSource,
  useProjectBimModels,
} from '@/features/bim/hooks/use-bim-model'

export interface IfcViewerCardProps {
  title: string
  modelFile: string | null
  storey: string | null
  note: string | null
  highlights: BimHighlightGroup[]
  projectId: string | null
}

export function IfcViewerCard({
  title,
  modelFile,
  storey,
  note,
  highlights,
  projectId,
}: IfcViewerCardProps): JSX.Element {
  const t = useTranslations('bim')
  const { data: models } = useProjectBimModels(projectId)

  const model = useMemo(() => {
    if (!models) return null
    const ready = models.filter((candidate) => candidate.status === 'ready')
    if (!modelFile) return pickDefaultModel(ready)
    const needle = modelFile.toLowerCase()
    return (
      ready.find((candidate) => candidate.filename.toLowerCase() === needle) ??
      ready.find((candidate) => candidate.filename.toLowerCase().includes(needle)) ??
      null
    )
  }, [models, modelFile])

  const { data: elements } = useBimElements(model?.id ?? null)
  const webGpu = useMemo(() => supportsWebGpu(), [])
  const sourceUrl = useBimModelSource(model?.id ?? null, webGpu)

  const unresolvedCount = useMemo(
    () =>
      resolveHighlights(highlights, elements ?? []).reduce(
        (total, group) => total + group.unresolved.length,
        0
      ),
    [highlights, elements]
  )

  return (
    <section className="rounded-xl border bg-card p-4" aria-label={title}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {model && projectId && (
          <Button asChild size="sm" variant="ghost">
            <Link href={`/app/projects/${projectId}/model`}>
              {t('card.openModel')}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        )}
      </header>

      {!model ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('card.noModel')}
        </p>
      ) : (
        <IfcModelViewer
          sourceUrl={sourceUrl}
          elements={elements ?? []}
          highlights={highlights}
          isolatedStorey={storey}
          variant="card"
          className="h-72"
        />
      )}

      {unresolvedCount > 0 && (
        <p className="mt-2 text-xs text-warning">{t('card.unresolved', { count: unresolvedCount })}</p>
      )}
      {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
    </section>
  )
}
