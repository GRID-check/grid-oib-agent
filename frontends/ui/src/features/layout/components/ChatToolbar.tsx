'use client'

import {
  type FC,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Menu,
  MessageSquareText,
  MoreHorizontal,
  PencilLine,
  Share2,
  Sparkles,
  SquarePen,
} from 'lucide-react'
import { AnimatePresence, motion, motionQuick } from '@/components/motion'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/adapters/auth'
import { useChatStore, useLoadJobData } from '@/features/chat'
import { AccessChip, namedAudienceCount } from '@/features/collaboration/components/AccessChip'
import { InboxBadge } from '@/features/collaboration/components/InboxBadge'
import { ParticipantStrip } from '@/features/collaboration/components/ParticipantStrip'
import { ShareDialog } from '@/features/collaboration/components/ShareDialog'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { useSharing } from '@/features/collaboration/hooks/use-sharing'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../store'

/**
 * How long after opening the editor from the menu a blur is treated as the menu
 * handing focus back rather than the user leaving the field. Also closed by the
 * first keystroke, since `commitTitle`/`cancelTitleEdit` resolve the edit.
 */
const MENU_FOCUS_GUARD_MS = 250

interface ChatToolbarProps {
  sessionTitle?: string
  /** Active project name — first breadcrumb segment when present. */
  projectName?: string
  onNewSession?: () => void
  isNewSessionDisabled?: boolean
  /**
   * Whether a chat has actually started (messages present / an active thread).
   * The thread/project breadcrumb, New chat and Research controls only appear
   * once this is true — a fresh, empty chat keeps only the quiet navigation
   * affordances (history door + mobile nav opener). Defaults to true so callers
   * that don't yet pass it (and existing specs) keep the full toolbar.
   */
  isChatStarted?: boolean
  /**
   * The conversation the sharing surfaces act on. Passed in rather than read from
   * the chat store so this component keeps taking its inputs as props (and so a
   * preview or a test can drive it without a store).
   */
  conversationId?: string | null
  /**
   * Whether the collaboration feature is on for this org. **Default `false`**: the
   * gate is default-deny like the API's (`requireCollaborationEnabled`), so a
   * caller that has not been taught about sharing yet opens no request and shows no
   * collaboration furniture.
   */
  isCollaborationEnabled?: boolean
  /** The signed-in user, so the roster can mark "you" and Leave knows its target. */
  currentUserId?: string | null
}

