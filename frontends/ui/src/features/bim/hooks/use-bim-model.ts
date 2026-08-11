'use client'

/**
 * Data access for the model surfaces.
 *
 * Every read goes through the BFF, never straight to the query layer: the
 * routes are where the `ifc-models` flag and the project-access check live, and
 * a client that could reach the SQL would be a client that could skip them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BimProfileSuggestion } from '@/lib/bim/profile'
import {
  attachConfirmations,
  type BimCheckConfirmation,
  type BimComplianceChange,
  type BimComplianceSummary,
  type BimRuleResult,
  type BimRuleResultWithConfirmation,
} from '@/lib/bim/rules'
import type { BimQuantityRow, BimRoomSchedule } from '@/lib/bim/schedule'
import { BIM_ELEMENTS_PAGE_LIMIT, type BimModelSummary } from '@/lib/bim/types'
import type { BimHighlightGroup, BimHighlightStatus, BimViewerElement } from '../lib/model-index'

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

/**
 * How often a page re-asks while an extraction is running.
 *
 * A 60 MB model takes tens of seconds, so this is a handful of requests, and
 * the interval only exists while something is actually extracting.
 */
const EXTRACTION_POLL_MS = 4_000

/**
 * The model list request currently in flight per project, shared by everything
 * that asks for it at the same moment.
 *
 * The list stopped being one page's data: the chat welcome asks whether this
 * project has a readable model, the file preview asks which model belongs to a
 * document, its metadata rail asks what the model contains, and every
 * `ifc_viewer` card in a thread asks again. Mounting an answer with two model
 * cards used to fire four identical requests, each spending a point of the
 * `bim-query` budget on the same rows.
 *
 * Deliberately in-flight only — no TTL. A cache with a lifetime would have to
 * answer "how stale may a model be", and the surfaces that care already poll
 * (extraction) or remount (navigation). Collapsing a simultaneous burst is free
 * and cannot show anyone a stale model.
 */
const modelsInFlight = new Map<string, Promise<{ models: BimModelHeaderView[] }>>()

function fetchProjectModels(projectId: string): Promise<{ models: BimModelHeaderView[] }> {
  const existing = modelsInFlight.get(projectId)
  if (existing) return existing
  const request = getJson<{ models: BimModelHeaderView[] }>(
    `/api/projects/${projectId}/bim/models`
  ).finally(() => {
    modelsInFlight.delete(projectId)
  })
  modelsInFlight.set(projectId, request)
  return request
}

