'use client'

/**
 * One platform maintenance action: a cross-organization, irreversible button
 * that explains itself, asks before it fires and leaves its counts on screen.
 *
 * The orphaned-vector sweep and the deep-research kill switch were two
 * near-copies of this shape, and they had already drifted: only one named its
 * failures under a summary, both kept showing the previous run's counts under
 * a fresh failure. This organism is that shape once. A caller supplies the
 * endpoint, the copy and three readers over its result type (the outcome line,
 * the measures, the failures); everything else, from the abortable request to
 * the read-only gate, is decided here.
 *
 * The counts are the only record a press leaves in the UI: there is no history
 * endpoint, so they live in component state and are gone on reload. The copy
 * says so in the "last run" hint.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Lock, ShieldCheck, type LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Separator } from '@/components/ui/separator'
import { StatCardIcon } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { usePlatformCan } from '@/features/platform/platform-access'
import { useLocale } from '@/i18n'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'

export interface MaintenanceMeasure {
  key: string
  label: string
  hint: string
  value: number
}

export interface MaintenanceFailure {
  /** What could not be handled: a collection name, a job id. */
  id: string
  error: string
}

export interface MaintenanceOutcome {
  title: string
  /** True when the run changed something; picks the info over the success tone. */
  changed: boolean
  detail?: string
}

export interface MaintenanceActionCopy {
  title: string
  description: string
  run: string
  running: string
  /** The "what / when / what it costs" terms, in reading order. */
  explainers: readonly { key: string; term: string; body: string }[]
  lastRunTitle: string
  lastRunHint: string
  neverRunTitle: string
  neverRunBody: string
  confirmTitle: string
  confirmDescription: string
  confirmWarning: string
  confirmCta: string
  cancel: string
  failed: string
  failedHint: string
  colMeasure: string
  colCount: string
  failuresTitle: (count: number) => string
  failuresHint: string
  colFailureId: string
  colFailureError: string
  /** Shown beside the disabled trigger for a viewer who cannot run it. */
  readOnly: string
}

export interface MaintenanceActionCardProps<R> {
  copy: MaintenanceActionCopy
  icon: LucideIcon
  /** `danger` paints the icon well and the trigger in the destructive tokens. */
  tone?: 'default' | 'danger'
  endpoint: string
  /**
   * The confirm dialog refuses to close mid-flight, so a stalled request would
   * leave it locked. Past this the request is aborted to release the UI; the
   * work itself is server-owned and may still complete, which `failedHint`
   * must say.
   */
  timeoutMs: number
  /** Normalise the response body; a BFF older than the panel may omit fields. */
  parse: (body: unknown) => R
  outcome: (result: R) => MaintenanceOutcome
  measures: (result: R) => MaintenanceMeasure[]
  failures: (result: R) => MaintenanceFailure[]
  /** Seeds the last-run panel. Only the dev preview and tests pass this. */
  initialResult?: R | null
  /** Card test id. */
  testId: string
  /** Prefix for the inner test ids: `-trigger`, `-confirm`, `-result`, `-failures`, `-error`, `-never-run`. */
  idPrefix: string
}

