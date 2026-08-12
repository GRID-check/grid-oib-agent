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
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { IfcModelViewer } from '@/features/bim/components/ifc-model-viewer'
import { resolveHighlights, storeyKey, supportsWebGpu } from '@/features/bim/lib/model-index'
import { buildModelHref } from '@/features/bim/lib/model-link'
import {
  resolveModelByFilename,
  useBimElements,
  useBimHighlightGroups,
  useBimModelSource,
  useProjectBimModels,
  type BimHighlightSpec,
} from '@/features/bim/hooks/use-bim-model'

export interface IfcViewerCardProps {
  title: string
  modelFile: string | null
  storey: string | null
  note: string | null
  highlights: BimHighlightSpec[]
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
  // `isLoading` and `error` were both discarded, so for the first few hundred
  // milliseconds — and permanently if the request failed or the feature flag
  // was withdrawn — this card stated "Das referenzierte Modell ist in diesem
  // Projekt nicht verfügbar": the one sentence that tells an architect their
  // upload vanished, for a list that had simply not arrived. The sibling file
  // preview refuses to conflate these three and says so in a comment.
  const { data: models, isLoading: modelsLoading, error: modelsError } = useProjectBimModels(projectId)

  // AMBIGUOUS is not resolved — see `resolveModelByFilename`, the rule this
  // shares with the data cards beside it. `ifc_query` declines to answer when a
  // name hits more than one ready model; taking the first hit here drew a
  // different building under the agent's title.
  const { model, ambiguous } = useMemo(
    () => resolveModelByFilename((models ?? []).filter((c) => c.status === 'ready'), modelFile),
    [models, modelFile]
  )

  const { data: elements } = useBimElements(model?.id ?? null)
  /**
   * The link named a storey this model does not have.
   *
   * Only once the rows are in: before that every name "matches nothing", and
   * `storeyKey` is the same comparison the isolation itself uses, so a padded
   * or differently-cased name is not a miss.
   */
  const storeyMissing = useMemo(() => {
    if (!storey || !elements || elements.length === 0) return false
    const wanted = storeyKey(storey)
    return !elements.some((element) => storeyKey(element.storeyName) === wanted)
  }, [storey, elements])

  const webGpu = useMemo(() => supportsWebGpu(), [])
  const source = useBimModelSource(model?.id ?? null, webGpu)

  // A group written as a FILTER is resolved against the model rather than
  // against the ids that happened to fit in the answer — see
  // `useBimHighlightGroups`. Groups that already carry ids cost no request.
  // `error` too. A filter-matched group falls back to an EMPTY id list when
  // its walk fails — deliberately, so one bad group does not blank the card —
  // and the legend then reads "(0)", which an architect reads as a clean
  // result rather than as a request that never ran.
  const { data: groups, error: groupsError } = useBimHighlightGroups(model?.id ?? null, highlights)
  const resolved = useMemo(() => groups ?? [], [groups])

  // Only once the elements are actually here. `useBimElements` returns `null`
  // until its walk completes, and resolving against an empty index puts EVERY
  // highlighted id in `unresolved` — so a normal load rendered "N elements not
  // found in this model" at full count, then cleared it. That message states a
  // data problem, and it was stating one that did not exist.
  const unresolvedCount = useMemo(
    () =>
      elements === null
        ? 0
        : resolveHighlights(resolved, elements).reduce((total, group) => total + group.unresolved.length, 0),
    [resolved, elements]
  )

  /**
   * "Open model" carries the card's whole view, not just the project.
   *
   * The card exists because an answer named three walls on the Obergeschoss;
   * a bare `/model` link throws that away and hands the reader a fresh
   * building to find them in again. Everything the card was showing —
   * which model, which storey, which elements highlighted — is already
   * expressible as a URL (`model-link.ts`), so the link is that URL.
   */
  const openHref = useMemo(
    () =>
      buildModelHref(projectId ?? '', {
        ...(model ? { model: model.filename } : {}),
        ...(storey ? { storey } : {}),
        ...(resolved.length > 0 ? { highlights: resolved } : {}),
        // Ghosting is what makes three highlighted walls findable inside a
        // whole building rather than buried in it.
        ...(resolved.length > 0 ? { xray: true } : {}),
      }),
    [projectId, model, storey, resolved]
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
            <Link href={openHref}>
              {t('card.openModel')}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        )}
      </header>

      {modelsLoading && models === null ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-6">
          <Spinner className="size-4" />
        </div>
      ) : modelsError !== null ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('preview.loadFailed')}
        </p>
      ) : !model ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {/*
            "Not available in this project" would be false for an ambiguous
            name: the model is in the project twice over, which is exactly why
            nothing is drawn. Told the wrong sentence, an architect goes looking
            for a building that is already uploaded.
          */}
          {ambiguous ? t('card.ambiguousModel') : t('card.noModel')}
        </p>
      ) : storeyMissing ? (
        // A storey name the agent transcribed as `EG` where the export says
        // `00 Erdgeschoss`. `expressIdsForStorey` returns an EMPTY set for a
        // name that matches nothing on a model that DOES assign storeys, and
        // the renderer reads that as "isolate nothing" — so the card became a
        // blank grey box that reads as "this floor is empty". The sibling
        // Raumbuch card names the same situation.
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('schedule.storeyEmpty', { storey: storey ?? '' })}
        </p>
      ) : (
        <IfcModelViewer
          sourceUrl={source.data}
          elements={elements ?? []}
          highlights={resolved}
          isolatedStorey={storey}
          className="h-72"
        />
      )}

      {groupsError !== null && (
        <p className="text-warning mt-2 text-xs">{t('card.highlightsFailed')}</p>
      )}
      {unresolvedCount > 0 && (
        <p className="mt-2 text-xs text-warning">
          {unresolvedCount === 1
            ? t('card.unresolvedOne')
            : t('card.unresolved', { count: unresolvedCount })}
        </p>
      )}
      {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
    </section>
  )
}