/** Models in scope for a project: its own plus the org Archiv's. */
export function useProjectBimModels(projectId: string | null): AsyncState<BimModelHeaderView[]> & {
  reload: () => void
} {
  const [state, setState] = useState<AsyncState<BimModelHeaderView[]>>(IDLE)
  const [tick, setTick] = useState(0)
  /** Which project the list on screen belongs to — see the carry-over below. */
  const shownFor = useRef<string | null>(null)

  useEffect(() => {
    if (!projectId) {
      shownFor.current = null
      setState(IDLE)
      return
    }
    let cancelled = false
    // Keep what is on screen while the next answer is in flight.
    //
    // This effect also runs on every poll tick below, and it used to blank
    // `data` each time. On a project with one model still extracting — i.e.
    // for the whole minute after somebody uploads — that emptied the model
    // list every four seconds, which took `modelId` to null, which unmounted
    // the canvas, which destroyed the WebGPU device and the WASM kernel. Four
    // seconds later a fresh presigned URL was minted and the entire model, up
    // to 149 MB, was downloaded and re-triangulated. On a loop.
    //
    // A refetch is not a reset: the previous list is the best answer available
    // until a better one arrives, and a stale row is a far smaller lie than a
    // viewport that keeps restarting. Another PROJECT's models are not a
    // better answer than none, so the carry-over is scoped to the project the
    // data on screen belongs to.
    const carryOver = shownFor.current === projectId
    shownFor.current = projectId
    setState((previous) => ({
      data: carryOver ? previous.data : null,
      isLoading: true,
      error: null,
    }))
    fetchProjectModels(projectId)
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

  // A model the user just uploaded arrives `pending`/`extracting`, and nothing
  // told the page when that finished — the upload appeared to hang until
  // somebody reloaded, on exactly the surface whose whole promise is "drop an
  // IFC in and ask it questions". Polling stops the moment nothing is in
  // flight, so a page showing only `ready` models makes no requests at all.
  const extracting = (state.data ?? []).some(
    (model) => model.status === 'pending' || model.status === 'extracting'
  )
  useEffect(() => {
    if (!extracting) return
    const timer = setInterval(() => setTick((value) => value + 1), EXTRACTION_POLL_MS)
    return () => clearInterval(timer)
  }, [extracting])

  return { ...state, reload: useCallback(() => setTick((value) => value + 1), []) }
}

/**
 * Walk every element matching a filter, paged through until complete.
 *
 * Shared by the viewer's full-model load (`filter: {}`) and by a card's
 * filter-matched highlight groups, which run the SAME filter grammar the agent
 * wrote for `ifc_query` — see {@link useBimHighlightGroups}. Extracted so the
 * two cannot drift: the termination rule below is subtle enough that a second
 * copy of it would eventually get the `total` semantics wrong.
 */
export async function walkBimElements(
  modelId: string,
  filter: Record<string, unknown>,
  signal: AbortSignal
): Promise<BimViewerElement[]> {
  const PAGE = BIM_ELEMENTS_PAGE_LIMIT
  // Pages fetched at once. The walk was strictly sequential, so its wall
  // clock was `pages × round trip` — on a real model, 200 round trips of
  // latency spent one at a time, and the element table sat empty for all of
  // it. Six is chosen against the server, not the client: it is comfortably
  // inside `bim-query`'s burst clause, and the pool that serves these
  // queries has ten connections, so a wider fan-out would just queue in
  // Postgres while starving every other request on the page.
  const CONCURRENCY = 6

  const fetchPage = (offset: number) =>
    getJson<{ elements: BimViewerElement[]; total?: number; totalIsLowerBound?: boolean }>(
      `/api/bim/models/${modelId}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'elements', filter, limit: PAGE, offset }),
        signal,
      }
    )

  // The first page alone, because it is the only one whose existence is
  // certain and because it reports how many there are. A small model — most
  // models — is one request and done.
  const first = await fetchPage(0)
  const collected = [...first.elements]
  if (first.elements.length < PAGE) return collected

  // `total` is EXACT up to the count ceiling and a lower bound past it, so
  // it sizes the fan-out but never terminates it: a short page does that.
  // Under the ceiling this fetches precisely the pages that exist; over it,
  // rounds continue until one comes back short.
  const known =
    typeof first.total === 'number' && first.totalIsLowerBound !== true
      ? Math.ceil(first.total / PAGE)
      : Infinity

  let offset = PAGE
  let done = false
  // Bounded so a pathological model cannot spin forever: `rounds ×
  // CONCURRENCY × PAGE` clears the extraction cap with room to spare.
  for (let round = 0; round < 80 && !done; round += 1) {
    const width = Math.min(CONCURRENCY, Math.max(1, known - offset / PAGE))
    if (width <= 0) break
    const offsets = Array.from({ length: width }, (_, index) => offset + index * PAGE)
    const pages = await Promise.all(offsets.map(fetchPage))
    for (const page of pages) {
      collected.push(...page.elements)
      // A SHORT page is the end, not `collected.length >= total`: the total
      // stops counting at the ceiling and reports a lower bound past it, so
      // keying on it would silently load 10 000 elements of a
      // 200 000-element model into the viewer and call it the building.
      //
      // Every page of the round is read even after a short one: the
      // requests are concurrent, so the first short page is not necessarily
      // the last one carrying rows.
      if (page.elements.length < PAGE) done = true
    }
    offset += width * PAGE
    if (offset / PAGE >= known) done = true
  }
  return collected
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
    // Navigating away mid-walk left every outstanding page in flight, each one
    // still costing a query and a rate-limit point for a component that no
    // longer exists.
    const controller = new AbortController()
    setState({ data: null, isLoading: true, error: null })

    walkBimElements(modelId, {}, controller.signal)
      .then((elements) => {
        if (!cancelled) setState({ data: elements, isLoading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: 'load-failed' })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [modelId])

  return state
}

/**
 * A card highlight as the agent wrote it: either a literal id list, or the
 * FILTER that selects the set.
 *
 * `globalIds` is what the agent can write when the answer is about a handful of
 * elements it named. It stops being usable the moment the answer is about a
 * set: "the 420 external walls" cannot travel as 420 ids through an LLM's
 * context, so the card highlighted whatever fitted and quietly under-reported
 * the rest.
 *
 * `match` is the same filter grammar the agent already passed to `ifc_query` to
 * COUNT that set, re-run in the browser to select it. The full set highlights,
 * exactly, and the ids cost the model nothing — it copies a filter it has
 * already written rather than transcribing hundreds of opaque strings.
 */
export interface BimHighlightSpec {
  globalIds?: string[]
  /** The `ifc_query` filter object, passed through untouched. */
  match?: Record<string, unknown>
  label: string
  status: BimHighlightStatus
}

/**
 * Resolve every filter-matched highlight group into a plain id list.
 *
 * Groups that already carry ids pass straight through — no request, no wait.
 * A group whose filter matches nothing resolves to an empty list rather than
 * disappearing: the legend still names it, which is the difference between
 * "no wall fails this" and "this was never checked".
 */
export function useBimHighlightGroups(
  modelId: string | null,
  specs: readonly BimHighlightSpec[]
): AsyncState<BimHighlightGroup[]> {
  const [resolved, setResolved] = useState<AsyncState<BimHighlightGroup[]>>(IDLE)
  // Serialised, so a card re-rendering with an equal-but-new array does not
  // re-run the walk. The specs come from a card payload and are plain JSON.
  const key = JSON.stringify(specs)

  useEffect(() => {
    const groups: BimHighlightSpec[] = JSON.parse(key)
    const literal = groups.map((group) => ({
      globalIds: group.globalIds ?? [],
      label: group.label,
      status: group.status,
    }))
    if (!modelId || !groups.some((group) => group.match)) {
      setResolved({ data: literal, isLoading: false, error: null })
      return
    }

    let cancelled = false
    const controller = new AbortController()
    setResolved({ data: null, isLoading: true, error: null })

    // SEQUENTIAL across groups, concurrent within one.
    //
    // `walkBimElements` caps itself at six pages in flight, a number chosen
    // against a ten-connection pool and the `bim-query` burst clause. Running
    // the groups in parallel would multiply that cap by the number of groups —
    // a five-group card issuing thirty concurrent queries, and a thread with
    // several cards multiplying it again — which is exactly the pool the cap
    // exists to protect.
    const run = async (): Promise<{ next: BimHighlightGroup[]; failed: boolean }> => {
      const next: BimHighlightGroup[] = []
      let failed = false
      for (const [index, group] of groups.entries()) {
        if (!group.match) {
          next.push(literal[index])
          continue
        }
        try {
          const elements = await walkBimElements(modelId, group.match, controller.signal)
          next.push({
            globalIds: elements.map((element) => element.globalId),
            label: group.label,
            status: group.status,
          })
        } catch {
          // Per group, not per card. `Promise.all` rejects on the first
          // failure, so one bad filter used to discard every group that had
          // already resolved — the opposite of what this fallback promises.
          failed = true
          next.push(literal[index])
        }
      }
      return { next, failed }
    }

    run().then(({ next, failed }) => {
      // The card still renders the building and every group that did resolve;
      // a failed filter must not blank the viewport.
      if (!cancelled) setResolved({ data: next, isLoading: false, error: failed ? 'load-failed' : null })
    })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [modelId, key])

  return resolved
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
 *
 * ## Why this returns a state and not a string
 *
 * It used to return `string | null`, mapping every failure to `null`. Both
 * consumers then rendered that as something it was not: the stage showed an
 * indeterminate progress bar forever, and the file preview said "Der Viewer
 * benötigt WebGPU" — on a branch where WebGPU had already been ruled out one
 * line earlier, so the sentence was provably false. A 403 from a withdrawn
 * feature flag, a 500 and a dropped connection all looked like loading.
 *
 * `reload` is the other half. The URL has a ten-minute TTL and is minted
 * exactly once, so a viewport left open past it — or one whose GPU device was
 * taken away by a driver reset — had no way back except closing the whole
 * stage, which nobody would think to try. Re-signing produces a NEW url, and a
 * new url is what resets the viewport's stored status and remounts the canvas;
 * the machinery was already there with nothing to trigger it.
 */
export function useBimModelSource(
  modelId: string | null,
  enabled: boolean
): AsyncState<string> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<string>>(IDLE)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!modelId || !enabled) {
      setState(IDLE)
      return
    }
    let cancelled = false
    // Cleared on purpose, unlike the model list: the previous URL points at a
    // DIFFERENT model, and handing it to the viewport would download the wrong
    // building.
    setState({ data: null, isLoading: true, error: null })
    getJson<{ url: string }>(`/api/bim/models/${modelId}/source`)
      .then((body) => {
        if (!cancelled) setState({ data: body.url, isLoading: false, error: null })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: 'load-failed' })
      })
    return () => {
      cancelled = true
    }
  }, [modelId, enabled, tick])

  return { ...state, reload: useCallback(() => setTick((value) => value + 1), []) }
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
  /** The element loader capped — every derived count is over a subset. */
  truncated?: boolean
  compliance?: BimRuleResult[]
  complianceSummary?: BimComplianceSummary
  complianceShoppingList?: Array<{ path: string; elements: number; rules: string[] }>
  schedule?: BimRoomSchedule
  takeoff?: BimQuantityRow[]
  profileSuggestions?: BimProfileSuggestion[]
}

