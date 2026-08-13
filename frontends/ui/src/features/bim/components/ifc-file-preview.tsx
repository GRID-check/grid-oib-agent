'use client'

/**
 * An `.ifc` previewed in the Dateien pane — as the building, not as a page mock.
 *
 * ## Why this exists
 *
 * A PDF previews as pages and an image previews as itself, but the richest file
 * in the system previewed as a decorative placeholder reading "no inline
 * preview", with the whole model experience parked on a separate `/model`
 * route. That made the model feel like a side tool bolted on beside the file
 * system rather than what the file IS — and a route nobody navigates to is a
 * feature nobody uses.
 *
 * So an IFC is just another file, opened the way every other file is opened,
 * and the extra capability lives INSIDE the familiar shell rather than beside
 * it.
 *
 * ## Why the BIM knowledge is all in here
 *
 * `features/documents` gets one conditional and no imports from the BIM
 * subsystem beyond this component. The documents pane should not learn what a
 * storey is, and this component should not learn how the pane lays out its
 * metadata rail.
 *
 * ## What it deliberately does NOT do
 *
 * No tabs, no element table, no Prüfbuch. The pane's job is "show me this
 * file", and the answer for a model is the model. Everything analytical stays
 * one click away — the open-in-workspace link below the viewport — because a
 * preview well a few hundred pixels wide is the wrong place to read a
 * compliance table.
 */

import { useMemo } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Boxes } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  useBimElements,
  useBimModelSource,
  useDocumentBimModel,
  useProjectBimModels,
} from '../hooks/use-bim-model'
import { supportsWebGpu } from '../lib/model-index'
import { buildModelHref } from '../lib/model-link'
import { IfcModelViewer } from './ifc-model-viewer'

interface IfcFilePreviewProps {
  /** The DOCUMENT this pane is previewing; the model is found from it. */
  documentId: string
  /** File name, which is how the workspace addresses a model in a link. */
  filename: string
  /**
   * The project whose model list resolves this file, when the surface has one.
   *
   * Optional, and that is the whole point. Models used to be reachable ONLY
   * through `/api/projects/[id]/bim/models`, so a project was a prerequisite
   * for looking at a model — and the org-wide Archiv, which has no project,
   * therefore showed the ordinary "no inline preview" placeholder for a
   * building it had already parsed and indexed. Without a project the model is
   * resolved by its document instead (`useDocumentBimModel`), which is the more
   * direct question anyway; the project path is kept as-is because it shares
   * its in-flight list with every other model surface on the page.
   */
  projectId?: string | null
  className?: string
}

