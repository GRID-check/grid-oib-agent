'use client'

/**
 * Platform maintenance — reconcile orphaned vectors.
 *
 * A one-click sweep for the platform owner: it deletes vector-store chunks
 * whose owning document row no longer exists (the residue of past deletes where
 * the chunk cleanup was skipped or missed). Destructive but self-limiting — it
 * only ever removes chunks with no live document — so it is guarded by a
 * confirm dialog and reports exactly what it removed.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Brush, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

interface ReconcileResult {
  collectionsScanned: number
  orphansFound: number
  orphansDeleted: number
  failures: { collectionName: string; error: string }[]
}

export function VectorMaintenance() {
  const t = useTranslations('platform')
  const [isOpen, setIsOpen] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastResult, setLastResult] = useState<ReconcileResult | null>(null)

  const handleReconcile = useCallback(() => {
    setIsRunning(true)
    fetch('/api/platform/maintenance/reconcile-vectors', { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Reconcile failed (${res.status})`)
        const body = (await res.json()) as ReconcileResult
        setLastResult(body)
        if (body.orphansDeleted > 0) {
          toast.success(
            t('maintenance.resultRemoved', {
              chunks: body.orphansDeleted,
              collections: body.collectionsScanned,
            }),
          )
        } else {
          toast.success(t('maintenance.resultClean'))
        }
        if (body.failures.length > 0) {
          toast.warning(t('maintenance.resultFailures', { count: body.failures.length }))
        }
      })
      .catch(() => toast.error(t('maintenance.failed')))
      .finally(() => {
        setIsRunning(false)
        setIsOpen(false)
      })
  }, [t])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          {t('maintenance.title')}
        </CardTitle>
        <CardDescription>{t('maintenance.description')}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={() => setIsOpen(true)} disabled={isRunning}>
            {isRunning ? <Spinner className="size-3.5" /> : <Brush className="size-3.5" aria-hidden />}
            {isRunning ? t('maintenance.reconciling') : t('maintenance.reconcile')}
          </Button>
        </CardAction>
      </CardHeader>

      {lastResult && (
        <CardContent>
          <div
            className="rounded-lg border border-border bg-card/50 px-3 py-2.5 text-sm text-muted-foreground"
            data-testid="reconcile-result"
          >
            {lastResult.orphansDeleted > 0
              ? t('maintenance.resultRemoved', {
                  chunks: lastResult.orphansDeleted,
                  collections: lastResult.collectionsScanned,
                })
              : t('maintenance.resultCleanDetail', { collections: lastResult.collectionsScanned })}
            {lastResult.failures.length > 0 && (
              <span className="ml-1 text-destructive">
                {t('maintenance.resultFailures', { count: lastResult.failures.length })}
              </span>
            )}
          </div>
        </CardContent>
      )}

      <Dialog open={isOpen} onOpenChange={(open) => !isRunning && setIsOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('maintenance.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('maintenance.confirmDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)} disabled={isRunning}>
              {t('maintenance.cancel')}
            </Button>
            <Button onClick={handleReconcile} disabled={isRunning}>
              {isRunning ? <Spinner className="size-3.5" /> : <Brush className="size-3.5" aria-hidden />}
              {t('maintenance.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