const SCHEDULE_REQUEST = { op: 'schedule' } as const
const PROFILE_REQUEST = { op: 'profile' } as const

/**
 * The tables, WITH the flag saying whether they cover the whole building.
 *
 * The query layer computes `truncated` for every one of these — its own
 * comment calls the banner "the only thing stopping 'was hat sich
 * verschlechtert' being answered from half a building" — and the selectors
 * dropped it on the floor. A Raumbuch's `Gesamt` row was then printed as a
 * building total over however many rooms fitted under the cap, and
 * "Keine Anforderung hat ihren Status geändert" read identically for "nothing
 * regressed" and "we compared half of each revision".
 */
const selectSchedule = (
  body: BimQueryResponse
): { schedule: BimRoomSchedule; truncated: boolean } | null =>
  body.schedule ? { schedule: body.schedule, truncated: body.truncated ?? false } : null
const selectTakeoff = (
  body: BimQueryResponse
): { rows: BimQuantityRow[]; truncated: boolean } | null =>
  body.takeoff ? { rows: body.takeoff, truncated: body.truncated ?? false } : null
const selectProfile = (body: BimQueryResponse): BimProfileSuggestion[] | null =>
  body.profileSuggestions ?? null

/** The Raumbuch: rooms per storey with the totals and their blind spots. */
export function useBimRoomSchedule(
  modelId: string | null
): AsyncState<{ schedule: BimRoomSchedule; truncated: boolean }> {
  return useModelQuery(modelId, SCHEDULE_REQUEST, selectSchedule)
}