export function IfcFilePreview({ documentId, filename, projectId, className }: IfcFilePreviewProps): JSX.Element {
  const t = useTranslations('bim')
  // Detected here, not passed in: the documents pane should not have to learn
  // what WebGPU is to show a file.
  const webGpu = useMemo(() => supportsWebGpu(), [])
  // Exactly one of these does any work — the other is passed null and stays
  // idle. Both are called unconditionally because hooks are.
  const models = useProjectBimModels(projectId ?? null)
  const documentModel = useDocumentBimModel(projectId ? null : documentId)

  // The model is addressed by its DOCUMENT, because that is what the pane has
  // and what the user clicked. A file whose extraction has not finished (or
  // failed) simply has no ready model, and says so rather than rendering an
  // empty viewport.
  const model = useMemo(
    () =>
      projectId
        ? (models.data?.find((candidate) => candidate.documentId === documentId) ?? null)
        : documentModel.data,
    [projectId, models.data, documentModel.data, documentId]
  )
  const ready = model?.status === 'ready' ? model : null

  const source = useBimModelSource(ready?.id ?? null, webGpu && ready !== null)
  const elements = useBimElements(ready?.id ?? null)

  // Which lookup's state the branches below read.
  const lookup = projectId
    ? { isLoading: models.isLoading, hasData: models.data !== null, error: models.error }
    : { isLoading: documentModel.isLoading, hasData: documentModel.data !== null, error: documentModel.error }

  // The link opens THIS file, not whichever model the workspace would default
  // to — the workspace resolves a model by file name (`?model=`), which is also
  // why no UUID travels through the URL.
  //
  // Null without a project: the model workspace IS a project surface, and a
  // link that cannot be built must not be rendered as one that goes nowhere.
  // The Archiv's preview is therefore the viewport itself, with no way out —
  // which is honest, and better than the placeholder it replaced.
  const href = projectId ? buildModelHref(projectId, { model: filename }) : undefined

  // Only while there is nothing to show. The list polls every four seconds
  // whenever any model in the project is extracting and keeps its previous
  // `data` across the refetch, so keying on the flag alone made this preview
  // blink back to "Modell wird geladen…" — and remount the viewport under it —
  // for the whole minute after somebody uploads anything.
  if (lookup.isLoading && !lookup.hasData) {
    return <PreviewNote className={className} text={t('preview.loading')} />
  }

  if (lookup.error !== null) {
    // "The list did not load" is NOT "there is no model", and saying the latter
    // would tell the reader their upload vanished.
    return <PreviewNote className={className} text={t('preview.loadFailed')} href={href} label={t('preview.open')} />
  }

  if (!ready) {
    // Three different situations, one honest sentence each — "still being read"
    // and "there is no model" are different answers and must not be conflated.
    const text =
      model?.status === 'failed'
        ? t('preview.extractionFailed')
        : model
          ? t('preview.extracting')
          : t('preview.noModel')
    return (
      <PreviewNote
        className={className}
        text={text}
        // Nothing to open when no model was ever read from this file.
        href={model ? href : undefined}
        label={t('preview.open')}
      />
    )
  }

  if (!webGpu) {
    // The viewport has its own WebGPU fallback, but its copy points at the
    // model page's element tables ("still available on the left"), and there is
    // no left here. Say what this surface can actually offer instead.
    return <PreviewNote className={className} text={t('preview.noWebGpu')} href={href} label={t('preview.open')} />
  }

  if (source.error !== null) {
    // WebGPU is ruled out one branch above, so falling through to
    // `IfcModelViewer` here rendered "Der Viewer benötigt WebGPU" — a sentence
    // that was provably false at this point in the tree. The model is fine;
    // the short-lived URL that streams it could not be minted.
    return (
      <PreviewNote
        className={className}
        // NOT `preview.loadFailed`, which says the project's models are
        // unavailable. At this point the list loaded, the model is `ready`,
        // and only the short-lived URL that streams it could not be minted —
        // the comment above says exactly that while the string said the
        // opposite.
        text={t('preview.sourceFailed')}
        href={href}
        label={t('preview.open')}
      />
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)}>
      <IfcModelViewer
        sourceUrl={source.data}
        // One shared empty array: `?? []` inline mints a new one every render,
        // which changes the canvas's props identity for a value that did not
        // change. The stage has said so in a comment since it was written;
        // this surface did the thing the comment warns against.
        elements={elements.data ?? NO_ELEMENTS}
        className="min-h-[220px] flex-1"
      />
      {/* Absent in the Archiv, where there is no project workspace to open. */}
      {href && <OpenInWorkspace href={href} label={t('preview.open')} />}
    </div>
  )
}

/** One shared empty array, so "no elements yet" has a stable identity. */
const NO_ELEMENTS: never[] = []

/** The states that are a sentence rather than a building. */
function PreviewNote({
  text,
  className,
  href,
  label,
}: {
  text: string
  className?: string
  href?: string
  label?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center',
        className
      )}
    >
      <Boxes className="size-6 text-muted-foreground" aria-hidden />
      <p className="max-w-prose text-sm text-muted-foreground text-balance">{text}</p>
      {href && label && <OpenInWorkspace href={href} label={label} />}
    </div>
  )
}

/**
 * The one way out of the preview and into the analytical surface.
 *
 * A link, not a button: it navigates, so it must open in a new tab on
 * middle-click and be copyable — which is the whole point of the workspace's
 * URL-encoded views.
 */
function OpenInWorkspace({ href, label }: { href: string; label: string }): JSX.Element {
  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center justify-center gap-1.5 self-center rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-target"
    >
      {label}
      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
    </Link>
  )
}

export default IfcFilePreview
