'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import { useCardDecision } from '../hooks/use-card-decision'
import { ProposalShell } from './ProposalShell'

type MemoryKind = 'decision' | 'constraint' | 'open_question' | 'derived_fact' | 'preference'
type MemoryConfidence = 'low' | 'medium' | 'high'

interface MemoryProposalCardProps {
  title: string
  content: string
  kind: MemoryKind
  confidence?: MemoryConfidence
  /** Message this card belongs to — keys its persisted decision. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
  /**
   * Whether this surface requires the answer to be persisted. With no owning
   * message the card then shows WHAT is proposed and offers nothing — see
   * `GridCards.decisionsMustPersist`.
   */
  decisionsMustPersist?: boolean
}

/**
 * The organization proposal card: a finding whose scope is the whole tenant,
 * put to a person because only a person may widen it that far.
 *
 * Emitted by the `remember` tool — and, since ADR-0055, by the post-answer
 * reflection stage — when an org-scoped memory write cannot be completed by the
 * agent's service token (default-deny). It is the REVIEW half of the gate
 * ADR-0054 built: the write is refused for everyone, the card asks, and
 * acceptance runs through the reader's own authenticated session with
 * `org:memory:write`. The card says both of those things in as many words,
 * because "why am I being asked this" and "who can say yes" are the questions
 * a proposal has to answer to be one.
 *
 * The
 * agent never writes org-wide memory silently; instead the user completes the
 * write through their OWN authenticated session — org-wide (allowed for any org
 * member) or scoped to just this project. Mirrors ProjectProfilePatchCard:
 * propose, never auto-apply.
 *
 * The answer is recorded on the owning message (`useCardDecision`), not in
 * local state: `/api/organization/memory` has no idempotency key, so a card
 * that forgot it had been saved would write the same memory again on the next
 * click after a reload.
 */
export function MemoryProposalCard({
  title,
  content,
  kind,
  confidence = 'medium',
  messageId,
  cardKey,
  decisionsMustPersist,
}: MemoryProposalCardProps) {
  const t = useTranslations('chat')
  // Same source as ProjectProfilePatchCard's projectId: the active chat store.
  const projectId = useChatStore((s) => s.projectId)
  const { decision, decide, canDecide } = useCardDecision(messageId, cardKey, {
    mustPersist: decisionsMustPersist,
  })
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const save = async (url: string, savedDecision: 'savedOrg' | 'savedProject') => {
    setError(null)
    setIsSubmitting(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, content, confidence }),
      })
      if (!res.ok) {
        const body: { code?: string; error?: string } = await res.json().catch(() => ({}))
        // A refused ORG write is a PERMISSION, not an outage. `403
        // ORG_MEMORY_DISABLED` reached the reader as "service unavailable",
        // which is the wrong instruction twice over: it invites waiting, and it
        // hides the two things that would actually work — asking an
        // administrator for `org:memory:write`, or saving to this project
        // instead. The sentence is ours, never the server's `error` string
        // (ADR-0055, C6).
        if (res.status === 403 || body.code === 'ORG_MEMORY_DISABLED') {
          // ONE code, TWO causes, and they need two different sentences — the
          // whole point of the ordering fix on the server (ADR-0055, C6). A
          // permission denial is about the acting user and has a remedy they
          // can pursue: ask an administrator, or save to this project. The
          // deployment off-switch is about the installation and has neither —
          // telling that person to ask for a permission would send them at a
          // door that is not the locked one.
          //
          // The code cannot separate them (the Python proposal-card branch keys
          // on it and must stay one branch), so the message does. The match is
          // narrow and the DEFAULT is the permission sentence, because that is
          // the one a person can act on and the one that is true in every
          // ordinary deployment.
          const deploymentOff = /switched off|deployment|disabled/i.test(body.error ?? '')
          throw new Error(
            t(deploymentOff ? 'memoryProposal.orgSwitchedOff' : 'memoryProposal.orgDenied')
          )
        }
        throw new Error(body.error || `${t('memoryProposal.error')} (${res.status})`)
      }
      setIsSubmitting(false)
      decide(savedDecision)
    } catch (e) {
      setIsSubmitting(false)
      setError(e instanceof Error ? e.message : t('memoryProposal.error'))
    }
  }

  const handleSaveOrg = () => save('/api/organization/memory', 'savedOrg')
  const handleSaveProject = () => {
    if (!projectId) return
    void save(`/api/projects/${projectId}/memory`, 'savedProject')
  }
  const handleDismiss = () => {
    decide('dismissed')
    setError(null)
  }

  if (decision === 'savedOrg' || decision === 'savedProject') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-sm text-foreground">
          {decision === 'savedOrg' ? t('memoryProposal.savedOrg') : t('memoryProposal.savedProject')}
        </p>
      </ProposalShell>
    )
  }

  if (decision === 'dismissed') {
    return (
      <ProposalShell tone="dismissed">
        <p className="text-sm text-muted-foreground">{t('memoryProposal.dismissed')}</p>
      </ProposalShell>
    )
  }

  return (
    <ProposalShell tone="pending">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <Chip variant="muted" size="sm">
          {t(`memoryProposal.kind.${kind}`)}
        </Chip>
      </div>

      <p className="text-sm leading-relaxed text-foreground">{content}</p>

      {/* WHY this is being asked, and WHO may answer it. An organization write
          is the one write whose blast radius is every project in the tenant, so
          the card states the reach before the buttons and names the permission
          that accepts it (ADR-0055, C6). */}
      <p className="text-xs leading-relaxed text-muted-foreground" data-testid="memory-proposal-reach">
        {t('memoryProposal.orgReach')}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground" data-testid="memory-proposal-permission">
        {t('memoryProposal.orgPermission')}
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* NOTHING TO PRESS when the answer could not be kept (`canDecide`): the
          proposal still reads — this is what the run wants remembered — but a
          Yes here would POST a memory row and then forget it had, and
          `/api/organization/memory` inserts unconditionally. The card is asked
          again where the answer has a home, which is the thread. */}
      {canDecide && (
        <>
          {/* Project action is its own row so its target scope reads distinctly
              from the org-wide Yes/No group. Hidden when there is no project in
              scope. */}
          {projectId && (
            <div className="flex items-center">
              <Button type="button" variant="outline" size="sm" onClick={handleSaveProject} disabled={isSubmitting}>
                {t('memoryProposal.saveToProject')}
              </Button>
            </div>
          )}

          {/* Org-wide prompt with Yes/No grouped together to the right. */}
          <div className="flex items-center justify-end gap-2">
            <p className="mr-auto text-sm text-muted-foreground">{t('memoryProposal.prompt')}</p>
            <Button type="button" size="sm" onClick={handleSaveOrg} disabled={isSubmitting}>
              {isSubmitting ? t('memoryProposal.saving') : t('memoryProposal.yes')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleDismiss} disabled={isSubmitting}>
              {t('memoryProposal.no')}
            </Button>
          </div>
        </>
      )}
    </ProposalShell>
  )
}
