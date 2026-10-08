'use client'

/**
 * An `.ifc` previewed in the Dateien pane — as the building, not as a page mock.
 *
 * ## Why this exists
 *
 * A PDF previews as pages and an image previews as itself. An IFC previewed as
 * a placeholder reading "no inline preview", with the model experience parked
 * on a separate `/model` route, would make the model a side tool bolted on
 * beside the file system rather than what the file IS — and a route nobody
 * navigates to is a feature nobody uses.
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
 * one click away — the open-in-workspace button below the viewport — because a
 * preview well a few hundred pixels wide is the wrong place to read a
 * compliance table.
 *
 * ## Why an `.ifc` behaves the same in every workspace
 *
 * A click on an IFC opens the file as a preview, in every workspace, and the
 * preview offers the workspace. Going straight to the full-screen stage would
 * skip the preview every other file gets, and a preview with no way out would
 * be a dead end in the Archiv, which has no project to name in the link. Where
 * there is no project — the Archiv — the offer asks which one to open in,
 * because the stage's Prüfbuch reads Gebäudeklasse and Hauptnutzung, and those
 * are facts about a project rather than about the file.
 */

import type { JSX } from 'react'
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
import { buildArchivModelHref, buildModelHref } from '../lib/model-link'
import { IfcModelViewer } from './ifc-model-viewer'

interface IfcFilePreviewProps {
  /** The DOCUMENT this pane is previewing; the model is found from it. */
  documentId: string
  /** File name, which is how the workspace addresses a model in a link. */
  filename: string
  /**
   * The project whose model list resolves this file, when the surface has one.
   *
   * Optional. Without a project the model is resolved by its document instead
   * (`useDocumentBimModel`), which is the more direct question anyway. The
   * project path goes through `/api/projects/[id]/bim/models` and shares its
   * in-flight list with every other model surface on the page; the org-wide
   * Archiv has no project to name, so it resolves by document.
   */
  projectId?: string | null
  /**
   * Whether the way on to the model workspace is offered (`ifc-models`).
   *
   * The flag decides whether the preview also offers the stage. Off, the
   * preview is still a working surface with one affordance missing, not a
   * different surface.
   */
  canOpenWorkspace?: boolean
  className?: string
}

export function IfcFilePreview({
  documentId,
  filename,
  projectId,
  canOpenWorkspace = true,
  className,
}: IfcFilePreviewProps): JSX.Element {
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
  // Undefined without a project, which is not the end of the offer:
  // `ModelProjectPicker` below asks which project to open in and builds the
  // same link from the answer. The stage can already reach an Archiv model
  // from any project (`listAccessibleModels` passes `includeArchiv`), so the
  // only thing missing is somebody to name the project — which is a question,
  // not an impossibility.
  // The Archiv gets the SAME offer on its own route: the stage needs no
  // project, so „Im Modellbereich öffnen" means the same thing here as it
  // does in a project's Dateien.
  const href = !canOpenWorkspace
    ? undefined
    : projectId
      ? buildModelHref(projectId, { model: filename })
      : buildArchivModelHref({ model: filename })

  // Only while there is nothing to show. The list polls every four seconds
  // while any model in the project is extracting and keeps its previous
  // `data` across the refetch, so keying on the flag alone would blink this
  // preview back to "Modell wird geladen…" — and remount the viewport under
  // it — for as long as extraction runs after an upload.
  if (lookup.isLoading && !lookup.hasData) {
    return <PreviewNote className={className} text={t('preview.loading')} />
  }

  if (lookup.error !== null) {
    // "The list did not load" is NOT "there is no model", and saying the latter
    // would tell the reader their upload vanished.
    return (
      <PreviewNote
        className={className}
        text={t('preview.loadFailed')}
        href={href}
        label={t('preview.open')}
      />
    )
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
    return (
      <PreviewNote
        className={className}
        text={t('preview.noWebGpu')}
        href={href}
        label={t('preview.open')}
      />
    )
  }

  if (source.error !== null) {
    // WebGPU is ruled out one branch above, so a fall through to
    // `IfcModelViewer` here would render "Der Viewer benötigt WebGPU" — a
    // sentence that is provably false at this point in the tree. The model is
    // fine; the short-lived URL that streams it could not be minted.
    return (
      <PreviewNote
        className={className}
        // NOT `preview.loadFailed`, which says the project's models are
        // unavailable. At this point the list loaded and the model is `ready`;
        // only the short-lived URL that streams it could not be minted.
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
        // change.
        elements={elements.data ?? NO_ELEMENTS}
        className="min-h-[220px] flex-1"
      />
      {/* Offered on every surface, project or Archiv — see the header. */}
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
        'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
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
      className="inline-flex shrink-0 items-center justify-center gap-1.5 self-center rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors duration-quick ease-out hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-target"
    >
      {label}
      <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
    </Link>
  )
}

export default IfcFilePreview
