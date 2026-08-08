'use client'

/**
 * Data access for the model surfaces.
 *
 * Every read goes through the BFF, never straight to the query layer: the
 * routes are where the `ifc-models` flag and the project-access check live, and
 * a client that could reach the SQL would be a client that could skip them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BimModelSummary } from '@/lib/bim/types'
import type { BimViewerElement } from '../lib/model-index'

export interface BimModelHeaderView {
  id: string
  documentId: string
  projectId: string | null
  filename: string
  status: 'pending' | 'extracting' | 'ready' | 'failed'
  schemaVersion: string | null
  elementCount: number
  errorMessage: string | null
  summary: BimModelSummary | null
}

interface AsyncState<T> {
  data: T | null
  isLoading: boolean
  error: string | null
}

const IDLE = { data: null, isLoading: false, error: null } as const

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${response.status}`)
  return (await response.json()) as T
}

/** Models in scope for a project: its own plus the org Archiv's. */
export function useProjectBimModels(projectId: string | null): AsyncState<BimModelHeaderView[]> & {
  reload: () => void
} {
  const [state, setState] = useState<AsyncState<BimModelHeaderView[]>>(IDLE)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!projectId) {
      setState(IDLE)
      return
    }
    let cancelled = false
    setState({ data: null, isLoading: true, error: null })
    getJson<{ models: BimModelHeaderView[] }>(`/api/projects/${projectId}/bim/models`)
      .then((body) => {
        if (!cancelled) setState({ data: body.models, isLoading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: 'load-failed' })
      })
    return () => {
      cancelled = true
    }
  }, [projectId, tick])

  return { ...state, reload: useCallback(() => setTick((value) => value + 1), []) }
}

/**
 * Every element of a model, paged through until complete.
 *
 * The viewer needs the whole set in memory anyway (it maps a pick's express id
 * back to a name), and the element table filters client-side so typing in the
 * search box is instant rather than a round trip per keystroke. The page cap
 * is the API's, so a very large model arrives in a handful of requests instead
 * of one that times out.
 */
export function useBimElements(modelId: string | null): AsyncState<BimViewerElement[]> {
  const [state, setState] = useState<AsyncState<BimViewerElement[]>>(IDLE)

  useEffect(() => {
    if (!modelId) {
      setState(IDLE)
      return
    }
    let cancelled = false
    setState({ data: null, isLoading: true, error: null })

    const load = async () => {
      const collected: BimViewerElement[] = []
      let offset = 0
      // Bounded so a pathological model cannot spin forever: 200 pages × 200
      // rows is the extraction cap, past which there is nothing more to fetch.
      for (let page = 0; page < 1000; page += 1) {
        const body = await getJson<{ elements: BimViewerElement[]; total: number }>(
          `/api/bim/models/${modelId}/query`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'elements', filter: {}, limit: 200, offset }),
          }
        )
        if (cancelled) return
        collected.push(...body.elements)
        offset += body.elements.length
        if (body.elements.length === 0 || collected.length >= body.total) break
      }
      if (!cancelled) setState({ data: collected, isLoading: false, error: null })
    }

    load().catch(() => {
      if (!cancelled) setState({ data: null, isLoading: false, error: 'load-failed' })
    })

    return () => {
      cancelled = true
    }
  }, [modelId])

  return state
}

export interface BimElementDetail {
  globalId: string
  expressId: number
  ifcType: string
  name: string | null
  description: string | null
  predefinedType: string | null
  objectType: string | null
  tag: string | null
  typeName: string | null
  storeyName: string | null
  materials: string[]
  classifications: Array<{ system: string | null; identification: string | null; name: string | null }>
  properties: Record<string, Record<string, string | number | boolean | null>>
  quantities: Record<string, Record<string, number>>
}

/** One element in full, fetched when the selection changes. */
export function useBimElementDetail(
  modelId: string | null,
  globalId: string | null
): AsyncState<BimElementDetail> {
  const [state, setState] = useState<AsyncState<BimElementDetail>>(IDLE)

  useEffect(() => {
    if (!modelId || !globalId) {
      setState(IDLE)
      return
    }
    let cancelled = false
    setState({ data: null, isLoading: true, error: null })
    getJson<{ element: BimElementDetail | null }>(`/api/bim/models/${modelId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'element', globalId }),
    })
      .then((body) => {
        if (!cancelled) setState({ data: body.element, isLoading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: 'load-failed' })
      })
    return () => {
      cancelled = true
    }
  }, [modelId, globalId])

  return state
}

/**
 * The presigned URL the viewport streams the model from.
 *
 * Fetched lazily — only once a viewport is actually going to mount — because
 * minting it is a signature over object storage, not a free read, and a browser
 * with no WebGPU never needs one.
 */
export function useBimModelSource(modelId: string | null, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!modelId || !enabled) {
      setUrl(null)
      return
    }
    let cancelled = false
    getJson<{ url: string }>(`/api/bim/models/${modelId}/source`)
      .then((body) => {
        if (!cancelled) setUrl(body.url)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [modelId, enabled])

  return url
}

/** The first ready model, or the first model at all — the page's default. */
export function pickDefaultModel(models: readonly BimModelHeaderView[]): BimModelHeaderView | null {
  return models.find((model) => model.status === 'ready') ?? models[0] ?? null
}

/** Distinct IFC types present, for the element table's type filter. */
export function useElementTypes(elements: readonly BimViewerElement[]): string[] {
  return useMemo(
    () => [...new Set(elements.map((element) => element.ifcType))].sort(),
    [elements]
  )
}
