'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { FileItem } from '../file-types'

/** The viewer's whole view, which closing the stage takes with it. */
const STAGE_PARAMS = ['model', 'element', 'hl', 'storey', 'xray', 'tab', 'view', 'cut', 'cutup', 'proj']

/**
 * `?model=` is what turns a file page into the viewer.
 *
 * In the URL rather than in state, and that is the whole integration: the stage
 * is a view of the page, so it is linkable, the back button closes it, and every
 * `/model?…` link ever written into a chat answer redirects here and opens the
 * same thing. The page learns exactly one fact — whether the parameter is
 * present. Same parameter and same encoding on both shelves, so a link cannot
 * mean one thing in a project and another in the Archiv.
 */
export function useModelStage(enabled: boolean, files: readonly FileItem[]) {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const stageModel = enabled ? (searchParams?.get('model')?.trim() ?? null) : null
  const stageDocument = useMemo(
    () => (stageModel === null ? null : (files.find((file) => file.filename === stageModel) ?? null)),
    [files, stageModel]
  )

  /**
   * Straight to the stage, for the flag-off path. `push`, not `replace`: with
   * `replace` the back button left the page entirely and discarded the camera,
   * the cut, the selection and every measurement — and on a phone, back is how
   * anyone dismisses a full-screen overlay.
   */
  const openModel = useCallback(
    (filename: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('model', filename)
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  /** Closing REPLACES, so shutting the stage leaves no entry that back would re-open. Dropping only `model` would let the next model inherit another building's selection. */
  const closeModel = useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    for (const key of STAGE_PARAMS) params.delete(key)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  return { stageModel, stageDocument, openModel, closeModel }
}
