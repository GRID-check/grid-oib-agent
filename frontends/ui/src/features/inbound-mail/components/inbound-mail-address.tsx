'use client'

/**
 * The project's mail address, where people learn it (DECISION §9, „Entry
 * points“): `InboundMailAddressDialog` from the upload menu („Per E-Mail
 * senden …“), and `InboundMailAddressCard` in Settings › Dokumente, where a
 * manager creates, replaces or switches it off.
 *
 * Both show the same block: the address in full and copyable (it is 30
 * characters of token nobody types), „Als Kontakt sichern“ (a vCard, which is
 * what makes forwarding from a phone one tap), the three rules that make it
 * safe to hand out, and how often the office's own mail arrives confirmed.
 *
 * Replacing the address is behind a warning that says everything it ends: the
 * old address refuses mail at once, and every „Folgen“ on the project stops.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { BookOpen, CircleSlash, ContactRound, ExternalLink, MailPlus, RefreshCw, ScanLine, ShieldCheck, UserCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BusyButton } from '@/components/ui/busy-button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LoadError } from '@/components/ui/load-error'
import { Skeleton } from '@/components/ui/skeleton'
import { CopyableValue } from '@/features/bim/components/copyable-value'
import { SettingsPanel } from '@/features/projects/components/settings/settings-panel'
import { useLocale, useTranslations } from '@/i18n'
import { startBrowserDownload } from '@/lib/browser-download'
import type { InboundMailAddressView } from '@/lib/inbound-mail/inbound-mail-wire'
import { formatRelativeTime } from '@/lib/format'
import { type InboundMailAddressClient } from '../lib/client'
import { refusalOf } from '../lib/refusal'
import { contactCard, contactCardFileName } from '../lib/vcard'
import { useInboundMailAddress, type AddressState } from '../hooks/use-inbound-mail-address'
import { FactLine } from './inbound-mail-atoms'
import { OwnDomainDkimLine } from './own-domain-dkim-line'

function saveContact(address: string, projectName: string, name: string, note: string): void {
  const blob = new Blob([contactCard({ name, address, note })], { type: 'text/vcard;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  startBrowserDownload(url, contactCardFileName(projectName))
  // The anchor has been clicked; the browser holds its own reference now.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The address itself and what it is for: shared by the dialog and the card. */
export function InboundMailAddressBlock({
  address,
  projectName,
  showRules = true,
}: {
  address: InboundMailAddressView
  projectName: string
  showRules?: boolean
}): JSX.Element {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  if (address.state !== 'active' || !address.address) return <></>
  const value = address.address
  return (
    <div className="flex flex-col gap-4" data-testid="inbound-mail-address">
      <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-muted-foreground text-[10.5px] font-medium uppercase tracking-wider">{t('address.label')}</p>
        <CopyableValue value={value} className="text-foreground mx-0 w-full justify-between text-left font-mono text-sm" />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => saveContact(value, projectName, t('address.contactName', { project: projectName }), t('address.contactNote'))}
            data-testid="address-save-contact"
          >
            <ContactRound className="size-4" aria-hidden />
            {t('address.saveContact')}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          {address.lastReceivedAt
            ? t('address.lastReceived', { time: formatRelativeTime(address.lastReceivedAt, locale) })
            : t('address.nothingReceived')}
          {address.droppedLast30Days > 0 && <> · {t('address.dropped', { count: address.droppedLast30Days })}</>}
        </p>
      </div>
      {showRules && (
        <ul className="flex flex-col gap-2" aria-label={t('address.label')}>
          <li>
            <FactLine icon={UserCheck} tone="default">
              {t('address.rules.held')}
            </FactLine>
          </li>
          <li>
            <FactLine icon={ShieldCheck} tone="default">
              {t('address.rules.trust')}
            </FactLine>
          </li>
          <li>
            <FactLine icon={ScanLine} tone="default">
              {t('address.rules.scanned')}
            </FactLine>
          </li>
        </ul>
      )}
      <OwnDomainDkimLine share={address.ownDomainVerifiedShare} />
      <a
        href={t('address.helpUrl')}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground inline-flex w-fit items-center gap-1.5 text-sm underline-offset-2 hover:underline touch-target"
      >
        <BookOpen className="size-4" aria-hidden />
        {t('address.guide')}
        <ExternalLink className="text-muted-foreground size-3" aria-hidden />
      </a>
    </div>
  )
}

