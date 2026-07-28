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
}

/**
 * Confirmation card emitted by the `remember` tool when an org-scoped memory
 * write can't be completed by the agent's service token (default-deny). The
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
}: MemoryProposalCardProps) {
  const t = useTranslations('chat')
  // Same source as ProjectProfilePatchCard's projectId: the active chat store.
  const projectId = useChatStore((s) => s.projectId)
  const { decision, decide } = useCardDecision(messageId, cardKey)
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
        const body = await res.json().catch(() => ({}))
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

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Project action is its own row so its target scope reads distinctly from
          the org-wide Yes/No group. Hidden when there is no project in scope. */}
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
    </ProposalShell>
  )
}
