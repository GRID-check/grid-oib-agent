'use client'

/**
 * Data access for the model surfaces.
 *
 * Every read goes through the BFF, never straight to the query layer: the
 * routes are where the `ifc-models` flag and the project-access check live, and
 * a client that could reach the SQL would be a client that could skip them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BimProfileSuggestion } from '@/lib/bim/profile'
import type { BimComplianceSummary, BimRuleResult } from '@/lib/bim/rules'
import type { BimQuantityRow, BimRoomSchedule } from '@/lib/bim/schedule'
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
  /**
   * ISO-8601 — the row's `updated_at` after JSON transport, which is what
   * orders a revision series. A `Date` on the server is a string here.
   */
  updatedAt: string
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

/**
 * Server-computed model tables: Raumbuch, Massenermittlung, derived facts.
 *
 * These deliberately do NOT reuse the element list the page already holds. The
 * element list is capped at the API's page budget and carries no quantities, so
 * summing it in the browser would produce a Flächenaufstellung that is short by
 * however many rows did not fit — silently, and only for large models. The
 * server computes them over the full element set, which is the same code path
 * the agent's answers go through, so the page and the chat cannot disagree.
 */
function useModelQuery<T>(
  modelId: string | null,
  request: Record<string, unknown> | null,
  select: (body: BimQueryResponse) => T | null
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>(IDLE)
  const body = request ? JSON.stringify(request) : null

  useEffect(() => {
    if (!modelId || !body) {
      setState(IDLE)
      return
    }
    let cancelled = false
    setState({ data: null, isLoading: true, error: null })
    getJson<BimQueryResponse>(`/api/bim/models/${modelId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
      .then((payload) => {
        if (!cancelled) setState({ data: select(payload), isLoading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: 'load-failed' })
      })
    return () => {
      cancelled = true
    }
    // `select` is a module-level function at every call site; re-running on its
    // identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, body])

  return state
}

/** What the query route returns — the subset of `BimQueryResult` used here. */
interface BimQueryResponse {
  summary?: string
  caveat?: string | null
  compliance?: BimRuleResult[]
  complianceSummary?: BimComplianceSummary
  complianceShoppingList?: Array<{ path: string; elements: number; rules: string[] }>
  schedule?: BimRoomSchedule
  takeoff?: BimQuantityRow[]
  profileSuggestions?: BimProfileSuggestion[]
}

const SCHEDULE_REQUEST = { op: 'schedule' } as const
const PROFILE_REQUEST = { op: 'profile' } as const

const selectSchedule = (body: BimQueryResponse): BimRoomSchedule | null => body.schedule ?? null
const selectTakeoff = (body: BimQueryResponse): BimQuantityRow[] | null => body.takeoff ?? null
const selectProfile = (body: BimQueryResponse): BimProfileSuggestion[] | null =>
  body.profileSuggestions ?? null

/** The Raumbuch: rooms per storey with the totals and their blind spots. */
export function useBimRoomSchedule(modelId: string | null): AsyncState<BimRoomSchedule> {
  return useModelQuery(modelId, SCHEDULE_REQUEST, selectSchedule)
}

/** The Massenermittlung for one quantity, optionally split by material. */
export function useBimTakeoff(
  modelId: string | null,
  quantity: string,
  byMaterial: boolean
): AsyncState<BimQuantityRow[]> {
  const request = useMemo(
    () => ({ op: 'takeoff' as const, quantity, byMaterial }),
    [quantity, byMaterial]
  )
  return useModelQuery(modelId, request, selectTakeoff)
}

/** Project-brief facts the model supports, each with the evidence behind it. */
export function useBimProfileSuggestions(
  modelId: string | null
): AsyncState<BimProfileSuggestion[]> {
  return useModelQuery(modelId, PROFILE_REQUEST, selectProfile)
}

interface BimComplianceView {
  rules: BimRuleResult[]
  summary: BimComplianceSummary | null
  shoppingList: Array<{ path: string; elements: number; rules: string[] }>
}

const selectCompliance = (body: BimQueryResponse): BimComplianceView | null =>
  body.compliance
    ? {
        rules: body.compliance,
        summary: body.complianceSummary ?? null,
        shoppingList: body.complianceShoppingList ?? [],
      }
    : null

/**
 * The Prüfbuch for one model.
 *
 * The project facts are threaded in rather than defaulted: a rule that needs a
 * Gebäudeklasse it was not given stands down with its reason, and assuming the
 * mildest class would turn a GK5 building's missing R 90 into a pass.
 */
export function useBimCompliance(
  modelId: string | null,
  facts: { gebaeudeklasse: number | null; hauptnutzung: string | null }
): AsyncState<BimComplianceView> {
  const request = useMemo(
    () => ({
      op: 'compliance' as const,
      ...(facts.gebaeudeklasse === null ? {} : { gebaeudeklasse: facts.gebaeudeklasse }),
      ...(facts.hauptnutzung === null ? {} : { hauptnutzung: facts.hauptnutzung }),
    }),
    [facts.gebaeudeklasse, facts.hauptnutzung]
  )
  return useModelQuery(modelId, request, selectCompliance)
}

/**
 * The facts the rule catalogue reads, from the project brief.
 *
 * Read here rather than passed down because the model page is the only surface
 * that needs them, and a fact the brief does not carry must arrive as `null`
 * (the rules then say so) rather than as a default.
 */
export function useProjectRuleFacts(projectId: string | null): {
  gebaeudeklasse: number | null
  hauptnutzung: string | null
  missing: string[]
} {
  const [facts, setFacts] = useState<{ gebaeudeklasse: number | null; hauptnutzung: string | null }>({
    gebaeudeklasse: null,
    hauptnutzung: null,
  })

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getJson<{ facts?: Record<string, { value?: unknown }> }>(`/api/projects/${projectId}/profile`)
      .then((profile) => {
        if (cancelled) return
        const raw = profile.facts ?? {}
        const klasse = Number(raw.gebaeudeklasse?.value)
        const nutzung = raw.hauptnutzung?.value
        setFacts({
          gebaeudeklasse: Number.isInteger(klasse) && klasse >= 1 && klasse <= 5 ? klasse : null,
          hauptnutzung: typeof nutzung === 'string' && nutzung.trim() !== '' ? nutzung : null,
        })
      })
      .catch(() => {
        // A profile that cannot be read is the same situation as a profile that
        // does not carry the fact: the rules stand down and say so.
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const missing = useMemo(() => {
    const gaps: string[] = []
    if (facts.gebaeudeklasse === null) gaps.push('Gebäudeklasse')
    if (facts.hauptnutzung === null) gaps.push('Hauptnutzung')
    return gaps
  }, [facts])

  return { ...facts, missing }
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
