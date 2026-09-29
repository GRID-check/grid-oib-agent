'use client'

/**
 * Platform maintenance — the kill switch for deep research.
 *
 * Stops every queued or running deep research in every organization and closes
 * each run as interrupted (`POST /api/platform/maintenance/kill-runs`,
 * `lib/runs/kill-all.ts`). Built like `VectorMaintenance` beside it, for the
 * same reasons: the copy says what the button does and what it loses, the
 * confirm is destructive-toned, and the counts stay on screen as the record,
 * because nothing else records a press but the server log.
 */

import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, OctagonX, ShieldCheck } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'

/** Mirrors `KillAllResult` in `@/lib/runs/kill-all`. */
export interface KillResult {
  jobsFound: number
  jobsKilled: number
  jobsAlreadyFinished: number
  runsClosed: number
  failures: { id: string; error: string }[]
  truncated: boolean
}

/**
 * The backend stops up to a thousand jobs one after another; past this the
 * request is released so the dialog cannot hang. The kill itself is
 * server-owned and may still complete.
 */
const KILL_TIMEOUT_MS = 180_000

export interface RunKillSwitchProps {
  /** Seeds the "last kill" panel, for the dev preview and tests only. */
  initialResult?: KillResult | null
}

export function RunKillSwitch({ initialResult = null }: RunKillSwitchProps): JSX.Element {
  const t = useTranslations('platform')
  const [isOpen, setIsOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastResult, setLastResult] = useState<KillResult | null>(initialResult)
  const [hasFailed, setHasFailed] = useState(false)

  const handleKill = useCallback(async () => {
    setIsRunning(true)
    setHasFailed(false)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), KILL_TIMEOUT_MS)
    try {
      const res = await fetch('/api/platform/maintenance/kill-runs', { method: 'POST', signal: controller.signal })
      if (!res.ok) throw new Error(`Kill failed (${res.status})`)
      const body = (await res.json()) as Partial<KillResult>
      const result: KillResult = {
        jobsFound: body.jobsFound ?? 0,
        jobsKilled: body.jobsKilled ?? 0,
        jobsAlreadyFinished: body.jobsAlreadyFinished ?? 0,
        runsClosed: body.runsClosed ?? 0,
        failures: body.failures ?? [],
        truncated: body.truncated ?? false,
      }
      setLastResult(result)
      toast.success(outcomeText(t, result))
      if (result.failures.length > 0) {
        toast.warning(t('runKillSwitch.failuresTitle', { count: result.failures.length }))
      }
    } catch {
      setHasFailed(true)
      toast.error(t('runKillSwitch.failed'))
    } finally {
      clearTimeout(timeout)
      setIsRunning(false)
      setIsOpen(false)
    }
  }, [t])

  const measures = lastResult
    ? [
        ['found', 'measureFound', 'measureFoundHint', lastResult.jobsFound],
        ['killed', 'measureKilled', 'measureKilledHint', lastResult.jobsKilled],
        ['finished', 'measureFinished', 'measureFinishedHint', lastResult.jobsAlreadyFinished],
        ['closed', 'measureRunsClosed', 'measureRunsClosedHint', lastResult.runsClosed],
      ] as const
    : []

  return (
    <>
      <SectionCard
        title={t('runKillSwitch.title')}
        description={t('runKillSwitch.description')}
        testId="run-kill-switch"
        action={
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setIsOpen(true)}
            disabled={isRunning}
            data-testid="kill-runs-trigger"
          >
            {isRunning ? <Spinner className="size-3.5" aria-hidden /> : <OctagonX className="size-3.5" aria-hidden />}
            {isRunning ? t('runKillSwitch.running') : t('runKillSwitch.run')}
          </Button>
        }
      >
        <div className="flex flex-col gap-6">
          <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-3">
            {(
              [
                ['what', t('runKillSwitch.whatTitle'), t('runKillSwitch.whatBody')],
                ['when', t('runKillSwitch.whenTitle'), t('runKillSwitch.whenBody')],
                ['loss', t('runKillSwitch.lossTitle'), t('runKillSwitch.lossBody')],
              ] as const
            ).map(([key, term, body]) => (
              <div key={key}>
                <dt>
                  <SectionLabel>{term}</SectionLabel>
                </dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <SectionLabel as="h3">{t('runKillSwitch.lastRunTitle')}</SectionLabel>
              <span className="text-xs text-muted-foreground">{t('runKillSwitch.lastRunHint')}</span>
            </div>

            {hasFailed ? (
              <Alert variant="destructive" data-testid="kill-runs-error">
                <AlertTriangle aria-hidden />
                <AlertTitle>{t('runKillSwitch.failed')}</AlertTitle>
                <AlertDescription>{t('runKillSwitch.failedHint')}</AlertDescription>
              </Alert>
            ) : null}

            {lastResult ? (
              <div className="flex flex-col gap-3" data-testid="kill-runs-result">
                <Alert variant={lastResult.jobsKilled + lastResult.runsClosed > 0 ? 'info' : 'success'}>
                  <CheckCircle2 aria-hidden />
                  <AlertTitle>{outcomeText(t, lastResult)}</AlertTitle>
                  {lastResult.truncated ? <AlertDescription>{t('runKillSwitch.truncated')}</AlertDescription> : null}
                </Alert>

                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('runKillSwitch.colMeasure')}</TableHead>
                        <TableHead className="text-right">{t('runKillSwitch.colCount')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {measures.map(([key, label, hint, value]) => (
                        <TableRow key={key}>
                          <TableCell>
                            <span className="block text-sm font-medium">{t(`runKillSwitch.${label}`)}</span>
                            <span className="block text-xs text-muted-foreground">{t(`runKillSwitch.${hint}`)}</span>
                          </TableCell>
                          <TableCell className="text-right align-top text-sm font-semibold tabular-nums">
                            {value}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {lastResult.failures.length > 0 ? (
                  <div className="rounded-lg border" data-testid="kill-runs-failures">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('runKillSwitch.colId')}</TableHead>
                          <TableHead>{t('runKillSwitch.colError')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lastResult.failures.map((failure, index) => (
                          <TableRow key={`${failure.id}-${index}`}>
                            <TableCell className="font-medium break-all">{failure.id}</TableCell>
                            <TableCell className="text-muted-foreground">{failure.error}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
              </div>
            ) : hasFailed ? null : (
              <EmptyState
                variant="bare"
                icon={ShieldCheck}
                title={t('runKillSwitch.neverRunTitle')}
                description={t('runKillSwitch.neverRunBody')}
                data-testid="kill-runs-never-run"
              />
            )}
          </div>
        </div>
      </SectionCard>

      <ConfirmDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        title={t('runKillSwitch.confirmTitle')}
        description={t('runKillSwitch.confirmDescription')}
        confirmLabel={t('runKillSwitch.confirmCta')}
        cancelLabel={t('runKillSwitch.cancel')}
        tone="destructive"
        onConfirm={handleKill}
        // Owning `pending` keeps the dialog open, both buttons dead, until the
        // kill answers, so it cannot be double-fired.
        pending={isRunning}
        confirmTestId="kill-runs-confirm"
      >
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <AlertDescription>{t('runKillSwitch.confirmWarning')}</AlertDescription>
        </Alert>
      </ConfirmDialog>
    </>
  )
}

function outcomeText(t: ReturnType<typeof useTranslations>, result: KillResult): string {
  return result.jobsKilled + result.runsClosed > 0
    ? t('runKillSwitch.outcomeKilled', { jobs: result.jobsKilled, runs: result.runsClosed })
    : t('runKillSwitch.outcomeClean')
}