export const ChatToolbar: FC<ChatToolbarProps> = memo(function ChatToolbar({
  sessionTitle = '',
  projectName,
  onNewSession,
  isNewSessionDisabled = false,
  isChatStarted = true,
  conversationId = null,
  isCollaborationEnabled = false,
  currentUserId = null,
}) {
  const { isAuthenticated } = useAuth()
  const t = useTranslations('research')
  const tChat = useTranslations('chat')
  const tNav = useTranslations('nav')
  const tCollab = useTranslations('collaboration')
  const toggleSessionsPanel = useLayoutStore((s) => s.toggleSessionsPanel)
  const openMobileNav = useLayoutStore((s) => s.setMobileNavOpen)
  const isResearchPanelOpen = useLayoutStore((s) => s.rightPanel === 'research')
  const isDeepResearchStreaming = useChatStore((s) => s.isDeepResearchStreaming)
  const deepResearchJobId = useChatStore((s) => s.deepResearchJobId)
  // Inline rename reuses the SAME store action the sessions panel uses.
  const currentSessionId = useChatStore((s) => s.currentConversation?.id)
  const updateConversationTitle = useChatStore((s) => s.updateConversationTitle)
  const { loadResearchPanelTab, isLoading: isStreamLoading } = useLoadJobData()

  // Sharing state for this thread. One request per conversation, shared by the
  // strip, the chip and the dialog — the hook is fully inert while the feature is
  // off or there is no reachable conversation (no fetch, no live subscription).
  const isSharingReachable = Boolean(
    isCollaborationEnabled && isAuthenticated && isChatStarted && conversationId,
  )
  const sharing = useSharing('conversation', conversationId ?? null, isSharingReachable)
  const [isShareOpen, setIsShareOpen] = useState(false)
  // Only render the collaboration affordances once the server has actually told us
  // about this thread. A chip guessing "Privat" before the answer arrives would be
  // a claim about access control made without evidence.
  const sharingState = isSharingReachable ? sharing.state : null
  // A failed load must not make Share vanish silently — the dialog renders its
  // own retry alert, so the menu item stays reachable while `loadError` is set.
  const canShare = Boolean(sharingState || (isSharingReachable && sharing.loadError))
  // The chat route hides the global mobile top bar, so this hamburger is where a
  // phone user learns that somebody needs them — the badge belongs on it for the
  // same reason it sits on the rail hamburger everywhere else.
  const { pending: inboxPending } = useInboxBadge(isCollaborationEnabled && isAuthenticated)

  // Inline title editing state (Enter commits / Escape cancels / blur commits).
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editedTitle, setEditedTitle] = useState(sessionTitle)
  const titleInputRef = useRef<HTMLInputElement>(null)
  // Blur fires after Escape/Enter too — this ref suppresses the double-commit.
  const editResolvedRef = useRef(false)

  useEffect(() => {
    if (isEditingTitle) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [isEditingTitle])

  const canRename = isAuthenticated && !!currentSessionId && !!updateConversationTitle

  // Is there a report to go back to? A job on this thread (restored with the
  // conversation, so it survives a reload), one running now, or the panel already
  // open — the last so the entry can still close what it opened.
  const hasResearchReport = Boolean(
    deepResearchJobId || isDeepResearchStreaming || isResearchPanelOpen,
  )

  /**
   * Who can read this thread — answered by exactly ONE of two forms, never both.
   *
   * Which one is not a style choice; it is which form is TRUE of the audience:
   *
   *   `private`            the audience IS the roster. It was enumerated, person
   *                        by person, so the faces are the whole answer and a
   *                        "Geteilt mit 2" chip beside them is that same sentence
   *                        a second time.
   *   `project` / `organization`
   *                        the audience IS the rule. Nobody enumerated it, and it
   *                        keeps changing as people join the project — so faces
   *                        there are not a summary of it but a partial sample of
   *                        it, which reads as "these three can see it" when the
   *                        truth is "everyone in the project can".
   *
   * The named exceptions under a blanket rule are real, and they are shown where
   * there is room to explain them: the sharing surface, which states the rule and
   * the exceptions together (SH-17/SH-18).
   */
  const showFaces = sharingState?.visibility === 'private'
  const showAccessChip = Boolean(sharingState && sharingState.visibility !== 'private')

  // Does the status group have anything to say? A solo private thread has neither
  // form to show — with nothing running, the group would be a bare separator.
  const hasStatus = Boolean(
    isDeepResearchStreaming ||
      showAccessChip ||
      (showFaces && (sharingState?.entries.length ?? 0) > 1),
  )

  const startEditingTitle = useCallback(() => {
    if (!canRename) return
    setEditedTitle(sessionTitle)
    editResolvedRef.current = false
    setIsEditingTitle(true)
  }, [canRename, sessionTitle])

  /**
   * Open the inline editor from the menu.
   *
   * Closing a menu returns focus to its trigger, which lands on the editor we just
   * opened as a blur — and blur commits, so the editor opened and closed again
   * before anyone could type in it.
   *
   * Two orderings were tried and both were wrong, because ordering is the wrong
   * tool: deferring the open by a frame put it at the mercy of whatever else owns
   * the frame loop (the pill animates), and deferring by a task still raced the
   * menu's own restoration, so the editor opened *usually*. What is actually true
   * here is simpler — a blur arriving in the first moments after the menu closed
   * is the menu handing focus back, not the user leaving the field. So the editor
   * ignores exactly that blur and takes focus back, and is correct whichever
   * order the two land in. The window is short enough that no real departure can
   * fall inside it (nobody clicks away in a quarter second) and it is closed by
   * the first keystroke regardless.
   */
  const focusGuardUntilRef = useRef(0)

  const startEditingTitleFromMenu = useCallback(() => {
    focusGuardUntilRef.current = Date.now() + MENU_FOCUS_GUARD_MS
    startEditingTitle()
  }, [startEditingTitle])

  const commitTitle = useCallback(() => {
    if (editResolvedRef.current) return
    editResolvedRef.current = true
    setIsEditingTitle(false)
    const trimmed = editedTitle.trim()
    if (trimmed && trimmed !== sessionTitle && currentSessionId && updateConversationTitle) {
      updateConversationTitle(currentSessionId, trimmed)
    }
  }, [editedTitle, sessionTitle, currentSessionId, updateConversationTitle])

  const handleTitleBlur = useCallback(() => {
    // Time-boxed, not once-only: the menu's teardown can reach for focus more than
    // once, so disarming after the first blur just loses the second one.
    if (Date.now() < focusGuardUntilRef.current) {
      // Take focus back on a LATER task. Calling `focus()` from inside the blur
      // dispatch re-enters it, and the two bounce off each other until the stack
      // gives out.
      setTimeout(() => titleInputRef.current?.focus(), 0)
      return
    }
    commitTitle()
  }, [commitTitle])

  const cancelTitleEdit = useCallback(() => {
    editResolvedRef.current = true
    setIsEditingTitle(false)
    setEditedTitle(sessionTitle)
  }, [sessionTitle])

  const handleTitleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitTitle()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        cancelTitleEdit()
      }
    },
    [commitTitle, cancelTitleEdit]
  )

  const handleMenuClick = useCallback(() => {
    if (isAuthenticated) toggleSessionsPanel()
  }, [toggleSessionsPanel, isAuthenticated])

  // Opens the global navigation drawer (AppSidebar). On mobile the chat route
  // hides the standalone top bar, so this is the way back out to projects,
  // files, settings, etc.
  const handleNavClick = useCallback(() => {
    openMobileNav(true)
  }, [openMobileNav])

  const handleResearchClick = useCallback(() => {
    if (!isAuthenticated) return
    const { rightPanel, closeRightPanel, openRightPanel, researchPanelTab } =
      useLayoutStore.getState()
    if (rightPanel === 'research') {
      closeRightPanel()
      return
    }
    openRightPanel('research')
    // Re-hydrate the active tab from the job when one exists (same behavior
    // the panel's own toggle tag had before it moved into the toolbar).
    if (deepResearchJobId && !isStreamLoading) {
      void loadResearchPanelTab(deepResearchJobId, researchPanelTab)
    }
  }, [isAuthenticated, deepResearchJobId, isStreamLoading, loadResearchPanelTab])

  const handleNewSessionClick = useCallback(() => {
    if (!isAuthenticated || isNewSessionDisabled) return
    onNewSession?.()
  }, [isAuthenticated, isNewSessionDisabled, onNewSession])

  return (
    // Floating controls: no band, no background strip. The chat plane runs to
    // the very top edge and scrolls behind these; the controls ride above it as
    // two self-contained pills. `pointer-events-none` on the frame lets clicks
    // fall through the gaps to the messages; each pill re-enables them.
    //
    // The split is by KIND, and it is the thing that keeps the row readable:
    //
    //   LEFT  — orientation. Where am I: past sessions, and this thread's name.
    //           Everything here is elastic and gets ALL the leftover width.
    //   RIGHT — the people in the room and the ways out of it. Everything here
    //           is fixed-width.
    //
    // Mixing the two is what crowded this row. The participant faces and the
    // access chip used to sit in the LEFT pill, "next to what the thread IS" —
    // but they are fixed-width status, so every face was taken directly out of
    // the thread's own title, until on a phone the stack overflowed the pill and
    // clipped the title to a single glyph. Status now sits with the actions,
    // where a fixed width costs the title nothing.
    //
    // The other half of the crowding was duplicate doors. This header does not
    // own the research report — the answer card that produced it does
    // (`AgentResponse`'s "view report", which reconnects the right job and picks
    // the right tab), and the panel closes from its own X and from Escape. So
    // the toggle here is the *re-entry* for a report you already have, and it
    // appears only when this thread actually has one.
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 min-h-14 px-3 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
      {/* Center the floating controls on the SAME comfortable column as the
          message list and composer (max-w-3xl, mx-auto), so the pills align to
          the chat window instead of hugging the screen edges on wide viewports. */}
      <div className="mx-auto flex w-full max-w-3xl items-start justify-between gap-3">
      {/* LEFT pill: orientation only — the single history door + the current
          session title/rename, always visible (mobile included). Capped at ~64%
          of the row on mobile so a long title truncates inside the pill instead
          of growing under the right-hand actions pill.
          min-h-12 matches the 44px/36px controls so the pill never collapses
          when the breadcrumb is hidden on an empty chat. */}
      {/* The alpha pair is load-bearing: this toolbar FLOATS over the scrolling
          transcript, and `backdrop-blur` needs something to blur. The
          `supports-` step drops to a more opaque fill where there is no blur. */}
      <div className="pointer-events-auto flex min-h-12 min-w-0 max-w-[64%] items-center gap-0.5 rounded-lg border border-base bg-card/70 p-0.5 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/60 sm:max-w-none">
        {/* Global navigation opener — mobile only. The chat route hides the
            standalone top bar, so this hamburger is the way back out to
            projects / files / settings (opens the same AppSidebar drawer). */}
        <Button
          variant="ghost"
          size="icon"
          className="relative size-11 shrink-0 rounded-md sm:size-9 md:hidden"
          onClick={handleNavClick}
          aria-label={
            inboxPending > 0
              ? `${tNav('openNavigation')} — ${
                  inboxPending === 1
                    ? tCollab('inbox.badgeAriaOne')
                    : tCollab('inbox.badgeAria', { count: inboxPending })
                }`
              : tNav('openNavigation')
          }
          title={tNav('openNavigation')}
        >
          <Menu className="size-4" aria-hidden="true" />
          <InboxBadge
            pending={inboxPending}
            className="absolute top-0.5 right-0.5 translate-x-1/3 -translate-y-1/3"
          />
        </Button>

        {/* Sessions / history overlay — the one clear door to past sessions
            (the rail keeps its routed History; this doesn't duplicate it). */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-md sm:size-9"
          onClick={handleMenuClick}
          disabled={!isAuthenticated}
          aria-label={t('chatToolbar.toggleSessions')}
          title={!isAuthenticated ? t('chatToolbar.signInToView') : t('chatToolbar.toggleSessions')}
        >
          <MessageSquareText className="size-4" aria-hidden="true" />
        </Button>

        {/* Breadcrumb: {project} / {session title (click-to-rename)} — shown
            once a chat has started so the current thread is identifiable. On a
            fresh, empty chat there is no thread to name yet, so it stays hidden
            to keep the start screen calm. */}
        {isChatStarted && (sessionTitle || projectName) && (
          <nav
            className="flex min-w-0 items-center gap-1.5 pl-1 pr-1.5 text-sm"
            aria-label={tChat('breadcrumb.ariaLabel')}
          >
              {projectName ? (
                <>
                  {/* On mobile the project name is redundant with the composer
                      scope chip, so when a session title is present we hide it
                      to give the title room. With no title yet, it stays so the
                      pill isn't just a bare icon.

                      `shrink-0` is load-bearing. Without it both breadcrumb
                      segments are shrinkable flex children, so a crowded row
                      squeezes them PROPORTIONALLY and the project collapses to
                      "Test…" — an ellipsis that names nothing while still
                      charging for the space and the separator. Fixed at its own
                      cap it either reads or it does not appear; the title is the
                      one segment that flexes.

                      The cap is deliberately modest. The project is CONTEXT — the
                      composer's scope chip, the rail and the URL all name it too —
                      while the session title is the only place this thread is
                      named at all, so the project must be the cheap segment. */}
                  <span
                    className={`max-w-24 shrink-0 truncate text-muted-foreground sm:max-w-28 lg:max-w-40 ${
                      sessionTitle ? 'hidden sm:inline' : ''
                    }`}
                  >
                    {projectName}
                  </span>
                  {sessionTitle ? (
                    <span
                      className="hidden text-muted-foreground/60 sm:inline"
                      aria-hidden="true"
                    >
                      /
                    </span>
                  ) : null}
                </>
              ) : null}
              {sessionTitle ? (
                isEditingTitle ? (
                  <input
                    ref={titleInputRef}
                    value={editedTitle}
                    onChange={(e) => {
                      // The first keystroke ends the menu-handover guard: once the
                      // user is typing, every blur after it is genuinely theirs.
                      focusGuardUntilRef.current = 0
                      setEditedTitle(e.target.value)
                    }}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={handleTitleBlur}
                    aria-label={tChat('breadcrumb.renameInputAria')}
                    className="h-11 w-56 max-w-full rounded-md border bg-card px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:h-9"
                  />
                ) : (
                  // Click-to-rename, kept as the SHORTCUT rather than as the only
                  // way in. On its own it was the header's least honest element:
                  // styled exactly like the label it also was, so nobody could
                  // discover it. The menu entry is now the discoverable path and
                  // this is the fast one for people who know it — which is why it
                  // carries a hover fill and a text cursor, the two hints that make
                  // the click findable for anyone who happens to pass over it.
                  <button
                    type="button"
                    onClick={startEditingTitle}
                    disabled={!canRename}
                    aria-label={tChat('breadcrumb.renameAria')}
                    title={canRename ? tChat('breadcrumb.renameAria') : sessionTitle}
                    className="max-w-[420px] truncate rounded-md px-1 py-0.5 pointer-coarse:py-3 text-left text-sm font-medium text-foreground transition-colors duration-quick ease-out motion-reduce:transition-none enabled:cursor-text enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {sessionTitle}
                  </button>
                )
              ) : null}
          </nav>
        )}

      </div>

      {/* RIGHT pill: what is TRUE about this thread, then what you can DO to it,
          with a hairline between the two. Hidden until a chat has started — on the
          empty start screen New chat is redundant, there is no thread to share and
          no report to reopen.

          The separation is the point. This row used to mix the two kinds freely,
          and worse, it mixed them in a way that made each LIE about itself: the
          avatar stack looks like status and was a button, while the access chip
          looks like every other chip in the app and is `role="img"`. A reader
          could not tell what would respond to a click without trying. So:

            · everything before the hairline is INFORMATION. Not clickable, ever.
            · everything after it is a CONTROL, and looks like one.

          The second rule is that only the most frequent control stays in the open.
          New chat earns that. Share, rename and the research report are occasional
          and go in the one menu — progressive disclosure rather than three more
          permanent buttons in a 768px row that also has to carry a thread title.

          Arrivals fade (opacity only). Width is reserved by the controls that
          stay mounted — layout/width animation was a spring that bounced the
          New-chat button sideways. Reduced motion is handled globally by
          <MotionConfig reducedMotion="user">. */}
      {isChatStarted && (
      <div className="pointer-events-auto flex min-h-12 shrink-0 items-center gap-0.5 rounded-lg border border-base bg-card/70 p-0.5 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/60">
        {/* ── STATUS ────────────────────────────────────────────────────────────
            Who can reach this thread, stated ONCE, in whichever of the two forms is
            true of the audience (see `showFaces` / `showAccessChip` above), and
            never clickable. A solo private thread gets neither — the same doctrine
            ParticipantStrip already applies to itself: no collaboration furniture
            where nothing is being collaborated on.

            Desktop-only, the sharing marks: a phone's width belongs to the
            thread's name, and the menu below carries sharing there.

            The group renders only when it has something to SAY — a hairline with
            nothing in front of it is the same empty claim as the button that
            pointed at an empty report.

            It arrives late by nature (the roster is a fetch), so it fades and
            settles in rather than blinking into place. `initial={false}` on the
            presence keeps that for CHANGES only: a thread you open with the roster
            already known must not replay the animation. */}
        <AnimatePresence initial={false}>
        {hasStatus && (
          <motion.div
            key="status"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionQuick}
            className="hidden items-center gap-1 pl-1 pr-1.5 sm:flex"
          >
            {/* No `onOpen`: the strip is deliberately inert here. Sharing has ONE
                door in this header and it is the menu item, so the faces can be
                read as what they are. */}
            {showFaces && sharingState && (
              <ParticipantStrip entries={sharingState.entries} currentUserId={currentUserId} />
            )}
            {showAccessChip && sharingState && (
              <AccessChip visibility={sharingState.visibility} />
            )}
            {/* Live research is status too, and the one piece of it worth carrying
                in the header: the thread's own banner scrolls away, and this is
                then the only persistent "still working" signal. It states, it does
                not act — the report is in the menu. Independent of sharing: a solo
                thread researches just as often as a shared one. */}
            <AnimatePresence initial={false}>
              {isDeepResearchStreaming && (
                <motion.span
                  key="running"
                  // Opacity only — a width tween is layout motion and shoves
                  // the New-chat control. The reserved min-h-12 on the pill
                  // keeps the row from collapsing when this leaves.
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={motionQuick}
                  className="inline-flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm text-muted-foreground"
                  data-testid="research-running"
                >
                  <Spinner size="sm" label={t('researchPanel.researching')} />
                  <span className="hidden lg:inline">{t('researchPanel.researching')}</span>
                </motion.span>
              )}
            </AnimatePresence>
            <div aria-hidden="true" className="ml-1 h-5 w-px bg-border" />
          </motion.div>
        )}
        </AnimatePresence>

        {/* ── CONTROLS ─────────────────────────────────────────────────────────
            New chat: the one action frequent enough to stay in the open. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-11 gap-1.5 rounded-md px-3 sm:h-9"
          onClick={handleNewSessionClick}
          disabled={!isAuthenticated || isNewSessionDisabled}
          aria-label={t('chatToolbar.createNewSession')}
          title={
            !isAuthenticated
              ? t('chatToolbar.signInToCreate')
              : isNewSessionDisabled
                ? t('chatToolbar.cannotCreateActive')
                : t('chatToolbar.createNewSession')
          }
        >
          <SquarePen className="size-4" aria-hidden="true" />
          <span className="hidden text-sm font-medium sm:inline">{t('chatToolbar.newChat')}</span>
        </Button>

        {/* Everything else this thread can do. Each item is here because it is
            occasional, and each still appears only when it is real.

            Its own hairline: the same mark that separates what is TRUE from what
            you can DO now also separates the one action kept in the open from the
            drawer holding the rest, so the pill reads as three plain groups
            instead of a run of controls. Drawn only with the menu it precedes —
            a divider with nothing after it is a promise of something missing. */}
        {(canRename || canShare || hasResearchReport) && (
          <>
          <div aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                // Square, and the SAME height as every other control in both
                // pills — 44px where a finger has to land it, 36px on a pointer
                // device. The two pills are only as tall as their tallest control,
                // so any control that opts out of this pair makes one pill taller
                // than the other and the row stops lining up.
                size="sm"
                className="size-11 rounded-md px-0 sm:size-9"
                aria-label={t('chatToolbar.moreActions')}
                title={t('chatToolbar.moreActions')}
                data-testid="thread-menu"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* The audience, restated for phones: below `sm` the status marks in
                  the header are hidden (the width belongs to the thread's name),
                  and a menu that offers "Teilen" without ever saying WHO can read
                  the thread leaves the one question sharing exists to answer
                  unanswerable without opening the dialog. */}
              {sharingState && (
                <div className="px-2 py-1.5 sm:hidden">
                  <DropdownMenuLabel className="p-0 pb-1">
                    <SectionLabel>{tCollab('sharing.audienceHeading')}</SectionLabel>
                  </DropdownMenuLabel>
                  <AccessChip
                    visibility={sharingState.visibility}
                    sharedWith={namedAudienceCount(sharingState.entries, currentUserId)}
                  />
                </div>
              )}
              {sharingState && <DropdownMenuSeparator className="sm:hidden" />}
              {/* Rename — the discoverable path to the same inline editor the
                  title's own click opens. The click stays as the shortcut; this is
                  how anyone finds out it exists. */}
              {canRename && (
                <DropdownMenuItem
                  onSelect={startEditingTitleFromMenu}
                  data-testid="rename-session"
                >
                  <PencilLine className="size-4" aria-hidden="true" />
                  {t('chatToolbar.renameSession')}
                </DropdownMenuItem>
              )}

              {/* Share — the ONE door to the sharing surface (SH-17). Present for
                  every participant, not only owners: a viewer is entitled to see who
                  else is in the room, and it is where they leave from. Also present
                  after a failed load: the dialog renders the retry alert, a vanished
                  menu item gives the reader nothing. */}
              {canShare && (
                <DropdownMenuItem onSelect={() => setIsShareOpen(true)} data-testid="share-button">
                  <Share2 className="size-4" aria-hidden="true" />
                  {tCollab('sharing.action')}
                </DropdownMenuItem>
              )}

              {/* Research report — the way BACK to a report this thread already
                  has, for when you have closed the panel and scrolled on. It is
                  deliberately not the primary door: the answer card that produced
                  the report owns that (`AgentResponse` reconnects the right job and
                  opens the right tab), and the panel closes from its own X and from
                  Escape. So it appears only when there is something to go back to —
                  a job on this thread (restored with the conversation, so it
                  survives a reload), one streaming now, or the panel already open.
                  On a thread that never ran deep research, a permanent "Recherche"
                  button was a door to an empty room. */}
              {hasResearchReport && (
                <DropdownMenuItem
                  onSelect={handleResearchClick}
                  disabled={!isAuthenticated}
                  aria-expanded={isResearchPanelOpen}
                  data-testid="research-panel-toggle"
                >
                  <Sparkles className="size-4" aria-hidden="true" />
                  {t('chatToolbar.researchReport')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          </>
        )}
      </div>
      )}
      </div>

      {/* The sharing surface itself. Mounted only once the thread is reachable and
          the reader has asked for it, so it costs nothing on every other render.
          `pointer-events-auto` is unnecessary here — the dialog portals out of this
          `pointer-events-none` header. The dialog owns the loading skeleton and the
          load-error retry alert, so it mounts whenever the door is open — not only
          when a state has already landed. */}
      {isSharingReachable && isShareOpen && conversationId && (
        <ShareDialog
          open={isShareOpen}
          onOpenChange={setIsShareOpen}
          resourceId={conversationId}
          sharing={sharing}
          currentUserId={currentUserId}
        />
      )}
    </header>
  )
})
