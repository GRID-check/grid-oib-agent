'use client'

/**
 * The three model-backed cards: room schedule, one element, revision diff.
 *
 * They share one property that is the whole design: **the card carries an
 * identifier and nothing else.** A file name, a GlobalId, a pair of revisions —
 * and the component fetches the numbers from the model. The agent therefore
 * cannot state a floor area, get a fire rating wrong, or invent a delta,
 * because it never supplies one; the worst it can do is point at the wrong
 * table, which is visible immediately.
 *
 * Every row that names an element links into the model page at that element
 * (`buildModelHref`), so a card is a way *into* the building rather than a
 * screenshot of it.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Boxes, Download, GitCompare, ShieldCheck, Table2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import type { BimComparison } from '@/lib/bim/compare'
import { rulesWithOpenWork, type BimRuleResult } from '@/lib/bim/rules'
import { roomScheduleToCsv, type BimRoomSchedule } from '@/lib/bim/schedule'
import { buildModelHref } from '@/features/bim/lib/model-link'
import { formatPropertyValue } from '@/features/bim/lib/format-value'
import { shortIfcType } from '@/features/bim/lib/model-index'
import {
  notReadyModelStatus,
  resolveModelByFilename,
  useProjectBimModels,
  useProjectRuleFacts,
  type BimElementDetail,
  type BimModelHeaderView,
} from '@/features/bim/hooks/use-bim-model'

/** Resolve a model by file name, the way the agent addresses one. */
function useResolvedModel(
  projectId: string | null,
  modelFile: string | null
): {
  model: BimModelHeaderView | null
  models: BimModelHeaderView[]
  /** True only while there is nothing to show — see `NoModel`. */
  isLoading: boolean
  error: string | null
  /** The name matched several models, so none of them is "the" one. */
  ambiguous: boolean
  /** It matched a model that is not readable YET, or not at all. */
  notReady: 'extracting' | 'failed' | null
} {
  const { data, isLoading, error } = useProjectBimModels(projectId)
  const models = useMemo(
    () => (data ?? []).filter((candidate) => candidate.status === 'ready'),
    [data]
  )
  // AMBIGUOUS is not resolved — see `resolveModelByFilename`. `ifc_query`
  // declines to answer when a name hits more than one ready model, and this
  // took the first hit: for a project holding `haus-a.ifc` and `haus-a-alt.ifc`
  // the tool correctly refused while the card beside that same answer drew a
  // DIFFERENT building's geometry under the agent's title.
  const { model, ambiguous } = useMemo(
    () => resolveModelByFilename(models, modelFile),
    [models, modelFile]
  )
  // Why a name that matched nothing READY is still a name this project knows.
  // Told "not available in this project", an architect goes looking for an
  // upload that is either half a minute from finishing or sitting there with a
  // failure they could fix by re-exporting.
  const notReady = useMemo(
    () => (model ? null : notReadyModelStatus(data ?? [], modelFile)),
    [model, data, modelFile]
  )
  // `isLoading` is narrowed to "and nothing to show yet": the list polls every
  // four seconds while any model is extracting and keeps its previous data
  // across the refetch, so the raw flag would flicker every card in a thread.
  return { model, models, isLoading: isLoading && data === null, error, ambiguous, notReady }
}