/** The Massenermittlung for one quantity, optionally split by material. */
export function useBimTakeoff(
  modelId: string | null,
  quantity: string,
  byMaterial: boolean
): AsyncState<{ rows: BimQuantityRow[]; truncated: boolean }> {
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
  rules: BimRuleResultWithConfirmation[]
  summary: BimComplianceSummary | null
  shoppingList: Array<{ path: string; elements: number; rules: string[] }>
  /**
   * The catalogue saw only part of the model — the element loader capped.
   *
   * Carried all the way to the panel because every count below it is then a
   * count over a subset, and a Prüfbuch that does not say so is asserting
   * something it did not check.
   */
  truncated: boolean
}

const selectCompliance = (body: BimQueryResponse): BimComplianceView | null =>
  body.compliance
    ? {
        // Confirmations are attached later; the query layer knows only the model.
        rules: body.compliance.map((rule) => ({
          ...rule,
          confirmation: null,
          confirmationStale: false,
        })),
        summary: body.complianceSummary ?? null,
        shoppingList: body.complianceShoppingList ?? [],
        truncated: body.truncated === true,
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
  projectId: string | null,
  modelId: string | null,
  facts: { gebaeudeklasse: number | null; hauptnutzung: string | null; ready?: boolean }
): AsyncState<BimComplianceView> & {
  confirm: (ruleId: string, note: string) => Promise<void>
  withdraw: (ruleId: string) => Promise<void>
} {
  const request = useMemo(
    () => ({
      op: 'compliance' as const,
      ...(facts.gebaeudeklasse === null ? {} : { gebaeudeklasse: facts.gebaeudeklasse }),
      ...(facts.hauptnutzung === null ? {} : { hauptnutzung: facts.hauptnutzung }),
    }),
    [facts.gebaeudeklasse, facts.hauptnutzung]
  )
  // Held until the brief has settled: running now would spend a full
  // catalogue pass on facts we are about to replace.
  const run = useModelQuery(facts.ready === false ? null : modelId, request, selectCompliance)
  const [confirmations, setConfirmations] = useState<BimCheckConfirmation[]>([])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getJson<{ confirmations: BimCheckConfirmation[] }>(`/api/projects/${projectId}/bim/checks`)
      .then((body) => {
        if (!cancelled) setConfirmations(body.confirmations)
      })
      .catch(() => {
        // No confirmations readable is the same as none recorded: every rule
        // shows the catalogue's own verdict, which is never wrong, only less
        // complete.
      })
    return () => {
      cancelled = true
    }
  }, [projectId, tick])

  const write = useCallback(
    async (method: 'POST' | 'DELETE', body: Record<string, unknown>) => {
      if (!projectId) return
      await getJson(`/api/projects/${projectId}/bim/checks`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setTick((value) => value + 1)
    },
    [projectId]
  )

  const data = useMemo(() => {
    if (!run.data || !modelId) return run.data
    return {
      ...run.data,
      // Attached in the CLIENT rather than joined server-side: the verdicts are
      // a pure function of the model and the confirmations are a pure function
      // of the project, and keeping them separate is what lets a confirmation
      // be recorded without recomputing the whole catalogue.
      rules: attachConfirmations(run.data.rules, confirmations, modelId),
    }
  }, [run.data, confirmations, modelId])

  return {
    ...run,
    data,
    confirm: useCallback(
      (ruleId: string, note: string) =>
        write('POST', { ruleId, modelId, note: note === '' ? null : note }),
      [write, modelId]
    ),
    withdraw: useCallback((ruleId: string) => write('DELETE', { ruleId }), [write]),
  }
}

