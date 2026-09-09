'use client'

/**
 * "In diese Unterhaltung holen: [Seestadt Nord] einblenden" — the standing
 * control under a register-only answer (`workspace-chat-ui.md` §10, decision 3).
 *
 * A register answer names projects and cites Steckbriefe: names and profile
 * facts, never a passage from a project's files. The reader's next move is
 * almost always "then read that project", and before this the only way to make
 * it was to open the tree, press "+ Projekt einblenden", and search for a name
 * the answer had just printed.
 *
 * ## Derived from the CITATIONS, never from the prose
 *
 * The projects offered here are the ones the answer's register citations name,
 * with the ids the wire carried (ADR-0054). Not the project names the model
 * wrote in its sentence: a control built from prose would offer to mount
 * whatever the model happened to spell, including a project that does not
 * exist. It costs no new card type and survives a reload, because it is a
 * reading of data the message already stores.
 *
 * ## It never offers what is already in view
 *
 * A project the conversation already reads is not an offer, and the answer's
 * own citations are the proof it was read. Nothing renders when every cited
 * project is mounted — a footer that says "einblenden" beside a chip already in
 * "Im Blick" is a control that does nothing, said twice.
 */

import { useMemo, type FC } from 'react'
import { FolderKanban } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { CitedDocument } from '../lib/citations'
import { useChatStore } from '../store'

export interface RegisterMountFooterProps {
  /** The answer's documents, as the citation model built them. */
  documents: readonly CitedDocument[]
}

/** See `MountNotices` — a stable empty list for a partial store fake. */
const NO_MOUNTS: never[] = []

export const RegisterMountFooter: FC<RegisterMountFooterProps> = ({ documents }) => {
  const t = useTranslations('chat')
  const scope = useChatStore((s) => s.scope)
  const mounts = useChatStore((s) => s.mounts ?? NO_MOUNTS)
  const mountsPending = useChatStore((s) => s.mountsPending ?? NO_MOUNTS)
  const conversationId = useChatStore((s) => s.currentConversation?.id ?? null)
  const mountProject = useChatStore((s) => s.mountProject)

  const offers = useMemo(() => {
    const seen = new Map<string, string>()
    for (const doc of documents) {
      if (doc.shelf !== 'register') continue
      if (!doc.projectId || !doc.projectName) continue
      if (!seen.has(doc.projectId)) seen.set(doc.projectId, doc.projectName)
    }
    for (const mount of mounts) seen.delete(mount.projectId)
    return [...seen].map(([projectId, projectName]) => ({ projectId, projectName }))
  }, [documents, mounts])

  // Only in the Büro. A project chat is already locked to one project and has
  // no mounting to offer, so the control would be an affordance for nothing.
  if (scope !== 'workspace' || offers.length === 0) return null

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t pt-2"
      data-testid="register-mount-footer"
    >
      <SectionLabel className="shrink-0">{t('workspace.registerMount.label')}</SectionLabel>
      {offers.map((offer) => (
        <SourceSignalChip
          key={offer.projectId}
          signal="project"
          icon={FolderKanban}
          className="max-w-56"
          trailing={
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={!conversationId || mountsPending.includes(offer.projectId)}
              onClick={() => {
                if (!conversationId) return
                void mountProject(conversationId, offer.projectId, offer.projectName)
              }}
              className="h-auto p-0 px-1 text-xs"
            >
              {t('workspace.registerMount.action')}
            </Button>
          }
        >
          {offer.projectName}
        </SourceSignalChip>
      ))}
    </div>
  )
}
