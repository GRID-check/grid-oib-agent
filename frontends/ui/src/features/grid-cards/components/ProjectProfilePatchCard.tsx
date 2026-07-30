'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { useCardDecision } from '../hooks/use-card-decision'
import { ProposalShell } from './ProposalShell'
import { buildPatchPreviewRows } from '@/lib/project-profile/patch-preview'
import type { ProjectProfile, ProjectProfilePatchOperation } from '@/lib/project-profile/types'

interface ProjectProfilePatchCardProps {
  title: string
  rationale: string
  patch: ProjectProfilePatchOperation[]
  projectId?: string | null
  /** Message this card belongs to — keys its persisted decision. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
}

/**
 * Agent-proposed update to the project brief. The change is applied only when
 * the user accepts — the agent can never silently rewrite a project fact
 * (docs/architecture/project-memory-design.md §11.7: propose, never auto-apply).
 *
 * Accept/Reject is recorded on the owning message (`useCardDecision`) rather
 * than in local state, so an applied patch stays applied across reloads instead
 * of re-offering a button that would write it to the brief a second time.
 */
export function ProjectProfilePatchCard({
  title,
  rationale,
  patch,
  projectId,
  messageId,
  cardKey,
}: ProjectProfilePatchCardProps) {
  const t = useTranslations('chat')
  const { decision, decide } = useCardDecision(messageId, cardKey)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  // The before/after rows are DERIVED from the patch + current profile — never
  // from a model-supplied preview — so what the user consents to is exactly what
  // gets written. The current profile is fetched once; on failure it stays null
  // and the "Before" column is hidden rather than guessed.
  const [profile, setProfile] = useState<ProjectProfile | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/profile`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.profile) setProfile(data.profile as ProjectProfile)
      })
      .catch(() => {
        /* leave profile null — the Before column stays hidden */
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const rows = useMemo(() => buildPatchPreviewRows(patch, profile), [patch, profile])

  const handleAccept = async () => {
    if (!projectId) {
      setError(t('profilePatchCard.noProject'))
      return
    }
    setError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/profile/patches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch }),
      })
      if (!res.ok) {
        // A 409 is NOT success. The server answers 200 with `alreadyApplied` for the
        // one conflict that is (a colleague in this shared thread accepting the same
        // card, so the brief already holds the change); every other version conflict
        // means this patch was dropped, and settling as accepted here would hide a
        // change that never landed behind a card that can no longer be retried.
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `${t('profilePatchCard.applyFailed')} (${res.status})`)
      }
      setIsSubmitting(false)
      decide('accepted')
    } catch (e) {
      setIsSubmitting(false)
      setError(e instanceof Error ? e.message : t('profilePatchCard.applyFailed'))
    }
  }

  const handleReject = () => {
    decide('rejected')
    setError(null)
  }

  if (decision === 'accepted') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-sm text-foreground">{t('profilePatchCard.accepted')}</p>
      </ProposalShell>
    )
  }

  if (decision === 'rejected') {
    return (
      <ProposalShell tone="dismissed">
        <p className="text-sm text-muted-foreground">{t('profilePatchCard.rejected')}</p>
      </ProposalShell>
    )
  }

  return (
    <ProposalShell tone="pending">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{rationale}</p>

      {rows.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="py-1 pr-2 text-left font-medium">{t('profilePatchCard.field')}</th>
              {profile !== null && (
                <th scope="col" className="p-1 text-left font-medium">{t('profilePatchCard.before')}</th>
              )}
              <th scope="col" className="pl-2 text-left font-medium">{t('profilePatchCard.after')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-border">
                <td className="py-1 pr-2 font-medium text-foreground">{row.label}</td>
                {profile !== null && <td className="p-1 text-muted-foreground">{row.before}</td>}
                <td className="pl-2 text-foreground">{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        {!projectId && (
          <p className="text-xs text-muted-foreground">{t('profilePatchCard.noProject')}</p>
        )}
        <Button
          type="button"
          size="sm"
          onClick={handleAccept}
          disabled={!projectId || isSubmitting}
        >
          {isSubmitting ? t('profilePatchCard.applying') : t('profilePatchCard.accept')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleReject}>
          {t('profilePatchCard.reject')}
        </Button>
      </div>
    </ProposalShell>
  )
}