/** The states with no address to show: loading, failed, none yet, not received here. */
function AddressStatus({
  state,
  onRetry,
  onCreate,
}: {
  state: AddressState
  onRetry: () => void
  onCreate: (() => Promise<void>) | null
}): JSX.Element | null {
  const t = useTranslations('inboundMail')
  const [creating, setCreating] = useState(false)
  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label={t('address.label')}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    )
  }
  if (state.kind === 'error') return <LoadError title={t('address.loadError')} onRetry={onRetry} />
  const { address } = state
  if (address.state === 'unavailable') {
    return (
      <FactLine icon={CircleSlash} testId="address-unavailable">
        {t('address.unavailable')}
      </FactLine>
    )
  }
  if (address.state === 'none') {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="address-none">
        <p className="text-sm">{t('address.none')}</p>
        {onCreate && address.canManage ? (
          <BusyButton
            type="button"
            size="sm"
            busy={creating}
            busyLabel={t('address.createBusy')}
            icon={<MailPlus aria-hidden />}
            onClick={() => {
              setCreating(true)
              void onCreate().finally(() => setCreating(false))
            }}
            data-testid="address-create"
          >
            {t('address.create')}
          </BusyButton>
        ) : (
          <p className="text-muted-foreground text-xs">{t('address.noneMember')}</p>
        )}
      </div>
    )
  }
  return null
}

function useAddressActions(address: ReturnType<typeof useInboundMailAddress>) {
  const t = useTranslations('inboundMail')
  const fail = (error: unknown): never => {
    toast.error(t(`refusals.${refusalOf(error)}`))
    throw error
  }
  return {
    create: async () => {
      await address.create().then(() => toast.success(t('address.created')), fail)
    },
    rotate: async () => {
      await address.rotate().then(() => toast.success(t('address.rotated')), fail)
    },
    remove: async () => {
      await address.remove().then(() => toast.success(t('address.switchedOff')), fail)
    },
  }
}

export interface InboundMailAddressDialogProps {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  client?: InboundMailAddressClient
}

/** „Per E-Mail senden …“: the address to forward to, from the upload menu. */
export function InboundMailAddressDialog({ projectId, projectName, open, onOpenChange, client }: InboundMailAddressDialogProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const address = useInboundMailAddress(projectId, open, client)
  const actions = useAddressActions(address)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" closeLabel={t('address.cancel')} data-testid="inbound-mail-address-dialog">
        <DialogHeader>
          <DialogTitle>{t('address.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('address.dialogDescription')}</DialogDescription>
        </DialogHeader>
        {address.state.kind === 'ready' && address.state.address.state === 'active' ? (
          <InboundMailAddressBlock address={address.state.address} projectName={projectName} />
        ) : (
          <AddressStatus state={address.state} onRetry={() => void address.reload()} onCreate={actions.create} />
        )}
      </DialogContent>
    </Dialog>
  )
}

export interface InboundMailAddressCardProps {
  projectId: string
  projectName: string
  client?: InboundMailAddressClient
}

/** Settings › Dokumente: the address, and for a manager, creating, replacing and switching it off. */
export function InboundMailAddressCard({ projectId, projectName, client }: InboundMailAddressCardProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const tSettings = useTranslations('settings')
  const address = useInboundMailAddress(projectId, true, client)
  const actions = useAddressActions(address)
  const [confirm, setConfirm] = useState<'rotate' | 'switchOff' | null>(null)
  const ready = address.state.kind === 'ready' ? address.state.address : null
  const manage = ready?.canManage === true && ready.state === 'active'

  return (
    <SettingsPanel
      title={tSettings('project.documents.inboundMailTitle')}
      description={tSettings('project.documents.inboundMailDescription')}
      data-testid="inbound-mail-address-card"
    >
      <div className="flex flex-col gap-4">
        {ready?.state === 'active' ? (
          <InboundMailAddressBlock address={ready} projectName={projectName} showRules={false} />
        ) : (
          <AddressStatus state={address.state} onRetry={() => void address.reload()} onCreate={actions.create} />
        )}
        {manage && (
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirm('rotate')} data-testid="address-rotate">
              <RefreshCw className="size-4" aria-hidden />
              {t('address.rotate')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm('switchOff')} data-testid="address-switch-off">
              <CircleSlash className="size-4" aria-hidden />
              {t('address.switchOff')}
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirm === 'rotate'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('address.rotateTitle')}
        description={t('address.rotateText')}
        confirmLabel={t('address.rotateConfirm')}
        cancelLabel={t('address.cancel')}
        tone="warning"
        onConfirm={actions.rotate}
        confirmTestId="address-rotate-confirm"
      />
      <ConfirmDialog
        open={confirm === 'switchOff'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t('address.switchOffTitle')}
        description={t('address.switchOffText')}
        confirmLabel={t('address.switchOffConfirm')}
        cancelLabel={t('address.cancel')}
        tone="destructive"
        onConfirm={actions.remove}
        confirmTestId="address-switch-off-confirm"
      />
    </SettingsPanel>
  )
}
