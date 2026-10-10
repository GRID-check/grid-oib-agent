'use client'

/**
 * Closing a project, with „Ausmisten" first (ADR-0092).
 *
 * The dialog asks the server for Piloti's proposal, shows every item with its
 * reason and the mark that it is an AI proposal (EU AI Act Art. 50), all
 * pre-selected, and lets the person deselect any of them. Only what is still
 * selected goes to the Papierkorb, and only when they confirm; then the
 * project closes. When the proposal cannot be had, closing stays possible.
 */

import { useEffect, useState, type JSX } from 'react'
import { Sparkles } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLocale, useTranslations } from '@/i18n'
import type { CleanupProposal } from '@/lib/projects/cleanup-types'
import { CLEANUP_PARTIALLY_UNDONE_REASON } from '@/lib/projects/cleanup-types'

export interface CloseProjectDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Close the project; resolves true when it closed. */
  onClose: () => Promise<boolean>
}

type Load = { state: 'loading' } | { state: 'ready'; proposal: CleanupProposal } | { state: 'failed' }

export function CloseProjectDialog({ projectId, open, onOpenChange, onClose }: CloseProjectDialogProps): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  /** Why the last attempt failed: in general, or with files possibly left in these folders. */
  const [error, setError] = useState<false | { partialIn: string[] | null }>(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoad({ state: 'loading' })
    setError(false)
    fetch(`/api/projects/${projectId}/cleanup/proposal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: locale === 'en' ? 'en' : 'de' }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return (await res.json()) as CleanupProposal
      })
      .then((proposal) => {
        if (cancelled) return
        setLoad({ state: 'ready', proposal })
        setSelected(new Set(proposal.items.map((item) => item.documentId)))
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' })
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId, locale])

  const proposal = load.state === 'ready' ? load.proposal : null
  const items = proposal?.items ?? []

  const toggle = (id: string, on: boolean): void =>
    setSelected((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const finish = async (remove: boolean): Promise<void> => {
    setPending(true)
    setError(false)
    try {
      if (remove && proposal && selected.size > 0) {
        const res = await fetch(`/api/projects/${projectId}/cleanup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            documentIds: [...selected],
            proposedIds: items.map((item) => item.documentId),
            aiUsed: proposal.aiUsed,
          }),
        })
        if (!res.ok) {
          setError({ partialIn: partiallyUndoneIn(await res.json().catch(() => null)) })
          return
        }
      }
      if (await onClose()) onOpenChange(false)
    } catch {
      setError({ partialIn: null })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('cleanup.title')}</DialogTitle>
          <DialogDescription>{t('lifecycle.closeDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">{t('cleanup.intro')}</p>

          {load.state === 'loading' && <p data-testid="cleanup-loading">{t('cleanup.loading')}</p>}
          {load.state === 'failed' && <p className="text-muted-foreground">{t('cleanup.unavailable')}</p>}

          {proposal && (
            <>
              <Alert variant="info" data-testid="cleanup-notice">
                <Sparkles aria-hidden />
                <AlertDescription>{proposal.aiUsed ? t('cleanup.aiNotice') : t('cleanup.aiUnavailable')}</AlertDescription>
              </Alert>
              <p className="text-muted-foreground text-xs">{t('cleanup.considered', { count: proposal.considered })}</p>
              {items.length === 0 ? (
                <p>{t('cleanup.none')}</p>
              ) : (
                <ul className="max-h-80 space-y-2 overflow-y-auto" aria-label={t('cleanup.title')}>
                  {items.map((item) => {
                    const id = `cleanup-${item.documentId}`
                    return (
                      <li key={item.documentId} className="flex items-start gap-3 rounded-lg border border-border p-2.5">
                        <Checkbox
                          id={id}
                          checked={selected.has(item.documentId)}
                          onCheckedChange={(checked) => toggle(item.documentId, checked === true)}
                          className="mt-0.5"
                        />
                        <label htmlFor={id} className="min-w-0 flex-1 space-y-0.5">
                          <span className="block truncate font-medium">{item.filename}</span>
                          {item.folderPath && <span className="text-muted-foreground block truncate text-xs">{item.folderPath}</span>}
                          <span className="text-muted-foreground block text-xs">
                            {item.aiReason ?? (item.rule ? t(`cleanup.rules.${item.rule}`) : '')}
                          </span>
                        </label>
                        {item.aiReason && (
                          <Chip variant="info" size="sm">
                            {t('cleanup.aiChip')}
                          </Chip>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {items.length > 0 && <p className="text-muted-foreground text-xs">{t('cleanup.binNote')}</p>}
            </>
          )}

          {error && (
            <p className="text-error text-sm" data-testid="cleanup-error">
              {error.partialIn ? t('cleanup.partial', { folders: error.partialIn.join('“, „') }) : t('cleanup.error')}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('cleanup.cancel')}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => finish(false)} disabled={pending || load.state === 'loading'}>
              {t('cleanup.closeOnly')}
            </Button>
            {selected.size > 0 && proposal && (
              <Button onClick={() => finish(true)} disabled={pending}>
                {t('cleanup.confirm', { count: selected.size })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The folders a clean-out that could not be fully undone may have left files in; null for any other failure. */
function partiallyUndoneIn(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const details = (body as { details?: { reason?: unknown; folders?: unknown } }).details
  if (details?.reason !== CLEANUP_PARTIALLY_UNDONE_REASON || !Array.isArray(details.folders)) return null
  return details.folders.filter((name): name is string => typeof name === 'string')
}
