'use client'

/**
 * Platform maintenance — the orphaned-vector sweep.
 *
 * This is the only control in the product that deletes from the *shared* vector
 * store, across every organization at once, and the operator who reaches for it
 * is by definition already confused: retrieval is citing something the catalog
 * says does not exist. So the surface has two jobs beyond "run it".
 *
 *  1. Explain itself. What reconciling does, when you would need it, and what it
 *     provably never touches are rendered as copy, because that knowledge
 *     otherwise lives in one engineer's head and the person clicking is not
 *     that engineer.
 *  2. Leave evidence. The run's counts are the only record that it happened —
 *     there is no history endpoint — so they are rendered as a table that
 *     persists, not a toast that evaporates before it can be read or screenshot.
 *
 * The API contract (`POST /api/platform/maintenance/reconcile-vectors`) is
 * unchanged: no body, and a `VectorReconcileResult` back.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Brush, CheckCircle2, ShieldCheck } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'

/** Mirrors `VectorReconcileResult` in `@/lib/platform/vector-reconcile`. */
interface ReconcileResult {
  collectionsScanned: number
  orphansFound: number
  orphansDeleted: number
  failures: { collectionName: string; error: string }[]
}

/** The wire shape: `failures` is normalised to an array on receipt. */
type ReconcileResponse = Omit<ReconcileResult, 'failures'> & Partial<Pick<ReconcileResult, 'failures'>>

/**
 * A sweep that has not answered in this long is not going to. The confirm
 * dialog refuses to close mid-flight (by design — the run is destructive), so
 * without a ceiling a stalled request leaves both dialog buttons and the
 * trigger dead with no escape short of a reload. Aborting only releases the
 * UI; the server-side sweep is server-owned and may still complete, which is
 * what the panel's copy already tells the operator.
 */
const RECONCILE_TIMEOUT_MS = 120_000

export interface VectorMaintenanceProps {
  /**
   * Seeds the "last run" panel. Nothing in production passes this — no endpoint
   * records past runs — but the dev preview and tests need a way to show the
   * result state without firing a destructive request.
   */
  initialResult?: ReconcileResult | null
}