/**
 * What a revision changed about the building's standing.
 *
 * Explicitly triggered rather than fetched on mount: it reads both revisions'
 * full element sets, which is worth doing when asked and not worth doing
 * because somebody opened a tab.
 */
export function useBimComplianceDiff(
  modelId: string | null,
  baseModelId: string | null,
  facts: { gebaeudeklasse: number | null; hauptnutzung: string | null }
): AsyncState<{ changes: BimComplianceChange[]; truncated: boolean }> & { run: () => void } {
  const [state, setState] = useState<
    AsyncState<{ changes: BimComplianceChange[]; truncated: boolean }>
  >(IDLE)

  const run = useCallback(() => {
    if (!modelId || !baseModelId) return
    setState({ data: null, isLoading: true, error: null })
    getJson<{ complianceChanges?: BimComplianceChange[]; truncated?: boolean }>(
      `/api/bim/models/${modelId}/query`,
      {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'compliance-diff',
        baseModelId,
        ...(facts.gebaeudeklasse === null ? {} : { gebaeudeklasse: facts.gebaeudeklasse }),
        ...(facts.hauptnutzung === null ? {} : { hauptnutzung: facts.hauptnutzung }),
      }),
    })
      .then((body) =>
        setState({
          data: { changes: body.complianceChanges ?? [], truncated: body.truncated ?? false },
          isLoading: false,
          error: null,
        })
      )
      .catch(() => setState({ data: null, isLoading: false, error: 'load-failed' }))
  }, [modelId, baseModelId, facts.gebaeudeklasse, facts.hauptnutzung])

  return { ...state, run }
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
  /**
   * The brief has been read (or there is none to read).
   *
   * Callers that spend real work per run must WAIT for this. The facts start
   * as `{null, null}` and settle after `/profile` resolves, so a query keyed
   * on them fires twice per page load — and the first run is both discarded
   * and wrong, because it applied no Gebäudeklasse. On a large model that is a
   * measured ~1.5 s and ~126 MB of server work thrown away every time
   * somebody opens the tab.
   */
  ready: boolean
} {
  const [ready, setReady] = useState(false)
  const [facts, setFacts] = useState<{ gebaeudeklasse: number | null; hauptnutzung: string | null }>({
    gebaeudeklasse: null,
    hauptnutzung: null,
  })

  useEffect(() => {
    // No project means no brief to wait for; the rules stand down either way.
    if (!projectId) {
      setReady(true)
      return
    }
    setReady(false)
    let cancelled = false
    getJson<{ facts?: Record<string, { value?: unknown }> }>(`/api/projects/${projectId}/profile`)
      .then((profile) => {
        if (cancelled) return
        const raw = profile.facts ?? {}
        // The brief stores the canonical `GK1`…`GK5` — that is the vocabulary
        // the card schema publishes and the one the chat writes. `Number()`
        // over it is NaN, so a CORRECTLY filled brief read as "no
        // Gebäudeklasse": every rule that depends on it stood down as "nicht
        // einschlägig" on this side, while the agent — which passes the number
        // — returned real verdicts. The compliance card and the answer above
        // it contradicted each other on the same screen.
        //
        // A bare number is still accepted: nothing forbids one, and refusing
        // it would trade one silent stand-down for another.
        const klasse = Number(String(raw.gebaeudeklasse?.value ?? '').trim().replace(/^GK\s*/i, ''))
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
      .finally(() => {
        // Settled either way — a brief that failed to load must not park the
        // catalogue forever behind a spinner.
        if (!cancelled) setReady(true)
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

  return { ...facts, missing, ready }
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