/** POST one query to a model and keep the typed slice the caller asked for. */
function useModelQuery<T>(
  modelId: string | null,
  body: Record<string, unknown> | null,
  pick: (payload: Record<string, unknown>) => T | undefined
): { data: T | null; isLoading: boolean; error: boolean } {
  const [state, setState] = useState<{ data: T | null; isLoading: boolean; error: boolean }>({
    data: null,
    isLoading: false,
    error: false,
  })
  // The body is an object literal at every call site, so it is a new reference
  // on every render; keying the effect on its serialization is what stops the
  // fetch from looping.
  const key = body ? JSON.stringify(body) : null

  useEffect(() => {
    if (!modelId || !key) {
      setState({ data: null, isLoading: false, error: false })
      return
    }
    let cancelled = false
    setState({ data: null, isLoading: true, error: false })
    fetch(`/api/bim/models/${modelId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: key,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status))
        return (await response.json()) as Record<string, unknown>
      })
      .then((payload) => {
        if (!cancelled) setState({ data: pick(payload) ?? null, isLoading: false, error: false })
      })
      .catch(() => {
        if (!cancelled) setState({ data: null, isLoading: false, error: true })
      })
    return () => {
      cancelled = true
    }
    // `pick` is a stable module-level selector at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, key])

  return state
}

function CardShell({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string
  icon: typeof Boxes
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="rounded-xl border bg-card p-4" aria-label={title}>
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

/**
 * Three situations, not one.
 *
 * "Das referenzierte Modell ist in diesem Projekt nicht verfügbar" is the
 * sentence that tells an architect their upload vanished, and it was rendered
 * for a list that had not arrived yet AND for a list whose request failed —
 * the second one permanently. The sibling file preview refuses to conflate
 * these and says so in a comment; these five cards did it on every mount.
 */
function NoModel({
  isLoading = false,
  error = null,
  ambiguous = false,
  notReady = null,
}: {
  isLoading?: boolean
  error?: string | null
  ambiguous?: boolean
  notReady?: 'extracting' | 'failed' | null
} = {}): JSX.Element {
  const t = useTranslations('bim')
  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-6">
        <Spinner className="size-4" />
      </div>
    )
  }
  return (
    <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      {error !== null
        ? t('preview.loadFailed')
        : ambiguous
          ? // "Not in this project" would be false: it is in the project
            // twice over, which is why nothing is drawn.
            t('card.ambiguousModel')
          : notReady === 'failed'
            ? // The one of these the reader can do something about.
              t('preview.extractionFailed')
            : notReady === 'extracting'
              ? t('preview.extracting')
              : t('card.noModel')}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Raumbuch
// ---------------------------------------------------------------------------

/**
 * The Raumbuch AND whether it covers the whole model.
 *
 * `truncated` was dropped here, so the chat card printed a
 * Netto-Grundfläche computed over part of a building with none of the
 * warning the model page refuses to show the same number without.
 */
const pickSchedule = (payload: Record<string, unknown>) =>
  payload.schedule
    ? {
        schedule: payload.schedule as BimRoomSchedule,
        truncated: payload.truncated === true,
      }
    : undefined

export interface IfcScheduleCardProps {
  title: string
  modelFile: string | null
  storey: string | null
  note: string | null
  projectId: string | null
}

export function IfcScheduleCard({
  title,
  modelFile,
  storey,
  note,
  projectId,
}: IfcScheduleCardProps): JSX.Element {
  const t = useTranslations('bim')
  const { locale } = useLocale()
  const {
    model,
    isLoading: modelsLoading,
    error: modelsError,
    ambiguous,
    notReady,
  } = useResolvedModel(projectId, modelFile)
  const { data: payload, isLoading, error } = useModelQuery(
    model?.id ?? null,
    { op: 'schedule' },
    pickSchedule
  )
  const schedule = payload?.schedule ?? null

  const storeys = useMemo(() => {
    if (!schedule) return []
    if (!storey) return schedule.storeys
    const needle = storey.toLowerCase()
    return schedule.storeys.filter((entry) => entry.storeyName.toLowerCase() === needle)
  }, [schedule, storey])

  const number = (value: number | null) =>
    value === null ? '—' : value.toLocaleString(locale, { maximumFractionDigits: 2 })

  const download = () => {
    if (!schedule) return
    /*
      `roomScheduleToCsv`, not a second hand-rolled writer.

      This one hard-coded German headers, so an English-locale reader
      downloaded a German file; it abbreviated them differently —
      `NGF`/`BGF` against the model page's `Netto-Grundfläche` /
      `Brutto-Grundfläche` — and left out the Kategorie column and the
      per-storey subtotals entirely. Two files both called "Raumbuch", of the
      same rooms, with different columns and different names for the columns
      they shared. It also wrote `24.5` where the shared writer writes `24,5`,
      which the German-locale Excel this export targets reads as TEXT: the
      downloaded Raumbuch would not sum, which is the one thing anyone
      downloads it for.

      The storey filter is applied to the schedule, so the file is still
      exactly the table on screen.
    */
    const csv = roomScheduleToCsv({ ...schedule, storeys })
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    // `haus-a-raumbuch.csv`, matching the model page. This wrote
    // `raumbuch-haus-a.ifc.csv` — the extension of the source file left in the
    // middle of a CSV's name, and the two exports of the same table sorting
    // apart in a downloads folder.
    anchor.download = `${(model?.filename ?? 'modell').replace(/\.(ifc|ifczip)$/i, '')}-raumbuch.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <CardShell
      title={title}
      icon={Table2}
      action={
        // Not for an empty selection: a CSV of nothing is a file the reader
        // has to open to discover is empty.
        schedule &&
        storeys.length > 0 && (
          <Button type="button" size="sm" variant="ghost" onClick={download}>
            <Download className="size-3.5" aria-hidden="true" />
            CSV
          </Button>
        )
      }
    >
      {!model ? (
        <NoModel isLoading={modelsLoading} error={modelsError} ambiguous={ambiguous} notReady={notReady} />
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error ? (
        <p className="text-sm text-destructive">{t('schedule.failed')}</p>
      ) : !schedule || schedule.totals.rooms === 0 ? (
        // "The query failed" and "this model has no rooms" are different
        // answers, and the model page has always distinguished them. The card
        // rendered the failure sentence for both.
        <p className="text-muted-foreground text-sm">{t('schedule.empty')}</p>
      ) : storeys.length === 0 ? (
        // A storey the card named that this model does not have. Saying so
        // beats a table with headers, no rows and no explanation.
        <p className="text-muted-foreground text-sm">{t('schedule.storeyEmpty', { storey: storey ?? '' })}</p>
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-1 pr-2 font-medium">
                    {t('schedule.room')}
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    {t('schedule.netArea')}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {t('schedule.volume')}
                  </th>
                </tr>
              </thead>
              {storeys.map((entry) => (
                <tbody key={entry.storeyName}>
                  <tr className="border-t">
                    <th scope="rowgroup" colSpan={3} className="pt-2 text-left text-xs font-semibold">
                      {entry.storeyName}
                    </th>
                  </tr>
                  {entry.rooms.map((room) => (
                    <tr key={room.globalId} className="border-t/50">
                      <td className="py-1 pr-2">
                        {projectId ? (
                          <Link
                            href={buildModelHref(projectId, {
                              model: model.filename,
                              storey: entry.storeyName,
                              element: room.globalId,
                            })}
                            className="underline-offset-2 hover:underline"
                          >
                            {room.name}
                          </Link>
                        ) : (
                          room.name
                        )}
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{number(room.netFloorArea)}</td>
                      <td className="py-1 text-right tabular-nums">{number(room.netVolume)}</td>
                    </tr>
                  ))}
                  <tr className="border-t font-medium">
                    <td className="py-1 pr-2">{t('schedule.storeyTotal')}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{number(entry.netFloorArea)}</td>
                    <td className="py-1 text-right tabular-nums">{number(entry.netVolume)}</td>
                  </tr>
                </tbody>
              ))}
              {/*
                Only when the table IS the building. With `storey` set the rows
                are one floor and `schedule.totals` is still the whole model,
                so a row labelled "Gesamt" under a single storey's rooms
                reported the building's Netto-Grundfläche as that floor's —
                the one number in this product that could do real damage, in
                the surface that ends up pasted into an email.
              */}
              {!storey && (
                <tfoot>
                  <tr className="border-t-2 font-semibold">
                    <td className="py-1 pr-2">{t('schedule.total')}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {number(schedule.totals.netFloorArea)} {schedule.units.area}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {number(schedule.totals.netVolume)} {schedule.units.volume}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {payload?.truncated && (
            // Above everything it invalidates. The model page refuses to show
            // these numbers without this sentence; a card in a chat thread is
            // read by the same person about the same building.
            <p className="text-xs text-destructive">{t('schedule.truncated')}</p>
          )}
          {schedule.totals.roomsWithoutArea > 0 && (
            // Stated beside the total, not in a tooltip: a Flächenaufstellung
            // that silently omits four rooms is the failure this whole
            // subsystem exists to prevent.
            <p className="text-xs text-warning">
              {t('schedule.missing', { count: schedule.totals.roomsWithoutArea })}
            </p>
          )}
          {note && <p className="text-sm text-muted-foreground">{note}</p>}
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// One element
// ---------------------------------------------------------------------------

const pickElement = (payload: Record<string, unknown>) =>
  payload.element as BimElementDetail | null | undefined

export interface IfcElementCardProps {
  title: string
  globalId: string
  modelFile: string | null
  note: string | null
  projectId: string | null
}

export function IfcElementCard({
  title,
  globalId,
  modelFile,
  note,
  projectId,
}: IfcElementCardProps): JSX.Element {
  const t = useTranslations('bim')
  const { locale } = useLocale()
  const {
    model,
    isLoading: modelsLoading,
    error: modelsError,
    ambiguous,
    notReady,
  } = useResolvedModel(projectId, modelFile)
  const { data: element, isLoading, error } = useModelQuery(
    model?.id ?? null,
    { op: 'element', globalId },
    pickElement
  )

  return (
    <CardShell
      title={title}
      icon={Boxes}
      action={
        model && projectId ? (
          <Button asChild size="sm" variant="ghost">
            <Link
              href={buildModelHref(projectId, {
                model: model.filename,
                element: globalId,
                storey: element?.storeyName ?? undefined,
                highlights: [{ status: 'info', globalIds: [globalId] }],
              })}
            >
              {t('card.openModel')}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        ) : null
      }
    >
      {!model ? (
        <NoModel isLoading={modelsLoading} error={modelsError} ambiguous={ambiguous} notReady={notReady} />
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error ? (
        <p className="text-sm text-destructive">{t('properties.loadFailed')}</p>
      ) : !element ? (
        <p className="text-sm text-muted-foreground">{t('element.notFound')}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{shortIfcType(element.ifcType)}</Badge>
            {element.storeyName && <Badge variant="outline">{element.storeyName}</Badge>}
            {element.typeName && <span className="text-muted-foreground">{element.typeName}</span>}
          </div>
          {element.materials.length > 0 && (
            <p className="text-muted-foreground">{element.materials.join(' · ')}</p>
          )}
          {Object.entries(element.properties).map(([setName, properties]) => (
            // The set name is a heading over the list, not a term IN it. It
            // used to be the `<dt>` and every property name was a second
            // `<dd>`, so each row arrived as two definitions with no term
            // between them: "Feuerwiderstand" and "REI 90" were read out as an
            // unlabelled pair, which is the whole content of the card.
            <div key={setName} className="space-y-0.5">
              <p className="text-xs font-semibold uppercase text-muted-foreground">{setName}</p>
              <dl className="space-y-0.5">
                {Object.entries(properties).map(([name, value]) => (
                  <div key={name} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{name}</dt>
                    <dd className="font-medium">{formatPropertyValue(value, locale)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          {note && <p className="text-muted-foreground">{note}</p>}
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Prüfbuch
// ---------------------------------------------------------------------------

/**
 * The rule run AND whether it saw the whole model.
 *
 * `truncated` was discarded, so "9 erfüllt · 0 nicht erfüllt" over a capped
 * model was presented in chat as a fact about the building. The model page
 * refuses to print the same counts without `compliance.truncatedModel` above
 * them; the counts do not become safer for being in a card.
 */
const pickCompliance = (payload: Record<string, unknown>) =>
  payload.compliance
    ? {
        rules: payload.compliance as BimRuleResult[],
        truncated: payload.truncated === true,
      }
    : undefined

export interface IfcComplianceCardProps {
  title: string
  modelFile: string | null
  ruleIds: string[]
  note: string | null
  projectId: string | null
}

/**
 * The requirement verdicts, as a card.
 *
 * Carries rule IDS and nothing else — the counts, thresholds and readings are
 * fetched, so an answer cannot state that a requirement is met. `rule_ids` that
 * do not resolve are REPORTED rather than dropped: silently narrowing the list
 * would turn a hallucinated id into a shorter, cleaner-looking Prüfbuch, which
 * is the one direction this card must never fail in.
 */
export function IfcComplianceCard({
  title,
  modelFile,
  ruleIds,
  note,
  projectId,
}: IfcComplianceCardProps): JSX.Element {
  const t = useTranslations('bim')
  const {
    model,
    isLoading: modelsLoading,
    error: modelsError,
    ambiguous,
    notReady,
  } = useResolvedModel(projectId, modelFile)
  // The SAME facts the model page runs the catalogue with. Without them the
  // fire-resistance rules stand down here and produce a verdict on the model
  // page, so the chat and the page disagreed about the same building.
  const facts = useProjectRuleFacts(projectId)
  const request = useMemo(
    () => ({
      op: 'compliance' as const,
      ...(facts.gebaeudeklasse === null ? {} : { gebaeudeklasse: facts.gebaeudeklasse }),
      ...(facts.hauptnutzung === null ? {} : { hauptnutzung: facts.hauptnutzung }),
    }),
    [facts.gebaeudeklasse, facts.hauptnutzung]
  )
  // WAIT for the brief. Without the guard the catalogue runs once with no
  // Gebäudeklasse and again with it, and the first run is both discarded and
  // WRONG — every fire-resistance rule stands down, so for a moment the card
  // contradicts the model page about the same building. It also costs a
  // measured ~1.5 s and ~126 MB of server work per card, thrown away.
  const {
    data: run,
    isLoading: queryLoading,
    error,
  } = useModelQuery(facts.ready ? (model?.id ?? null) : null, request, pickCompliance)
  const rules = run?.rules ?? null
  const isLoading = queryLoading || !facts.ready

  const selected = useMemo(() => {
    if (!rules) return null
    if (ruleIds.length === 0) return rules
    const wanted = new Set(ruleIds)
    return rules.filter((rule) => wanted.has(rule.ruleId))
  }, [rules, ruleIds])

  const unresolved = useMemo(() => {
    if (!rules || ruleIds.length === 0) return 0
    const known = new Set(rules.map((rule) => rule.ruleId))
    return ruleIds.filter((id) => !known.has(id)).length
  }, [rules, ruleIds])

  // Rendered here rather than left to the answer text: the agent is told to
  // repeat the export path, and a model asked to reproduce a URL will
  // eventually reproduce a wrong one. The card composes it from the model it
  // actually resolved.
  const bcfHref = useMemo(() => {
    if (!model || !projectId || !selected || rulesWithOpenWork(selected).length === 0) return null
    const query = new URLSearchParams({ modelId: model.id })
    if (facts.gebaeudeklasse !== null) query.set('gebaeudeklasse', String(facts.gebaeudeklasse))
    if (facts.hauptnutzung !== null) query.set('hauptnutzung', facts.hauptnutzung)
    return `/api/projects/${projectId}/bim/checks/export?${query.toString()}`
  }, [model, projectId, selected, facts.gebaeudeklasse, facts.hauptnutzung])

  return (
    <CardShell
      title={title}
      icon={ShieldCheck}
      action={
        model && projectId ? (
          <div className="flex items-center gap-1">
            {bcfHref && (
              <Button asChild size="sm" variant="ghost">
                <a href={bcfHref} download>
                  <Download className="size-3.5" aria-hidden="true" />
                  {t('compliance.card.export')}
                </a>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <Link href={buildModelHref(projectId, { model: model.filename, tab: 'compliance' })}>
                {t('card.openModel')}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        ) : null
      }
    >
      {!model ? (
        <NoModel isLoading={modelsLoading} error={modelsError} ambiguous={ambiguous} notReady={notReady} />
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error ? (
        <p className="text-sm text-destructive">{t('compliance.failed')}</p>
      ) : (
        <div className="space-y-2">
          {/* Above the verdicts, because it is what they are worth. */}
          {run?.truncated && (
            <p className="text-xs text-destructive">{t('compliance.truncatedModel')}</p>
          )}
          {unresolved > 0 && (
            <p className="text-xs text-warning">
              {unresolved === 1
                ? t('compliance.card.unresolvedOne')
                : t('compliance.card.unresolved', { count: unresolved })}
            </p>
          )}
          {selected?.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('compliance.card.none')}</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {(selected ?? []).map((rule) => (
                <li key={rule.ruleId} className="space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{rule.titleDe}</span>
                    <span className="text-xs text-muted-foreground">
                      {rule.richtlinie}, Punkt {rule.clause}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {rule.applicable
                      ? t('compliance.counts', {
                          passed: rule.passed,
                          failed: rule.failed,
                          undecidable: rule.undecidable,
                        })
                      : `${t('compliance.notApplicable')}: ${rule.notApplicableReason ?? ''}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {/* Non-negotiable on a surface that leaves the page in a screenshot. */}
          <p className="text-xs text-muted-foreground">{t('compliance.disclaimer')}</p>
        </div>
      )}
    </CardShell>
  )
}

// ---------------------------------------------------------------------------
// Revision diff
// ---------------------------------------------------------------------------

const pickComparison = (payload: Record<string, unknown>) =>
  payload.comparison as BimComparison | undefined

/** Rows shown per group before the badge count speaks for the rest. */
const DIFF_ROWS = 6

interface DiffEntry {
  globalId: string
  ifcType: string
  name: string | null
  storeyName?: string | null
  changes?: Array<{ field: string; before: unknown; after: unknown }>
}

/**
 * One side of a revision delta, as rows that open the element.
 *
 * Renders nothing when the group is empty, so a revision that only added
 * something does not carry two empty headings.
 */
function DiffGroup({
  label,
  entries,
  status,
  projectId,
  filename,
  total,
}: {
  label: string
  entries: readonly DiffEntry[]
  status: 'info' | 'fail' | 'warning'
  projectId: string | null
  /** The revision this group's elements exist in. */
  filename: string
  /**
   * How many elements the comparison actually found.
   *
   * `entries` is capped at `MAX_COMPARISON_ROWS` by `compare.ts`, so its
   * length is a property of the cap rather than of the revision. "… 492
   * weitere" computed from it is a remainder of a cap presented as a count of
   * the building.
   */
  total: number
}): JSX.Element | null {
  const t = useTranslations('bim')
  if (entries.length === 0) return null

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="space-y-1">
        {entries.slice(0, DIFF_ROWS).map((entry) => {
          const caption = `${shortIfcType(entry.ifcType)} · ${entry.name ?? entry.globalId}`
          return (
            <li key={entry.globalId}>
              <p>
                {projectId ? (
                  <Link
                    href={buildModelHref(projectId, {
                      model: filename,
                      element: entry.globalId,
                      highlights: [{ status, globalIds: [entry.globalId] }],
                    })}
                    className="underline-offset-2 hover:underline"
                  >
                    {caption}
                  </Link>
                ) : (
                  caption
                )}
                {entry.storeyName && (
                  <span className="text-xs text-muted-foreground"> · {entry.storeyName}</span>
                )}
              </p>
              {entry.changes && entry.changes.length > 0 && (
                <ul className="ml-3 text-xs text-muted-foreground">
                  {entry.changes.slice(0, 3).map((change) => (
                    <li key={change.field}>
                      {change.field}: {String(change.before ?? '—')} → {String(change.after ?? '—')}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      {total > DIFF_ROWS && (
        <p className="text-xs text-muted-foreground">
          {t('compare.more', { count: total - DIFF_ROWS })}
        </p>
      )}
    </div>
  )
}

export interface IfcDiffCardProps {
  title: string
  baseModelFile: string
  modelFile: string | null
  note: string | null
  projectId: string | null
}

export function IfcDiffCard({
  title,
  baseModelFile,
  modelFile,
  note,
  projectId,
}: IfcDiffCardProps): JSX.Element {
  const t = useTranslations('bim')
  const {
    model,
    models,
    isLoading: modelsLoading,
    error: modelsError,
    ambiguous,
    notReady,
  } = useResolvedModel(projectId, modelFile)
  // The base revision resolves by the SAME rule as the current one. It used to
  // take the first substring hit, which is the bug the sibling resolver exists
  // to prevent — and worse here, because a diff names two buildings: `haus-a`
  // against a project holding `haus-a.ifc` and `haus-a-alt.ifc` reported the
  // additions and deletions of an arbitrary one of them as a revision history.
  const { model: baseModel, ambiguous: baseAmbiguous } = useMemo(
    () => resolveModelByFilename(models, baseModelFile),
    [models, baseModelFile]
  )

  const { data: comparison, isLoading, error } = useModelQuery(
    model && baseModel && model.id !== baseModel.id ? model.id : null,
    baseModel ? { op: 'compare', baseModelId: baseModel.id, limit: 20_000 } : null,
    pickComparison
  )

  return (
    <CardShell title={title} icon={GitCompare}>
      {!model || !baseModel ? (
        <NoModel
          isLoading={modelsLoading}
          error={modelsError}
          ambiguous={ambiguous || baseAmbiguous}
          notReady={notReady}
        />
      ) : model.id === baseModel.id ? (
        // Both names resolved to the same revision — the ordinary case of the
        // agent naming the current model as `base_model_file`, or a substring
        // matching both. The query is deliberately not sent, so the branch
        // below saw `comparison: null` and reported a broken comparison for
        // something that simply has nothing to compare.
        <p className="text-muted-foreground text-sm">{t('compare.sameRevision')}</p>
      ) : isLoading ? (
        <Spinner className="size-4" />
      ) : error || !comparison ? (
        <p className="text-sm text-destructive">{t('compare.failed')}</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            {baseModel.filename} <ArrowRight className="inline size-3" aria-hidden="true" />{' '}
            {model.filename}
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            {/*
              `counts`, not the array lengths. `compare.ts` slices each list to
              `MAX_COMPARISON_ROWS = 500` and keeps the real figures on
              `counts` — the model page reads them, this card read the capped
              arrays. A revision that added 1 300 elements was reported to an
              architect as "Neu 500", on the surface that ends up in a
              screenshot.
            */}
            <Badge variant="success">
              {t('compare.added')} {comparison.counts.added}
            </Badge>
            <Badge variant="destructive">
              {t('compare.removed')} {comparison.counts.removed}
            </Badge>
            <Badge variant="warning">
              {t('compare.changed')} {comparison.counts.changed}
            </Badge>
            <Badge variant="secondary">
              {t('compare.unchanged')} {comparison.unchangedCount}
            </Badge>
          </div>
          {comparison.truncated && <p className="text-xs text-warning">{t('compare.truncated')}</p>}
          {/* Added and removed used to be counts and nothing else — the card
              said "Added 1" and gave no way to find out what. A delta you
              cannot open is a number, not an answer. Removed elements link
              into the BASE revision: they have no GlobalId in the new one, so
              a link into it would select nothing. */}
          <DiffGroup
            label={t('compare.added')}
            entries={comparison.added}
            total={comparison.counts.added}
            status="info"
            projectId={projectId}
            filename={model.filename}
          />
          <DiffGroup
            label={t('compare.removed')}
            entries={comparison.removed}
            total={comparison.counts.removed}
            status="fail"
            projectId={projectId}
            filename={baseModel.filename}
          />
          <DiffGroup
            label={t('compare.changed')}
            entries={comparison.changed}
            total={comparison.counts.changed}
            status="warning"
            projectId={projectId}
            filename={model.filename}
          />
          {note && <p className="text-muted-foreground">{note}</p>}
        </div>
      )}
    </CardShell>
  )
}
