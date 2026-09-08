'use client'

/**
 * The scope chip and the Wissensbasis behind it, bound to the ONE mounts state
 * (`workspace-chat-ui.md` §4).
 *
 * It exists so the composer does not have to. `InputArea` is an organism about
 * writing a message; "which knowledge levels may this turn read, and how does a
 * reader change that" is a second organism that happened to be rendered inside
 * it, and the 70 lines it replaces were a popover with a disabled row and an
 * apology in a tooltip.
 *
 * ## One state, three signals
 *
 * The chip's count, the tree's project rows and the "Im Blick" row above the
 * composer all read `mounts` from the chat store, and every write goes through
 * `mountProject` / `unmountProject`. There is deliberately no local copy: a
 * second list is a second thing that can be wrong, and the whole design turns
 * on the reader being able to trust that what the chip says is what the turn
 * will read.
 *
 * ## Popover on desktop, Sheet below `md`
 *
 * A `Command` popover nested inside a `Popover` on a 390px viewport is two
 * overlays deep and one outside-click away from losing both (§8). Below `md`
 * the same tree renders in a bottom `Sheet`, where the picker opens as a pane
 * inside the sheet rather than as a second layer over it.
 */

import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import { useRouter } from 'next/navigation'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { useChatStore } from '@/features/chat'
import { canMountMore } from '@/features/chat/stores'
import type { ConversationScope } from '@/features/chat/lib/project-scope'
import { useLayoutStore } from '../../store'
import type { SourcePresetId } from '../../types'
import { ScopeChip } from './ScopeChip'
import { ScopeTree } from './ScopeTree'
import { buildScopeLevels, type ScopeLevelId } from './scope-tree-model'

export interface ScopeControlProps {
  /** Which surface the composer is standing on. */
  scope: ConversationScope
  /** The project a project chat is locked to (its NAME; the id comes from the store). */
  projectName?: string | null
  /** Files attached to THIS conversation — the conversation level's evidence. */
  sessionAttachmentCount?: number
  /** Read-only participant: the chip opens nothing, like the composer. */
  disabled?: boolean
}

/**
 * Which levels a source preset excludes.
 *
 * DERIVED from the level's own provenance family rather than listed: a preset
 * is "only this family", and every level knows which family it paints with
 * (`scope-tree-model.ts`). A hand-written table here would be a second
 * statement of the same rule, and the two would disagree the first time a sixth
 * level landed.
 */
const PRESET_SIGNAL: Record<SourcePresetId, 'law' | 'office' | 'project'> = {
  law: 'law',
  office: 'office',
  project: 'project',
}

const LEVEL_SIGNALS: Record<ScopeLevelId, 'law' | 'office' | 'project'> = {
  base: 'law',
  archiv: 'office',
  register: 'project',
  project: 'project',
  session: 'project',
}

const excludedByPreset = (preset: SourcePresetId): ScopeLevelId[] =>
  (Object.keys(LEVEL_SIGNALS) as ScopeLevelId[]).filter(
    (id) => LEVEL_SIGNALS[id] !== PRESET_SIGNAL[preset]
  )

/** See `features/chat/components/MountNotices` — stable empty list for a fake. */
const NO_MOUNTS: never[] = []

