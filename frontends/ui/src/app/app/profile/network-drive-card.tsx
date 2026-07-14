'use client'

/**
 * Network-drive device management.
 *
 * A signed-in user creates a device credential here (a WebDAV Basic-auth
 * username + one-time secret), then enters it in the native macOS/Windows
 * "connect to server" dialog to mount their Grid projects as a network drive.
 *
 * The secret is returned by the API exactly once on creation and can never be
 * retrieved again, so the success step makes copying it deliberate and warns
 * that it will not be shown a second time. This is a client island: it owns
 * the credential list, the create dialog, and the revoke flow.
 */

import { type FC, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, HardDrive, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

/** A single active credential, as returned by `GET /api/drive/credentials`. */
interface CredentialView {
  id: string
  label: string
  username: string
  createdAt: string
  expiresAt: string
  lastUsedAt: string | null
}

/** The one-time payload from `POST /api/drive/credentials`. */
interface CreatedCredential {
  id: string
  username: string
  secret: string
  expiresAt: string
  webdavUrl: string | null
}

/**
 * Build-time fallback for the WebDAV server address, used when the API does
 * not return one (e.g. a deployment where the mount host is fixed).
 */
const ENV_WEBDAV_URL = process.env.NEXT_PUBLIC_DRIVE_WEBDAV_URL ?? null

const formatDate = (value: string): string => new Date(value).toLocaleDateString()

/** A read-only value with a copy-to-clipboard button. */
const CopyField: FC<{ label: string; value: string; copyLabel: string; mono?: boolean }> = ({
  label,
  value,
  copyLabel,
  mono = false,
}) => {
  const t = useTranslations('profile')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('drive.copyFailed'))
    }
  }, [value, t])

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2">
        {/* select-all so the value can be selected with a single click; it is
            plain, selectable text (not an input) for screen readers. */}
        <code className={mono ? 'min-w-0 flex-1 select-all break-all font-mono text-sm' : 'min-w-0 flex-1 select-all break-all text-sm'}>
          {value}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8 shrink-0"
          onClick={handleCopy}
          aria-label={copied ? t('drive.copied') : copyLabel}
        >
          {copied ? (
            <Check className="size-4 text-success" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  )
}

export const NetworkDriveCard: FC = () => {
  const t = useTranslations('profile')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [credentials, setCredentials] = useState<CredentialView[]>([])

  const [dialogOpen, setDialogOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedCredential | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/drive/credentials')
      if (!res.ok) throw new Error(`load failed (${res.status})`)
      const data = (await res.json()) as { credentials: CredentialView[] }
      setCredentials(data.credentials)
      setLoadError(false)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const openDialog = useCallback(() => {
    setLabel('')
    setCreated(null)
    setDialogOpen(true)
  }, [])

  const handleCreate = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed.length < 1) return
    setBusy(true)
    try {
      const res = await fetch('/api/drive/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      })
      if (!res.ok) throw new Error(`create failed (${res.status})`)
      const data = (await res.json()) as CreatedCredential
      setCreated(data)
      await reload()
    } catch {
      toast.error(t('drive.createError'))
    } finally {
      setBusy(false)
    }
  }, [label, reload, t])

  const handleRevoke = useCallback(
    async (credential: CredentialView) => {
      if (!window.confirm(t('drive.revokeConfirm'))) return
      try {
        const res = await fetch(`/api/drive/credentials/${credential.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`revoke failed (${res.status})`)
        toast.success(t('drive.revoked'))
        await reload()
      } catch {
        toast.error(t('drive.revokeError'))
      }
    },
    [reload, t],
  )

  const webdavUrl = created?.webdavUrl ?? ENV_WEBDAV_URL

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4 text-muted-foreground" aria-hidden />
          {t('drive.title')}
        </CardTitle>
        <CardDescription>{t('drive.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Spinner className="size-4" /> {t('drive.loading')}
          </div>
        ) : loadError ? (
          <p className="text-sm text-muted-foreground">{t('drive.loadError')}</p>
        ) : credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('drive.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {credentials.map((credential) => (
              <li
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{credential.label}</p>
                  <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    <div className="flex gap-1">
                      <dt>{t('drive.columnCreated')}:</dt>
                      <dd>{formatDate(credential.createdAt)}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>{t('drive.columnExpires')}:</dt>
                      <dd>{formatDate(credential.expiresAt)}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>{t('drive.columnLastUsed')}:</dt>
                      <dd>
                        {credential.lastUsedAt
                          ? formatDate(credential.lastUsedAt)
                          : t('drive.neverUsed')}
                      </dd>
                    </div>
                  </dl>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => handleRevoke(credential)}
                  aria-label={t('drive.revokeAria', { label: credential.label })}
                >
                  <Trash2 className="size-3.5" aria-hidden /> {t('drive.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div>
          <Button type="button" onClick={openDialog} className="gap-2">
            <Plus className="size-4" aria-hidden />
            {t('drive.connectDevice')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('drive.successTitle')}</DialogTitle>
                <DialogDescription className="font-medium text-warning">
                  {t('drive.secretOnce')}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3">
                <CopyField
                  label={t('drive.usernameLabel')}
                  value={created.username}
                  copyLabel={t('drive.copyUsername')}
                  mono
                />
                <CopyField
                  label={t('drive.secretLabel')}
                  value={created.secret}
                  copyLabel={t('drive.copySecret')}
                  mono
                />
                {webdavUrl ? (
                  <CopyField
                    label={t('drive.urlLabel')}
                    value={webdavUrl}
                    copyLabel={t('drive.copyUrl')}
                    mono
                  />
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium uppercase text-muted-foreground">
                      {t('drive.urlLabel')}
                    </span>
                    <p className="text-sm text-muted-foreground">{t('drive.urlPlaceholder')}</p>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium uppercase text-muted-foreground">
                    {t('drive.expiresLabel')}
                  </span>
                  <p className="text-sm">{formatDate(created.expiresAt)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-surface-sunken p-4">
                <p className="text-sm font-medium">{t('drive.instructionsTitle')}</p>
                <dl className="mt-2 flex flex-col gap-3 text-sm text-muted-foreground">
                  <div>
                    <dt className="font-medium text-foreground">{t('drive.macTitle')}</dt>
                    <dd className="mt-0.5">{t('drive.macSteps')}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">{t('drive.windowsTitle')}</dt>
                    <dd className="mt-0.5">{t('drive.windowsSteps')}</dd>
                  </div>
                </dl>
              </div>

              <DialogFooter>
                <Button type="button" onClick={() => setDialogOpen(false)}>
                  {t('drive.done')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('drive.createTitle')}</DialogTitle>
                <DialogDescription>{t('drive.createDescription')}</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-2">
                <Label htmlFor="drive-label">{t('drive.labelLabel')}</Label>
                <Input
                  id="drive-label"
                  value={label}
                  maxLength={64}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t('drive.labelPlaceholder')}
                  autoComplete="off"
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={busy}
                >
                  {t('drive.cancel')}
                </Button>
                <Button
                  type="button"
                  onClick={handleCreate}
                  disabled={busy || label.trim().length < 1}
                >
                  {busy ? (
                    <>
                      <Spinner className="size-4" /> {t('drive.creating')}
                    </>
                  ) : (
                    t('drive.create')
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
