'use client'

/**
 * Revision comparison, as a panel on the model page.
 *
 * The question this answers — "what changed since the version the authority
 * already has" — is the one an architect asks at every resubmission, and it is
 * the one thing in the product that is strictly impossible on documents: two
 * plan sets redrawn from a changed model look different everywhere and
 * identical where it matters, while two IFC files carry the same GlobalId on
 * the same wall and can simply be subtracted.
 *
 * The comparison runs on demand, not on load: it reads both models' element
 * rows in full, which is worth doing when asked and not worth doing because
 * somebody opened the page.
 */

import { useEffect, useRef, useState } from 'react'
import { ArrowRight, GitCompare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { BimComparison } from '@/lib/bim/compare'
import type { BimModelHeaderView } from '../hooks/use-bim-model'
import { shortIfcType } from '../lib/model-index'

export interface IfcModelCompareProps {
  /** The model on screen — treated as the NEWER revision. */
  modelId: string
  /** Every other ready model in scope, offered as the older revision. */
  candidates: readonly BimModelHeaderView[]
  /**
   * A comparison the timeline asked for: `{ baseModelId, at }`. The panel
   * selects that base and runs immediately.
   *
   * `at` is a monotonically increasing token rather than a boolean, because
   * asking for the SAME comparison twice ("compare with previous", read it,
   * click it again) has to re-run — a changed base id alone would not.
   */
  requested?: { baseModelId: string; at: number } | null
}

/** How many rows each bucket shows before the count speaks for the rest. */
const VISIBLE_ROWS = 8

export function IfcModelCompare({
  modelId,
  candidates,
  requested = null,
}: IfcModelCompareProps): JSX.Element {
  const t = useTranslations('bim')
  const [baseModelId, setBaseModelId] = useState<string>(candidates[0]?.id ?? '')
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  /**
   * The result, and the revision it is a result ABOUT.
   *
   * Carried together on purpose. The base is a control the reader can change
   * after a run, so reading the caption off `baseModelId` would relabel a
   * finished comparison every time the select moves — "+17 Bauteile" against
   * one revision, presented as the difference to another, on the screen an
   * office resubmits from.
   */
  const [comparison, setComparison] = useState<
    { result: BimComparison; baseModelId: string } | null
  >(null)
  const heading = useRef<HTMLHeadingElement>(null)

  /**
   * Which run the panel is showing.
   *
   * Both entry points can fire while a request is out — the button is only
   * disabled while `loading`, and the timeline can request a comparison at any
   * moment — and this request reads two full element sets, so the slow one is
   * routinely the one started first. Without a ticket the later answer is
   * overwritten by the earlier, and the panel settles on a comparison the
   * reader did not ask for last.
   */
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current += 1
    },
    []
  )

  const run = async (base: string = baseModelId) => {
    if (!base) return
    generation.current += 1
    const ticket = generation.current
    setState('loading')
    setComparison(null)
    try {
      const response = await fetch(`/api/bim/models/${modelId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'compare', baseModelId: base, limit: 20_000 }),
      })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as { comparison?: BimComparison }
      if (generation.current !== ticket) return
      setComparison(body.comparison ? { result: body.comparison, baseModelId: base } : null)
      setState('idle')
    } catch {
      if (generation.current !== ticket) return
      setState('error')
    }
  }

  /** What the result on screen was actually measured against. */
  const ranAgainst = comparison
    ? (candidates.find((candidate) => candidate.id === comparison.baseModelId)?.filename ?? null)
    : null

  // A comparison requested from the timeline: select the base, run it, and
  // bring the panel into view — the button that asked for it is elsewhere on
  // the page, and results that appear off-screen read as a button that did
  // nothing.
  useEffect(() => {
    if (!requested?.baseModelId) return
    setBaseModelId(requested.baseModelId)
    void run(requested.baseModelId)
    heading.current?.scrollIntoView({ block: 'nearest' })
    // And focus, not only scroll. The comment above is about a button that
    // reads as having done nothing — which is exactly what the timeline's
    // "mit Vorgänger vergleichen" reads as to a reader who cannot see the
    // panel scroll into view somewhere else on the page.
    heading.current?.focus()
    // Keyed on the request token: re-running the same comparison is a valid
    // thing to ask for, and `run` is redefined every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested?.baseModelId, requested?.at])

  return (
    <section aria-labelledby="bim-compare-heading" className="space-y-2">
      <h2
        ref={heading}
        // Programmatically focusable, not a Tab stop — see the request effect.
        tabIndex={-1}
        id="bim-compare-heading"
        className="flex items-center gap-2 text-sm font-semibold focus-visible:outline-none"
      >
        <GitCompare className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('compare.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('compare.description')}</p>

      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('compare.none')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="bim-compare-base">
            {t('compare.against')}
          </label>
          <select
            id="bim-compare-base"
            value={baseModelId}
            onChange={(event) => setBaseModelId(event.target.value)}
            className="h-8 max-w-64 rounded-md border bg-background px-2 text-sm"
          >
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.filename}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void run()}
            disabled={state === 'loading'}
          >
            {state === 'loading' ? <Spinner className="size-3" /> : null}
            {state === 'loading' ? t('compare.running') : t('compare.run')}
          </Button>
        </div>
      )}

      {state === 'error' && <p className="text-sm text-destructive">{t('compare.failed')}</p>}

      {comparison && (
        <div className="space-y-3">
          {/* Which two files these numbers are the difference between. The
              select above is a control, not a caption: it moves freely after a
              run, and four counts with no stated subject take their meaning
              from whatever it happens to be pointing at. */}
          {ranAgainst && (
            <p className="text-xs text-muted-foreground">
              {t('compare.ranAgainst', { model: ranAgainst })}
            </p>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="success">
              {t('compare.added')} {comparison.result.counts.added}
            </Badge>
            <Badge variant="destructive">
              {t('compare.removed')} {comparison.result.counts.removed}
            </Badge>
            <Badge variant="warning">
              {t('compare.changed')} {comparison.result.counts.changed}
            </Badge>
            <Badge variant="secondary">
              {t('compare.unchanged')} {comparison.result.unchangedCount}
            </Badge>
          </div>

          {comparison.result.truncated && (
            <p className="rounded-md bg-warning-subtle p-2 text-xs text-warning">
              {t('compare.truncated')}
            </p>
          )}

          {comparison.result.added.length === 0 &&
          comparison.result.removed.length === 0 &&
          comparison.result.changed.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('compare.empty')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {/*
                The `+ − ~` glyphs are `aria-hidden`, and they were the ONLY
                thing separating an added element from a deleted one: the three
                buckets are concatenated into one list, so "Wall · Wand-3" read
                identically whether that wall appeared or vanished — on the
                panel an office resubmits from. An `sr-only` word beside each
                glyph carries what the colour and the symbol carry visually,
                and changes nothing on screen.
              */}
              {comparison.result.added.slice(0, VISIBLE_ROWS).map((entry) => (
                <li key={`added-${entry.globalId}`} className="flex gap-2">
                  <span aria-hidden="true" className="text-success">
                    +
                  </span>
                  <span className="sr-only">{t('compare.added')}</span>
                  <span className="truncate">
                    {shortIfcType(entry.ifcType)} · {entry.name ?? entry.globalId}
                  </span>
                </li>
              ))}
              {comparison.result.removed.slice(0, VISIBLE_ROWS).map((entry) => (
                <li key={`removed-${entry.globalId}`} className="flex gap-2">
                  <span aria-hidden="true" className="text-destructive">
                    −
                  </span>
                  <span className="sr-only">{t('compare.removed')}</span>
                  <span className="truncate">
                    {shortIfcType(entry.ifcType)} · {entry.name ?? entry.globalId}
                  </span>
                </li>
              ))}
              {comparison.result.changed.slice(0, VISIBLE_ROWS).map((entry) => (
                <li key={`changed-${entry.globalId}`} className="space-y-0.5">
                  <p className="flex gap-2">
                    <span aria-hidden="true" className="text-warning">
                      ~
                    </span>
                    <span className="sr-only">{t('compare.changed')}</span>
                    <span className="truncate">
                      {shortIfcType(entry.ifcType)} · {entry.name ?? entry.globalId}
                    </span>
                  </p>
                  <ul className="ml-5 space-y-0.5 text-xs text-muted-foreground">
                    {entry.changes.slice(0, 4).map((change) => (
                      <li key={change.field} className="flex flex-wrap items-center gap-1">
                        <span className="font-medium">{change.field}</span>
                        <span>{String(change.before ?? '—')}</span>
                        <ArrowRight className="size-3" aria-hidden="true" />
                        <span>{String(change.after ?? '—')}</span>
                        {change.delta !== null && (
                          <span className="tabular-nums">
                            ({change.delta > 0 ? '+' : ''}
                            {change.delta})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