export function VectorMaintenance({ initialResult = null }: VectorMaintenanceProps): JSX.Element {
  const t = useTranslations('platform')
  const [isOpen, setIsOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastResult, setLastResult] = useState<ReconcileResult | null>(initialResult)
  const [hasFailed, setHasFailed] = useState(false)

  const handleReconcile = useCallback(async () => {
    setIsRunning(true)
    setHasFailed(false)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS)
    try {
      const res = await fetch('/api/platform/maintenance/reconcile-vectors', {
        method: 'POST',
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Reconcile failed (${res.status})`)
      const body = (await res.json()) as ReconcileResponse
      // Normalise `failures` on the way in so every read site below can treat it
      // as an array; the route always sends one, but this panel is the last
      // thing that should throw while reporting a destructive run.
      const result: ReconcileResult = { ...body, failures: body.failures ?? [] }
      setLastResult(result)

      // The toast is the "it finished" nudge for an operator who has looked
      // away; the table below is the record. Both, not one.
      toast.success(
        result.orphansDeleted > 0
          ? t('vectorMaintenance.outcomeRemoved', {
              chunks: result.orphansDeleted,
              collections: result.collectionsScanned,
            })
          : t('vectorMaintenance.outcomeClean'),
      )
      if (result.failures.length > 0) {
        toast.warning(t('vectorMaintenance.failuresTitle', { count: result.failures.length }))
      }
    } catch {
      setHasFailed(true)
      toast.error(t('vectorMaintenance.failed'))
    } finally {
      clearTimeout(timeout)
      setIsRunning(false)
      setIsOpen(false)
    }
  }, [t])

  const measures = lastResult
    ? [
        {
          key: 'collections',
          label: t('vectorMaintenance.measureCollections'),
          hint: t('vectorMaintenance.measureCollectionsHint'),
          value: lastResult.collectionsScanned,
        },
        {
          key: 'found',
          label: t('vectorMaintenance.measureFound'),
          hint: t('vectorMaintenance.measureFoundHint'),
          value: lastResult.orphansFound,
        },
        {
          key: 'deleted',
          label: t('vectorMaintenance.measureDeleted'),
          hint: t('vectorMaintenance.measureDeletedHint'),
          value: lastResult.orphansDeleted,
        },
      ]
    : []

  return (
    <>
      <SectionCard
        title={t('vectorMaintenance.title')}
        description={t('vectorMaintenance.description')}
        testId="vector-maintenance"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(true)}
            disabled={isRunning}
            data-testid="reconcile-trigger"
          >
            {/* aria-hidden: the button's own label already reads "Reconciling…",
                so the spinner's status text would only say it twice. */}
            {isRunning ? (
              <Spinner className="size-3.5" aria-hidden />
            ) : (
              <Brush className="size-3.5" aria-hidden />
            )}
            {isRunning ? t('vectorMaintenance.running') : t('vectorMaintenance.run')}
          </Button>
        }
      >
        <div className="flex flex-col gap-6">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
            {(
              [
                ['how', t('vectorMaintenance.howTitle'), t('vectorMaintenance.howBody')],
                ['when', t('vectorMaintenance.whenTitle'), t('vectorMaintenance.whenBody')],
                ['scope', t('vectorMaintenance.scopeTitle'), t('vectorMaintenance.scopeBody')],
              ] as const
            ).map(([key, term, body]) => (
              <div key={key}>
                {/* SectionLabel renders a span: heading content is not allowed
                    inside <dt>. */}
                <dt>
                  <SectionLabel>{term}</SectionLabel>
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <SectionLabel as="h3">{t('vectorMaintenance.lastRunTitle')}</SectionLabel>
              <span className="text-xs text-muted-foreground">{t('vectorMaintenance.lastRunHint')}</span>
            </div>

            {hasFailed ? (
              <Alert variant="destructive" data-testid="reconcile-error">
                <AlertTriangle aria-hidden />
                <AlertTitle>{t('vectorMaintenance.failed')}</AlertTitle>
                <AlertDescription>{t('vectorMaintenance.failedHint')}</AlertDescription>
              </Alert>
            ) : null}

            {lastResult ? (
              <div className="flex flex-col gap-3" data-testid="reconcile-result">
                <Alert variant={lastResult.orphansDeleted > 0 ? 'info' : 'success'}>
                  <CheckCircle2 aria-hidden />
                  <AlertTitle>
                    {lastResult.orphansDeleted > 0
                      ? t('vectorMaintenance.outcomeRemoved', {
                          chunks: lastResult.orphansDeleted,
                          collections: lastResult.collectionsScanned,
                        })
                      : t('vectorMaintenance.outcomeClean')}
                  </AlertTitle>
                </Alert>

                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('vectorMaintenance.colMeasure')}</TableHead>
                        <TableHead className="text-right">{t('vectorMaintenance.colCount')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {measures.map((measure) => (
                        <TableRow key={measure.key}>
                          <TableCell>
                            <span className="block text-sm font-medium">{measure.label}</span>
                            <span className="block text-xs text-muted-foreground">{measure.hint}</span>
                          </TableCell>
                          <TableCell className="text-right align-top text-sm font-semibold tabular-nums">
                            {measure.value}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* Failures used to be a bare count in a toast. A collection the
                    sweep could not reach is the one thing an operator has to act
                    on, so it is named. */}
                {lastResult.failures.length > 0 ? (
                  <div className="flex flex-col gap-2" data-testid="reconcile-failures">
                    <Alert variant="warning">
                      <AlertTriangle aria-hidden />
                      <AlertTitle>
                        {t('vectorMaintenance.failuresTitle', { count: lastResult.failures.length })}
                      </AlertTitle>
                      <AlertDescription>{t('vectorMaintenance.failuresHint')}</AlertDescription>
                    </Alert>
                    <div className="rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('vectorMaintenance.colCollection')}</TableHead>
                            <TableHead>{t('vectorMaintenance.colError')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {/* A collection can fail twice in one sweep (listing,
                              then deleting), so the name alone is not a key. */}
                          {lastResult.failures.map((failure, index) => (
                            <TableRow key={`${failure.collectionName}-${index}`}>
                              <TableCell className="font-medium break-all">{failure.collectionName}</TableCell>
                              <TableCell className="text-muted-foreground">{failure.error}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : hasFailed ? null : (
              <EmptyState
                variant="bare"
                icon={ShieldCheck}
                title={t('vectorMaintenance.neverRunTitle')}
                description={t('vectorMaintenance.neverRunBody')}
                data-testid="reconcile-never-run"
              />
            )}
          </div>
        </div>
      </SectionCard>

      {/*
        ConfirmDialog, not TypeToConfirmDialog.
        Type-to-confirm earns its friction when the operator could be deleting
        the WRONG named object — you type the project name to prove you read it.
        Here there is no name to type: the target is "whatever the catalog no
        longer knows about", chosen by the server, and typing a made-up token
        would be ceremony that proves nothing. What the operator actually needs
        to weigh is scope and reversibility, so those get the destructive tone
        plus an explicit warning inside the dialog, and the run stays one
        deliberate, fully-informed click.
      */}
      <ConfirmDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        title={t('vectorMaintenance.confirmTitle')}
        description={t('vectorMaintenance.confirmDescription')}
        confirmLabel={t('vectorMaintenance.confirmCta')}
        cancelLabel={t('vectorMaintenance.cancel')}
        tone="destructive"
        onConfirm={handleReconcile}
        // Owning `pending` keeps the dialog open — and both buttons dead — for
        // the whole sweep, so it cannot be double-fired against the store.
        pending={isRunning}
        confirmTestId="reconcile-confirm"
      >
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <AlertDescription>{t('vectorMaintenance.confirmWarning')}</AlertDescription>
        </Alert>
      </ConfirmDialog>
    </>
  )
}
