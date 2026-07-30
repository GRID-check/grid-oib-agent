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
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/adapters/auth'
import { useChatStore, useLoadJobData } from '@/features/chat'
import { AccessChip } from '@/features/collaboration/components/AccessChip'
import { ParticipantStrip } from '@/features/collaboration/components/ParticipantStrip'
import { ShareDialog } from '@/features/collaboration/components/ShareDialog'
import { useSharing } from '@/features/collaboration/hooks/use-sharing'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '../store'

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
   * Open the inline editor from the menu — one frame later, deliberately.
   *
   * Closing a menu returns focus to its trigger. Mounting the editor in the same
   * frame therefore puts it on screen just in time to be blurred, and blur
   * commits: the editor opened and closed again before anyone could type in it.
   * Waiting a frame lets the menu finish its focus restoration first, so the
   * `isEditingTitle` effect's `focus()` is the last word.
   */
  const startEditingTitleFromMenu = useCallback(() => {
    requestAnimationFrame(startEditingTitle)
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
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 px-3 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
      {/* Center the floating controls on the SAME comfortable column as the
          message list and composer (max-w-3xl, mx-auto), so the pills align to
          the chat window instead of hugging the screen edges on wide viewports. */}
      <div className="mx-auto flex w-full max-w-3xl items-start justify-between gap-3">
      {/* LEFT pill: orientation only — the single history door + the current
          session title/rename, always visible (mobile included). Capped at ~64%
          of the row on mobile so a long title truncates inside the pill instead
          of growing under the right-hand actions pill. */}
      <div className="pointer-events-auto flex min-w-0 max-w-[64%] items-center gap-0.5 rounded-lg border border-base bg-card/70 p-0.5 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/60 sm:max-w-none">
        {/* Global navigation opener — mobile only. The chat route hides the
            standalone top bar, so this hamburger is the way back out to
            projects / files / settings (opens the same AppSidebar drawer). */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-md md:hidden"
          onClick={handleNavClick}
          aria-label={tNav('openNavigation')}
          title={tNav('openNavigation')}
        >
          <Menu className="h-4 w-4" aria-hidden="true" />
        </Button>

        {/* Sessions / history overlay — the one clear door to past sessions
            (the rail keeps its routed History; this doesn't duplicate it). */}
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-md"
          onClick={handleMenuClick}
          disabled={!isAuthenticated}
          aria-label={t('chatToolbar.toggleSessions')}
          title={!isAuthenticated ? t('chatToolbar.signInToView') : t('chatToolbar.toggleSessions')}
        >
          <MessageSquareText className="h-4 w-4" aria-hidden="true" />
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
                    onChange={(e) => setEditedTitle(e.target.value)}
                    onKeyDown={handleTitleKeyDown}
                    onBlur={commitTitle}
                    aria-label={tChat('breadcrumb.renameInputAria')}
                    className="h-7 w-56 max-w-full rounded-md border bg-card px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                ) : (
                  // Plain text, not a button. The title is what this thread IS;
                  // renaming is an action and lives with the other actions, in the
                  // menu. As a button it was the header's least honest element —
                  // styled exactly like the label it also was, with no affordance
                  // to find, so the only people who ever renamed a chat inline were
                  // the ones who clicked it by accident. `title` carries the full
                  // name for the truncated case.
                  <span
                    title={sessionTitle}
                    className="max-w-[420px] truncate px-1 py-0.5 text-sm font-medium text-foreground"
                  >
                    {sessionTitle}
                  </span>
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
          permanent buttons in a 768px row that also has to carry a thread title. */}
      {isChatStarted && (
      <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-base bg-card/70 p-0.5 shadow-xs backdrop-blur supports-[backdrop-filter]:bg-card/60">
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
            pointed at an empty report. */}
        {hasStatus && (
          <div className="hidden items-center gap-1 pl-1 pr-1.5 sm:flex">
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
            {isDeepResearchStreaming && (
              <span
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
                data-testid="research-running"
              >
                <Spinner size="sm" label={t('researchPanel.researching')} />
                <span className="hidden lg:inline">{t('researchPanel.researching')}</span>
              </span>
            )}
            <div aria-hidden="true" className="ml-1 h-5 w-px bg-border" />
          </div>
        )}

        {/* ── CONTROLS ─────────────────────────────────────────────────────────
            New chat: the one action frequent enough to stay in the open. */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-md"
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
          <SquarePen className="h-4 w-4" aria-hidden="true" />
          <span className="hidden text-sm font-medium sm:inline">{t('chatToolbar.newChat')}</span>
        </Button>

        {/* Everything else this thread can do. Each item is here because it is
            occasional, and each still appears only when it is real. */}
        {(canRename || sharingState || hasResearchReport) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                // `sm` (not `icon`) so the trigger keeps the exact height of the
                // labelled button beside it; `w-8 px-0` squares it off.
                size="sm"
                className="w-8 rounded-md px-0"
                aria-label={t('chatToolbar.moreActions')}
                title={t('chatToolbar.moreActions')}
                data-testid="thread-menu"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* Rename — the same inline editor as before, but reachable. It used
                  to be a click on the title with no affordance whatsoever: the one
                  interaction in this header that nobody could discover. */}
              {canRename && (
                <DropdownMenuItem
                  onSelect={startEditingTitleFromMenu}
                  data-testid="rename-session"
                >
                  <PencilLine className="h-4 w-4" aria-hidden="true" />
                  {t('chatToolbar.renameSession')}
                </DropdownMenuItem>
              )}

              {/* Share — the ONE door to the sharing surface (SH-17). Present for
                  every participant, not only owners: a viewer is entitled to see who
                  else is in the room, and it is where they leave from. */}
              {sharingState && (
                <DropdownMenuItem onSelect={() => setIsShareOpen(true)} data-testid="share-button">
                  <Share2 className="h-4 w-4" aria-hidden="true" />
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
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                  {t('chatToolbar.researchReport')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      )}
      </div>

      {/* The sharing surface itself. Mounted only once the thread is reachable and
          the reader has asked for it, so it costs nothing on every other render.
          `pointer-events-auto` is unnecessary here — the dialog portals out of this
          `pointer-events-none` header. */}
      {sharingState && isShareOpen && (
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