export const ScopeControl: FC<ScopeControlProps> = ({
  scope,
  projectName,
  sessionAttachmentCount = 0,
  disabled,
}) => {
  const t = useTranslations('chat')
  const isMobile = useIsMobile()
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const conversationId = useChatStore((s) => s.currentConversation?.id ?? null)
  // The id, from the same place every other consumer on this path reads it.
  // Passing it down beside the name would be two channels for one fact.
  const projectId = useChatStore((s) => s.projectId)
  const mounts = useChatStore((s) => s.mounts ?? NO_MOUNTS)
  const mountCap = useChatStore((s) => s.mountCap)
  const mountsLoading = useChatStore((s) => s.mountsLoading)
  const mountsPending = useChatStore((s) => s.mountsPending ?? NO_MOUNTS)
  const mountRefusal = useChatStore((s) => s.mountRefusal)
  const loadMounts = useChatStore((s) => s.loadMounts)
  const mountProject = useChatStore((s) => s.mountProject)
  const unmountProject = useChatStore((s) => s.unmountProject)
  const clearMountRefusal = useChatStore((s) => s.clearMountRefusal)
  const resetMounts = useChatStore((s) => s.resetMounts)

  const activePreset = useLayoutStore((s) => s.activeSourcePreset)
  const applySourcePreset = useLayoutStore((s) => s.applySourcePreset)
  const enabledDataSourceIds = useLayoutStore((s) => s.enabledDataSourceIds)
  const setDeepResearchIntent = useLayoutStore((s) => s.setDeepResearchIntent)

  const isWorkspace = scope === 'workspace'

  // Mounts belong to the conversation, so they are fetched per conversation and
  // dropped with it. A project chat never fetches: it has no mounts by
  // construction, and asking would be a request whose only possible answer is
  // the empty list.
  useEffect(() => {
    if (!isWorkspace) {
      resetMounts()
      return
    }
    if (!conversationId) {
      resetMounts()
      return
    }
    void loadMounts(conversationId)
  }, [isWorkspace, conversationId, loadMounts, resetMounts])

  const preset = useMemo(
    () =>
      activePreset
        ? {
            label: t(`shortcuts.presets.${activePreset}`),
            excludes: excludedByPreset(activePreset),
          }
        : null,
    [activePreset, t]
  )

  const levels = useMemo(
    () =>
      buildScopeLevels({
        scope,
        projectName,
        mounted: isWorkspace
          ? mounts.map((mount) => ({
              projectId: mount.projectId,
              projectName: mount.projectName,
              mountedBy: mount.mountedBy,
            }))
          : [],
        sessionAttachmentCount,
        preset,
        canMount: canMountMore({ mounts, mountCap }),
      }),
    [scope, projectName, isWorkspace, mounts, mountCap, sessionAttachmentCount, preset]
  )

  const handleMount = useCallback(
    (id: string, name: string) => {
      if (!conversationId) return
      void mountProject(conversationId, id, name)
    },
    [conversationId, mountProject]
  )

  const handleUnmount = useCallback(
    (id: string) => {
      if (!conversationId) return
      void unmountProject(conversationId, id)
    },
    [conversationId, unmountProject]
  )

  const handleDeepResearch = useCallback(() => {
    // The offer behind the cap is the EXISTING deep-research path, armed. It
    // does not send: the reader still owns the question, and a control that
    // fired a turn they had not finished writing would be a different promise.
    setDeepResearchIntent(true)
    setOpen(false)
  }, [setDeepResearchIntent])

  const handleResetPreset = useCallback(() => {
    applySourcePreset(null, enabledDataSourceIds)
  }, [applySourcePreset, enabledDataSourceIds])

  const handleAskInWorkspace = useCallback(() => {
    if (!projectId) return
    // A real navigation to a real route, not a mode: the Büro is a place, and
    // `?mount=` is consumed and stripped once there (§7, flow f). Browser back
    // therefore returns to this project's chat intact.
    router.push(`/app/chat?mount=${encodeURIComponent(projectId)}`)
  }, [projectId, router])

  // The refusal is a sentence about the LAST attempt; it must not outlive the
  // panel it was shown in, or a reader who reopens the tree tomorrow reads
  // yesterday's failure as today's state.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (!next) clearMountRefusal()
    },
    [clearMountRefusal]
  )

  const refusalText = mountRefusal
    ? mountRefusal.code === 'cap'
      ? t('workspace.cap.notice', { max: mountRefusal.cap ?? mountCap })
      : mountRefusal.code === 'no_access'
        ? t('workspace.mount.noAccess')
        : mountRefusal.code === 'not_found'
          ? t('workspace.mount.notFound')
          : t('workspace.mount.unavailable')
    : null

  const tree = (
    <ScopeTree
      levels={levels}
      cap={mountCap}
      loading={isWorkspace && mountsLoading && mounts.length === 0}
      pending={mountsPending}
      error={refusalText}
      onMount={handleMount}
      onUnmount={handleUnmount}
      onRetry={conversationId ? () => void loadMounts(conversationId) : undefined}
      onResetPreset={activePreset ? handleResetPreset : undefined}
      onDeepResearch={handleDeepResearch}
      onAskInWorkspace={!isWorkspace && projectId ? handleAskInWorkspace : undefined}
    />
  )

  const chip = (
    <ScopeChip
      variant={isWorkspace ? 'workspace' : 'project'}
      label={isWorkspace ? t('workspace.title') : (projectName ?? t('composer.scopeFallback'))}
      mountedCount={mounts.length}
      disabled={disabled}
    />
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetTrigger asChild>{chip}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto">
          <SheetHeader className="sr-only">
            <SheetTitle>{t('workspace.tree.title')}</SheetTitle>
            <SheetDescription>{t('workspace.tree.hints.base')}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{tree}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{chip}</PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2">
        {tree}
      </PopoverContent>
    </Popover>
  )
}
