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

import { useState } from 'react'
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
}

/** How many rows each bucket shows before the count speaks for the rest. */
const VISIBLE_ROWS = 8

export function IfcModelCompare({ modelId, candidates }: IfcModelCompareProps): JSX.Element {
  const t = useTranslations('bim')
  const [baseModelId, setBaseModelId] = useState<string>(candidates[0]?.id ?? '')
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [comparison, setComparison] = useState<BimComparison | null>(null)

  const run = async () => {
    if (!baseModelId) return
    setState('loading')
    setComparison(null)
    try {
      const response = await fetch(`/api/bim/models/${modelId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'compare', baseModelId, limit: 20_000 }),
      })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as { comparison?: BimComparison }
      setComparison(body.comparison ?? null)
      setState('idle')
    } catch {
      setState('error')
    }
  }

  return (
    <section aria-labelledby="bim-compare-heading" className="space-y-2">
      <h2 id="bim-compare-heading" className="flex items-center gap-2 text-sm font-semibold">
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
          <Button type="button" size="sm" variant="secondary" onClick={run} disabled={state === 'loading'}>
            {state === 'loading' ? <Spinner className="size-3" /> : null}
            {state === 'loading' ? t('compare.running') : t('compare.run')}
          </Button>
        </div>
      )}

      {state === 'error' && <p className="text-sm text-destructive">{t('compare.failed')}</p>}

      {comparison && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="success">
              {t('compare.added')} {comparison.added.length}
            </Badge>
            <Badge variant="destructive">
              {t('compare.removed')} {comparison.removed.length}
            </Badge>
            <Badge variant="warning">
              {t('compare.changed')} {comparison.changed.length}
            </Badge>
            <Badge variant="secondary">
              {t('compare.unchanged')} {comparison.unchangedCount}
            </Badge>
          </div>

          {comparison.truncated && (
            <p className="rounded-md bg-warning-subtle p-2 text-xs text-warning">
              {t('compare.truncated')}
            </p>
          )}

          {comparison.added.length === 0 &&
          comparison.removed.length === 0 &&
          comparison.changed.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('compare.empty')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {comparison.added.slice(0, VISIBLE_ROWS).map((entry) => (
                <li key={`added-${entry.globalId}`} className="flex gap-2">
                  <span aria-hidden="true" className="text-success">
                    +
                  </span>
                  <span className="truncate">
                    {shortIfcType(entry.ifcType)} · {entry.name ?? entry.globalId}
                  </span>
                </li>
              ))}
              {comparison.removed.slice(0, VISIBLE_ROWS).map((entry) => (
                <li key={`removed-${entry.globalId}`} className="flex gap-2">
                  <span aria-hidden="true" className="text-destructive">
                    −
                  </span>
                  <span className="truncate">
                    {shortIfcType(entry.ifcType)} · {entry.name ?? entry.globalId}
                  </span>
                </li>
              ))}
              {comparison.changed.slice(0, VISIBLE_ROWS).map((entry) => (
                <li key={`changed-${entry.globalId}`} className="space-y-0.5">
                  <p className="flex gap-2">
                    <span aria-hidden="true" className="text-warning">
                      ~
                    </span>
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
