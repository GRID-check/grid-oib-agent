'use client'

/**
 * BYOK LLM credential management (ADR-0022, admin + `byok-llm` flag).
 *
 * Shows the active credential (metadata only — the key never returns from
 * the API), the rotation/revocation history, and a form to connect or
 * rotate a key. The key is verified live against the provider before
 * anything is stored; storage is WorkOS Vault (or the local encrypted store
 * on dev deployments).
 */

import { type FC, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, RefreshCcw, ShieldCheck, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'

interface CredentialView {
  id: string
  provider: string
  label: string
  baseUrl: string | null
  secretBackend: string
  keyHint: string
  keyFingerprint: string
  status: string
  createdAt: string
  lastVerifiedAt: string | null
  lastUsedAt: string | null
}

interface ListResponse {
  credentials: CredentialView[]
  secretBackend: string
}

const PROVIDERS = ['openrouter', 'openai', 'azure-openai', 'custom'] as const
const NEEDS_BASE_URL = new Set(['azure-openai', 'custom'])

export const LlmCredentialsCard: FC = () => {
  const t = useTranslations('organization')

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [credentials, setCredentials] = useState<CredentialView[]>([])
  const [secretBackend, setSecretBackend] = useState<string>('')

  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('openrouter')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)

  const active = credentials.find((credential) => credential.status === 'active') ?? null
  const history = credentials.filter((credential) => credential.status !== 'active')

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/organization/llm-credentials')
      if (!res.ok) throw new Error(`load failed (${res.status})`)
      const data = (await res.json()) as ListResponse
      setCredentials(data.credentials)
      setSecretBackend(data.secretBackend)
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

  const handleConnect = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/organization/llm-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          label: label.trim() || provider,
          baseUrl: NEEDS_BASE_URL.has(provider) ? baseUrl.trim() : null,
          apiKey,
          rotatedFrom: active?.id ?? null,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error || `save failed (${res.status})`)
      }
      toast.success(active ? t('byok.rotated') : t('byok.connected'))
      setApiKey('')
      setLabel('')
      setBaseUrl('')
      await reload()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('byok.saveError'))
    } finally {
      setBusy(false)
    }
  }, [provider, label, baseUrl, apiKey, active, reload, t])

  const handleVerify = useCallback(async () => {
    if (!active) return
    setBusy(true)
    try {
      const res = await fetch(`/api/organization/llm-credentials/${active.id}/verify`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error || `verify failed (${res.status})`)
      }
      const data = (await res.json()) as { modelCount: number }
      toast.success(t('byok.verified', { count: data.modelCount }))
      await reload()
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t('byok.verifyError'))
    } finally {
      setBusy(false)
    }
  }, [active, reload, t])

  const handleRevoke = useCallback(async () => {
    if (!active) return
    if (!window.confirm(t('byok.revokeConfirm'))) return
    setBusy(true)
    try {
      const res = await fetch(`/api/organization/llm-credentials/${active.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`revoke failed (${res.status})`)
      toast.success(t('byok.revoked'))
      await reload()
    } catch {
      toast.error(t('byok.revokeError'))
    } finally {
      setBusy(false)
    }
  }, [active, reload, t])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner className="size-4" /> {t('byok.loading')}
      </div>
    )
  }
  if (loadError) {
    return <p className="text-sm text-muted-foreground">{t('byok.loadError')}</p>
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Active credential */}
      {active ? (
        <div className="rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium">{active.label}</span>
              <Badge variant="secondary">{active.provider}</Badge>
              <Badge>{t('byok.activeBadge')}</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={handleVerify} disabled={busy}>
                <ShieldCheck className="size-3.5" aria-hidden /> {t('byok.verify')}
              </Button>
              <Button size="sm" variant="outline" onClick={handleRevoke} disabled={busy}>
                <Trash2 className="size-3.5" aria-hidden /> {t('byok.revoke')}
              </Button>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div>
              <dt className="font-medium uppercase">{t('byok.keyLabel')}</dt>
              <dd className="mt-0.5 font-mono">
                {active.keyHint} · {active.keyFingerprint}
              </dd>
            </div>
            <div>
              <dt className="font-medium uppercase">{t('byok.storageLabel')}</dt>
              <dd className="mt-0.5">
                {active.secretBackend === 'workos-vault' ? t('byok.storageVault') : t('byok.storageLocal')}
              </dd>
            </div>
            {active.baseUrl && (
              <div className="sm:col-span-2">
                <dt className="font-medium uppercase">{t('byok.baseUrl')}</dt>
                <dd className="mt-0.5 truncate font-mono">{active.baseUrl}</dd>
              </div>
            )}
            <div>
              <dt className="font-medium uppercase">{t('byok.lastVerified')}</dt>
              <dd className="mt-0.5">
                {active.lastVerifiedAt ? new Date(active.lastVerifiedAt).toLocaleString() : '—'}
              </dd>
            </div>
            <div>
              <dt className="font-medium uppercase">{t('byok.lastUsed')}</dt>
              <dd className="mt-0.5">{active.lastUsedAt ? new Date(active.lastUsedAt).toLocaleString() : '—'}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('byok.noCredential')}{' '}
          {secretBackend === 'workos-vault' ? t('byok.storageVaultNote') : t('byok.storageLocalNote')}
        </p>
      )}

      {/* Connect / rotate form */}
      <div className="flex flex-col gap-4">
        <p className="text-sm font-medium">{active ? t('byok.rotateTitle') : t('byok.connectTitle')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label>{t('byok.provider')}</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as (typeof PROVIDERS)[number])}>
              <SelectTrigger aria-label={t('byok.provider')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {t(`byok.providers.${id}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="byok-label">{t('byok.label')}</Label>
            <Input
              id="byok-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('byok.labelPlaceholder')}
            />
          </div>
        </div>
        {NEEDS_BASE_URL.has(provider) && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="byok-base-url">{t('byok.baseUrl')}</Label>
            <Input
              id="byok-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
            />
            <p className="text-xs text-muted-foreground">{t('byok.baseUrlHint')}</p>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor="byok-api-key">{t('byok.apiKey')}</Label>
          <Input
            id="byok-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('byok.apiKeyPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">{t('byok.apiKeyHint')}</p>
        </div>
        <div>
          <Button onClick={handleConnect} disabled={busy || apiKey.trim().length < 8}>
            {busy ? (
              <>
                <RefreshCcw className="size-3.5 animate-spin" aria-hidden /> {t('byok.saving')}
              </>
            ) : active ? (
              t('byok.rotate')
            ) : (
              t('byok.connect')
            )}
          </Button>
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('byok.history')}</p>
          <ul className="flex flex-col gap-1.5">
            {history.map((credential) => (
              <li key={credential.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{credential.provider}</Badge>
                <span className="font-mono">{credential.keyHint}</span>
                <span>{credential.label}</span>
                <span>·</span>
                <span>
                  {t('byok.revokedOn', {
                    date: new Date(credential.createdAt).toLocaleDateString(),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