export function MaintenanceActionCard<R>({
  copy,
  icon: Icon,
  tone = 'default',
  endpoint,
  timeoutMs,
  parse,
  outcome,
  measures,
  failures,
  initialResult = null,
  testId,
  idPrefix,
}: MaintenanceActionCardProps<R>): JSX.Element {
  const { locale } = useLocale()
  const canRun = usePlatformCan(PLATFORM_PERMISSIONS.settingsManage)
  const [isOpen, setIsOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastResult, setLastResult] = useState<R | null>(initialResult)
  const [hasFailed, setHasFailed] = useState(false)
  const controllerRef = useRef<AbortController | null>(null)

  // Leaving the page releases the request; the server finishes on its own.
  useEffect(() => () => controllerRef.current?.abort(), [])

  const handleRun = useCallback(async () => {
    setIsRunning(true)
    setHasFailed(false)
    const controller = new AbortController()
    controllerRef.current = controller
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(endpoint, { method: 'POST', signal: controller.signal })
      if (!res.ok) throw new Error(`${endpoint} answered ${res.status}`)
      const result = parse(await res.json())
      setLastResult(result)
      // The toast is the nudge for an operator who looked away; the table
      // below is the record.
      toast.success(outcome(result).title)
      const failed = failures(result)
      if (failed.length > 0) toast.warning(copy.failuresTitle(failed.length))
    } catch {
      // A failed press must not leave the previous run's counts standing under
      // the error, where they read as this press's result.
      setLastResult(null)
      setHasFailed(true)
      toast.error(copy.failed)
    } finally {
      clearTimeout(timeout)
      controllerRef.current = null
      setIsRunning(false)
      setIsOpen(false)
    }
  }, [copy, endpoint, failures, outcome, parse, timeoutMs])

  const danger = tone === 'danger'
  const resultOutcome = lastResult ? outcome(lastResult) : null
  const resultMeasures = lastResult ? measures(lastResult) : []
  const resultFailures = lastResult ? failures(lastResult) : []
  const formatCount = (value: number): string => value.toLocaleString(locale)

  return (
    <>
      <Card data-testid={testId}>
        <CardHeader>
          <div className="flex min-w-0 items-start gap-3">
            <StatCardIcon icon={Icon} tone={danger ? 'destructive' : 'muted'} />
            <div className="min-w-0 space-y-1.5">
              <CardTitle role="heading" aria-level={2} className="leading-snug">
                {copy.title}
              </CardTitle>
              <CardDescription className="text-pretty">{copy.description}</CardDescription>
            </div>
          </div>
          <CardAction className="flex flex-col items-start gap-1.5 sm:items-end">
            <Button
              variant={danger ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => setIsOpen(true)}
              disabled={isRunning || !canRun}
              loading={isRunning}
              data-testid={`${idPrefix}-trigger`}
            >
              {isRunning ? null : <Icon className="size-3.5" aria-hidden />}
              {isRunning ? copy.running : copy.run}
            </Button>
            {canRun ? null : (
              <p
                className="text-muted-foreground flex items-center gap-1.5 text-xs"
                data-testid={`${idPrefix}-read-only`}
              >
                <Lock className="size-3" aria-hidden />
                {copy.readOnly}
              </p>
            )}
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <dl className="flex flex-col gap-4">
            {copy.explainers.map(({ key, term, body }) => (
              <div key={key} className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6">
                {/* SectionLabel renders a span: heading content is not allowed in <dt>. */}
                <dt className="sm:pt-0.5">
                  <SectionLabel>{term}</SectionLabel>
                </dt>
                <dd className="text-muted-foreground max-w-prose text-pretty text-sm leading-relaxed">
                  {body}
                </dd>
              </div>
            ))}
          </dl>

          <Separator />

          <section className="flex flex-col gap-3" aria-label={copy.lastRunTitle}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <SectionLabel as="h3">{copy.lastRunTitle}</SectionLabel>
              <span className="text-muted-foreground text-xs">{copy.lastRunHint}</span>
            </div>

            {hasFailed ? (
              <Alert variant="destructive" data-testid={`${idPrefix}-error`}>
                <AlertTriangle aria-hidden />
                <AlertTitle>{copy.failed}</AlertTitle>
                <AlertDescription>{copy.failedHint}</AlertDescription>
              </Alert>
            ) : null}

            {lastResult && resultOutcome ? (
              <div className="flex flex-col gap-3" data-testid={`${idPrefix}-result`}>
                <Alert variant={resultOutcome.changed ? 'info' : 'success'}>
                  <CheckCircle2 aria-hidden />
                  <AlertTitle className="line-clamp-none">{resultOutcome.title}</AlertTitle>
                  {resultOutcome.detail ? (
                    <AlertDescription>{resultOutcome.detail}</AlertDescription>
                  ) : null}
                </Alert>

                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{copy.colMeasure}</TableHead>
                        <TableHead className="text-right">{copy.colCount}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resultMeasures.map((measure) => (
                        <TableRow key={measure.key}>
                          <TableCell className="whitespace-normal">
                            <span className="block text-sm font-medium">{measure.label}</span>
                            <span className="text-muted-foreground block text-xs">
                              {measure.hint}
                            </span>
                          </TableCell>
                          <TableCell className="text-right align-top text-sm font-semibold tabular-nums">
                            {formatCount(measure.value)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {/* What could not be handled is the one thing the operator has to
                    act on, so it is named under a summary, not just counted. */}
                {resultFailures.length > 0 ? (
                  <div className="flex flex-col gap-3" data-testid={`${idPrefix}-failures`}>
                    <Alert variant="warning">
                      <AlertTriangle aria-hidden />
                      <AlertTitle className="line-clamp-none">
                        {copy.failuresTitle(resultFailures.length)}
                      </AlertTitle>
                      <AlertDescription>{copy.failuresHint}</AlertDescription>
                    </Alert>
                    <div className="rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{copy.colFailureId}</TableHead>
                            <TableHead>{copy.colFailureError}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {/* One id can fail twice in a run, so it is not a key alone. */}
                          {resultFailures.map((failure, index) => (
                            <TableRow key={`${failure.id}-${index}`}>
                              <TableCell className="whitespace-normal break-all font-mono text-xs">
                                {failure.id}
                              </TableCell>
                              <TableCell className="text-muted-foreground whitespace-normal">
                                {failure.error}
                              </TableCell>
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
                size="sm"
                className="py-6"
                icon={ShieldCheck}
                title={copy.neverRunTitle}
                description={copy.neverRunBody}
                data-testid={`${idPrefix}-never-run`}
              />
            )}
          </section>
        </CardContent>
      </Card>

      {/*
        ConfirmDialog, not TypeToConfirmDialog: there is no name to type. The
        target is chosen by the server, so a typed token would prove nothing.
        What the operator weighs is scope and reversibility, which the warning
        states. Owning `pending` keeps the dialog open and both buttons dead for
        the whole run, so it cannot be fired twice.
      */}
      <ConfirmDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        title={copy.confirmTitle}
        description={copy.confirmDescription}
        confirmLabel={copy.confirmCta}
        cancelLabel={copy.cancel}
        tone="destructive"
        onConfirm={handleRun}
        pending={isRunning}
        confirmTestId={`${idPrefix}-confirm`}
      >
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <AlertDescription>{copy.confirmWarning}</AlertDescription>
        </Alert>
      </ConfirmDialog>
    </>
  )
}
