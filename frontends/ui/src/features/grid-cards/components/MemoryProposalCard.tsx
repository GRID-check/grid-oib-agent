'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import { ProposalShell } from './ProposalShell'

type MemoryKind = 'decision' | 'constraint' | 'open_question' | 'derived_fact' | 'preference'
type MemoryConfidence = 'low' | 'medium' | 'high'

interface MemoryProposalCardProps {
  title: string
  content: string
  kind: MemoryKind
  confidence?: MemoryConfidence
}

/**
 * Confirmation card emitted by the `remember` tool when an org-scoped memory
 * write can't be completed by the agent's service token (default-deny). The
 * agent never writes org-wide memory silently; instead the user completes the
 * write through their OWN authenticated session — org-wide (allowed for any org
 * member) or scoped to just this project. Mirrors ProjectProfilePatchCard:
 * propose, never auto-apply.
 */
export function MemoryProposalCard({
  title,
  content,
  kind,
  confidence = 'medium',
}: MemoryProposalCardProps) {
  const t = useTranslations('chat')
  // Same source as ProjectProfilePatchCard's projectId: the active chat store.
  const projectId = useChatStore((s) => s.projectId)
  const [status, setStatus] = useState<'pending' | 'savedOrg' | 'savedProject' | 'dismissed'>('pending')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const save = async (url: string, savedStatus: 'savedOrg' | 'savedProject') => {
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
      setStatus(savedStatus)
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
    setStatus('dismissed')
    setError(null)
  }

  if (status === 'savedOrg' || status === 'savedProject') {
    return (
      <ProposalShell tone="accepted">
        <p className="text-sm text-foreground">
          {status === 'savedOrg' ? t('memoryProposal.savedOrg') : t('memoryProposal.savedProject')}
        </p>
      </ProposalShell>
    )
  }

  if (status === 'dismissed') {
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
