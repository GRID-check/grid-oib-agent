'use client'

/**
 * The GRID application sidebar — the product's primary navigation surface, and
 * since the app-shell change the ONE persistent piece of chrome in `/app`.
 *
 * Composes the shadcn Sidebar primitive (Sheet on mobile, icon-collapse on
 * desktop) rather than owning a drawer, a rail, and collapse itself. IA is
 * still the click-dummy overhaul: "Piloti" wordmark → project switcher →
 * grouped section nav → pinned Settings → user footer. Active section is a
 * raised white card on the sunken rail.
 *
 * PROJECT SCOPE ONLY. The rail earns its 236px by listing one project's
 * sections; above a project the org scope renders a slim header instead
 * (`OrgHeader`), and `AppShellChrome` decides which of the two stands. The
 * org-wide doorways (Archiv, Postfach) still appear here — as the `org` group
 * near the bottom — because they are reachable from inside a project, where
 * they open as sheets above it.
 *
 * Mobile open state is owned by the layout store so the chat toolbar's
 * hamburger can open the same Sheet (`useLayoutStore.setMobileNavOpen`).
 * Collapse persistence lives in the primitive (`grid.sidebar.collapsed`).
 */

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronsLeft, ChevronsRight, Menu } from 'lucide-react'

import { Logo } from '@/components/brand/logo'
import { motion, springGlide } from '@/components/motion'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useTranslations } from '@/i18n'
import { pruneProjectSections, useRecordProjectSection } from '@/hooks/use-last-project-section'
import { useLayoutStore } from '@/features/layout/store'
import { useInboxBadge } from '@/features/collaboration/hooks/use-inbox'
import { InboxBadge } from '@/features/collaboration/components'
import { cn } from '@/lib/utils'
import { ProjectSwitcher, type ProjectSwitcherProject } from './project-switcher'
import { SidebarUserMenu, type SidebarUser } from './sidebar-user-menu'
import { ConnectionPresenceIndicator } from './connection-presence-indicator'
import { PROJECT_SETTINGS_SECTION, railGroups, type ProjectSection } from './project-sections'

/**
 * THE ACTIVE PILL'S SHARED-LAYOUT IDENTITY.
 *
 * Every rail entry that is currently active renders the same `motion.span`
 * under this id, so when the route changes React unmounts one and mounts the
 * other in a single commit and motion glides the chip between them instead of
 * repainting it. That trajectory is the design language's rule 2 — DIRECTION
 * OF TRAVEL: the pill's path says which section you just left and roughly how
 * far back up the rail it is, which is exactly the thing a reader needs to
 * find their way back and the one thing the endpoint alone cannot say.
 *
 * The id is KEYED by rail width, which is load-bearing: collapsing to the icon
 * rail is a size change, not a move. Sharing an id across it would ask motion
 * to animate a 212×36 pill into a 36×36 one, and a shared-layout size change is
 * executed as a `scale`, which visibly smears a 1px border and a 10px radius.
 * Keyed, the pill is re-created at the new size in the same pass the rail
 * resizes in.
 *
 * Within one key every entry is the same width and height, so the animation
 * reduces to a pure vertical translate — no scale, hence no border or radius
 * distortion to correct.
 */
export function railActivePillId(iconRail: boolean): string {
  return `rail-active-project-${iconRail ? 'icon' : 'full'}`
}

export interface AppSidebarProps {
  /** The project whose sections the rail lists. The rail is project scope
   *  only — `AppShellChrome` renders `OrgHeader` above a project instead. */
  projectId: string
  projects: ProjectSwitcherProject[]
  user?: SidebarUser
  /**
   * The organization the reader is acting in. Shown as an eyebrow above their
   * name in the rail footer — every project, the Archiv and the Inbox are
   * scoped to one org, and the rail never said which.
   */
  organizationName?: string | null
  authRequired: boolean
  /** Whether the current user can manage the organization (org admin). */
  canManageOrganization?: boolean
  /**
   * Whether the current user may open the organization page at all. True for
   * every authenticated org member — the org page serves capability subsets
   * (budgets/models/audit) and a member self-usage view, so the nav entry is
   * discoverable even for non-admins (UX-16).
   */
  canViewOrganization?: boolean
  /** Whether the current user is the platform owner (ADR-0016). */
  canManagePlatform?: boolean
  /**
   * Whether the org-wide Archiv is reachable (any member, gated by the
   * `organization-archiv` feature flag — ADR-0024). Also gates the Archiv
   * nav item.
   */
  canAccessArchiv?: boolean
  /** Whether the IFC/BIM model page is enabled (`ifc-models`, ADR-0045). */
  showModels?: boolean
  /** Whether the Agent Skills page is enabled (feature-flagged, default off — ADR-0046). */
  showSkills?: boolean
  /**
   * Whether the inbox is reachable for this reader. Gates the Inbox nav entry —
   * and with it the badge subscription, so a gated reader opens no live
   * connection and issues no request (spec NF-8).
   *
   * Not the collaboration flag since ADR-0042: the inbox also carries
   * operational alerts, and hiding the entry from a tenant without
   * collaboration hid the warning that its storage was filling up.
   *
   * REQUIRED, unlike its neighbours. It used to default to `false`, and two of
   * the three callers — the dev preview and the spec fixture — omitted it, so
   * both silently exercised the HIDDEN state: the entry was missing and the badge
   * subscription never opened, in exactly the two places whose job is to show
   * what the rail looks like. A required prop turns that into a compile error.
   */
  canAccessInbox: boolean
}

/** One rendered rail entry, after both scopes have been reduced to a shape. */
interface RailItemModel {
  key: string
  href: string
  icon: ProjectSection['icon']
  label: string
  active: boolean
  badgeCount: number
}

interface RailGroupModel {
  key: string
  label: string
  items: RailItemModel[]
}

function itemHref(item: ProjectSection, base: string): string {
  return item.href ?? `${base}/${item.segment}`
}

function navLinkHref(item: ProjectSection, base: string): string {
  const href = itemHref(item, base)
  // "Frag Piloti" always opens a FRESH chat (new/empty draft), never the last
  // thread the user left open. `?new=1` is consumed once by the chat client.
  return item.key === 'chat' ? `${href}?new=1` : href
}

function sectionLabel(
  item: ProjectSection,
  t: (key: string) => string,
  tCollaboration: (key: string) => string
): string {
  return item.label ? tCollaboration(item.label.key) : t(`sections.${item.i18nKey}`)
}

export function AppSidebar(props: AppSidebarProps) {
  return (
    <SidebarProvider className="h-auto min-h-0 w-full shrink-0 md:h-full md:w-auto">
      <AppSidebarFrame {...props} />
    </SidebarProvider>
  )
}

function AppSidebarFrame({
  projectId,
  projects,
  user,
  organizationName = null,
  authRequired,
  canManageOrganization = false,
  canViewOrganization = false,
  canManagePlatform = false,
  canAccessArchiv = false,
  showModels = false,
  showSkills = false,
  canAccessInbox,
}: AppSidebarProps) {
  const pathname = usePathname() ?? ''
  const t = useTranslations('nav')
  const tCollaboration = useTranslations('collaboration')
  const { state, isMobile } = useSidebar()
  const { pending: inboxPending } = useInboxBadge(canAccessInbox)

  const storeOpen = useLayoutStore((s) => s.isMobileNavOpen)
  const setStoreOpen = useLayoutStore((s) => s.setMobileNavOpen)

  const base = `/app/projects/${projectId}`

  // Chat owns its top chrome (floating pills), so the global mobile top bar is
  // redundant there — hide it and let the chat toolbar host the nav opener.
  const isChatRoute = pathname === `${base}/chat` || pathname.startsWith(`${base}/chat/`)
  const iconRail = state === 'collapsed' && !isMobile

  useRecordProjectSection(projectId)

  React.useEffect(() => {
    pruneProjectSections(projects.map((project) => project.id))
  }, [projects])

  const projectGroups = railGroups({
    showSkills,
    showModels,
    canAccessArchiv,
    canAccessInbox,
  })

  const groups: RailGroupModel[] = projectGroups.map((group) => ({
    key: group.group,
    label: t(`sectionGroups.${group.group}`),
    items: group.items.map((item) => ({
      key: item.key,
      href: navLinkHref(item, base),
      icon: item.icon,
      label: sectionLabel(item, t, tCollaboration),
      active: pathname.startsWith(itemHref(item, base)),
      badgeCount: item.key === 'inbox' ? inboxPending : 0,
    })),
  }))

  // Split: project work (scrollable) vs org-level + settings (bottom-pinned).
  // The org doorways (Archiv, Inbox) are reachable from inside a project but
  // belong to the organization — they should sit at the bottom of the rail so
  // the project-work list stays focused and the org scope is visually distinct.
  const orgGroup = groups.find((g) => g.key === 'org')
  const workGroups = groups.filter((g) => g.key !== 'org')

  const settingsHref = itemHref(PROJECT_SETTINGS_SECTION, base)
  const activeItem =
    groups.flatMap((group) => group.items).find((item) => item.active) ??
    (pathname.startsWith(settingsHref)
      ? {
          key: 'settings',
          label: sectionLabel(PROJECT_SETTINGS_SECTION, t, tCollaboration),
        }
      : undefined)

  const openLabel =
    inboxPending > 0
      ? `${t('openNavigation')} — ${
          inboxPending === 1
            ? tCollaboration('inbox.badgeAriaOne')
            : tCollaboration('inbox.badgeAria', { count: inboxPending })
        }`
      : t('openNavigation')

  const activePillId = railActivePillId(iconRail)

  return (
    <>
      <MobileNavSync pathname={pathname} />

      {/* Slim mobile top bar. Hidden on chat: the toolbar hosts the hamburger. */}
      <header
        data-scope="project"
        className={cn(
          // The app renders edge-to-edge (`viewportFit: 'cover'` in the root
          // viewport), so a bar pinned to the top of the screen has to say where
          // the screen actually starts. `ChatToolbar` already does this; this bar
          // is the same band on every other section and did not, which put the
          // hamburger under the status bar on a home-screen install and under the
          // notch in landscape. `min-h-14` rather than `h-14`, because the inset
          // has to be able to make the bar taller instead of eating its contents.
          'border-border bg-surface-sunken min-h-14 w-full shrink-0 items-center justify-between gap-2 border-b px-3 pt-[env(safe-area-inset-top)] md:hidden',
          isChatRoute ? 'hidden' : 'flex'
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setStoreOpen(true)}
            aria-label={openLabel}
            aria-expanded={storeOpen}
            className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/60 relative flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2"
          >
            <Menu className="size-5" aria-hidden />
            <InboxBadge
              pending={inboxPending}
              className="absolute right-1 top-1 -translate-y-1/3 translate-x-1/3"
            />
          </button>
          <Link
            href="/app/projects"
            aria-label={t('allProjects')}
            className="text-foreground focus-visible:ring-ring/60 rounded-md text-[19px] font-semibold tracking-[-0.015em] focus-visible:outline-none focus-visible:ring-2"
          >
            Piloti
          </Link>
        </div>
        {activeItem && (
          <span className="text-muted-foreground truncate text-sm font-medium">
            {activeItem.label}
          </span>
        )}
      </header>

      <Sidebar collapsible="icon" data-scope="project" aria-label={t('projectNavigation')}>
        {/* `shrink-0` on the header and footer is load-bearing, not defensive.
            `SidebarContent` between them is `flex-1 basis-0`, whose scaled
            shrink factor is 0 — so under a height deficit the whole deficit
            lands here. Normally `min-height: auto` protects a flex item from
            that, but the `overflow-hidden` these two carry in the icon rail
            (to stop labels painting past 64px) sets the automatic minimum size
            to 0. Without `shrink-0` the footer is squeezed to nothing and, being
            clipped rather than scrollable, crops its last child — the user
            avatar — silently. */}
        <SidebarHeader
          className={cn(
            'shrink-0 gap-0 p-0 pt-[18px]',
            // 14px, so a 36px tile centres at x=32 in the 64px rail — the same
            // axis as the brand mark, the presence dot and the avatar. A zero
            // inset left the icon column flush at x=0 (centre 18) while
            // everything else centred at 32.
            iconRail ? 'overflow-hidden px-3.5' : 'px-3'
          )}
        >
          <SidebarBrand iconRail={iconRail} />
          {!iconRail && (
            // The context slot. `h-9` is the ProjectSwitcher's own height,
            // pinned here so the nav below always starts at the same edge —
            // that 36px is the difference between "the contents changed" and
            // "the page jumped".
            <div className="mt-[18px] flex h-9 items-center">
              <ProjectSwitcher
                projects={projects}
                activeProjectId={projectId}
                collapsed={false}
              />
            </div>
          )}
        </SidebarHeader>

        <SidebarContent
          className={cn(
            'mt-5 gap-4 flex-1',
            // overflow-y-auto here used to replace the primitive's
            // group-data-[collapsible=icon]:overflow-hidden, so labels kept
            // painting past the 64px rail.
            iconRail ? 'overflow-hidden px-3.5' : 'overflow-y-auto px-3'
          )}
        >
          <nav aria-label={t('projectSections')}>
            {workGroups.map((group, index) => (
              <SidebarGroup
                key={group.key}
                className={cn(
                  'p-0',
                  iconRail && index > 0 && 'mt-3'
                )}
              >
                {group.label && !iconRail ? (
                  <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                ) : null}
                <SidebarGroupContent>
                  <SidebarMenu className="gap-0.5" aria-label={group.label}>
                    {group.items.map((item) => (
                      <RailNavItem
                        key={item.key}
                        icon={item.icon}
                        href={item.href}
                        active={item.active}
                        label={item.label}
                        badgeCount={item.badgeCount}
                        tooltip={iconRail}
                        pillId={activePillId}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>

        {/* Bottom-pinned region: org doorways + settings, separated from the
            scrollable project-work list so the org scope is visually distinct
            and always at the bottom of the rail. */}
        <div className={cn('shrink-0 flex flex-col gap-0', iconRail ? 'px-3.5' : 'px-3')}>
          {orgGroup && (
            <>
              <div className="border-border/50 border-t pt-3" />
              <nav aria-label={orgGroup.label}>
                <SidebarGroup className="p-0">
                  {!iconRail && <SidebarGroupLabel>{orgGroup.label}</SidebarGroupLabel>}
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-0.5" aria-label={orgGroup.label}>
                      {orgGroup.items.map((item) => (
                        <RailNavItem
                          key={item.key}
                          icon={item.icon}
                          href={item.href}
                          active={item.active}
                          label={item.label}
                          badgeCount={item.badgeCount}
                          tooltip={iconRail}
                          pillId={activePillId}
                        />
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </nav>
            </>
          )}

          <div className={cn(orgGroup ? 'mt-2.5' : 'mt-1', 'border-border/50 border-t pt-2.5')}>
            <SidebarMenu className="gap-0.5">
              <RailNavItem
                icon={PROJECT_SETTINGS_SECTION.icon}
                href={settingsHref}
                active={pathname.startsWith(settingsHref)}
                label={sectionLabel(PROJECT_SETTINGS_SECTION, t, tCollaboration)}
                badgeCount={0}
                tooltip={iconRail}
                pillId={`${activePillId}-settings`}
              />
            </SidebarMenu>
          </div>
        </div>

        <SidebarFooter
          className={cn(
            'shrink-0 gap-0 p-0 pb-[14px] pt-2',
            iconRail ? 'overflow-hidden px-3.5' : 'px-3'
          )}
        >

          <div className={cn('pb-2.5', iconRail ? 'flex justify-center' : 'px-1.5')}>
            <ConnectionPresenceIndicator compact={iconRail} />
          </div>

          <div
            className={cn('border-border border-t pt-3', iconRail && 'flex w-full justify-center')}
          >
            <SidebarUserMenu
              user={user}
              organizationName={organizationName}
              authRequired={authRequired}
              compact={iconRail}
              canManageOrganization={canManageOrganization}
              canViewOrganization={canViewOrganization}
              canManagePlatform={canManagePlatform}
            />
          </div>
        </SidebarFooter>
        {/* The primitive's own strings are English; the rail is a tab stop now,
            so the one control a keyboard user lands on has to speak the app's
            language like every other. `iconRail` is already the collapse
            control's source of truth two rows up — same state, same wording. */}
        <SidebarRail
          aria-label={t('resizeSidebar')}
          title={iconRail ? t('expandSidebarHint') : t('resizeSidebarHint')}
        />
      </Sidebar>
    </>
  )
}

/**
 * Two-way bind the layout store (chat toolbar hamburger) to the primitive's
 * mobile Sheet. Store changes open/close the Sheet; Sheet dismissals (scrim,
 * Escape, the primitive's close) write back so the store never lies.
 */
function MobileNavSync({ pathname }: { pathname: string }) {
  const storeOpen = useLayoutStore((s) => s.isMobileNavOpen)
  const setStoreOpen = useLayoutStore((s) => s.setMobileNavOpen)
  const { openMobile, setOpenMobile } = useSidebar()
  const prev = React.useRef<{ storeOpen: boolean; openMobile: boolean } | null>(null)

  React.useEffect(() => {
    setStoreOpen(false)
  }, [pathname, setStoreOpen])

  React.useEffect(() => {
    const previous = prev.current
    if (previous === null) {
      prev.current = { storeOpen, openMobile }
      if (storeOpen !== openMobile) setOpenMobile(storeOpen)
      return
    }
    const storeChanged = storeOpen !== previous.storeOpen
    const mobileChanged = openMobile !== previous.openMobile
    prev.current = { storeOpen, openMobile }

    if (storeChanged && storeOpen !== openMobile) {
      setOpenMobile(storeOpen)
    } else if (mobileChanged && openMobile !== storeOpen) {
      setStoreOpen(openMobile)
    }
  }, [storeOpen, openMobile, setOpenMobile, setStoreOpen])

  return null
}

function SidebarBrand({ iconRail }: { iconRail: boolean }) {
  const t = useTranslations('nav')
  const { state, toggleSidebar, isMobile } = useSidebar()
  const collapsed = state === 'collapsed'

  return (
    <div className={cn('flex items-center', iconRail ? 'flex-col' : 'px-1.5')}>
      <Link
        href="/app/projects"
        aria-label={t('allProjects')}
        className={cn(
          'focus-visible:ring-ring/60 rounded-md focus-visible:outline-none focus-visible:ring-2',
          iconRail
            ? 'flex h-7 items-center justify-center'
            : 'text-foreground text-[19px] font-semibold tracking-[-0.015em]'
        )}
      >
        {iconRail ? <Logo kind="logo-only" size="small" /> : 'Piloti'}
      </Link>
      {!isMobile && (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          className={cn(
            'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/60 flex items-center justify-center rounded-lg transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2',
            // Icon rail: exactly a nav tile (36px square), so it lands on the same
            // column and the same grid as the items below instead of reading as a
            // loose glyph floating in the header's dead space. It was `h-9 w-10` —
            // a 40px width that matched nothing else in the rail.
            iconRail ? 'mt-2 size-9' : 'ml-auto size-7'
          )}
        >
          {collapsed ? (
            <ChevronsRight className="size-4" aria-hidden />
          ) : (
            <ChevronsLeft className="size-4" aria-hidden />
          )}
        </button>
      )}
    </div>
  )
}

function RailNavItem({
  icon: Icon,
  href,
  active,
  label,
  badgeCount,
  tooltip,
  pillId,
}: {
  icon: ProjectSection['icon']
  href: string
  active: boolean
  label: string
  badgeCount: number
  tooltip: boolean
  /** Shared-layout identity for the active chip — see {@link railActivePillId}. */
  pillId: string
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={tooltip ? label : undefined}
        className={cn(
          'h-9 gap-[11px] rounded-[10px] px-3 text-[13px]',
          'group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:justify-center',
          // The active SURFACE now lives on the pill below, so every fill the
          // primitive would otherwise paint under it is turned off explicitly —
          // including `data-[active=true]:bg-sidebar-accent`, which the old
          // `bg-card` used to override and which would otherwise reappear the
          // moment that override left. Only the INK stays here: colour and
          // weight are a tween's business, never a spring's.
          active
            ? 'text-foreground hover:bg-transparent hover:text-foreground data-[active=true]:bg-transparent data-[active=true]:text-foreground font-medium data-[active=true]:font-medium'
            : 'text-muted-foreground hover:bg-accent hover:text-muted-foreground'
        )}
      >
        <Link href={href} aria-current={active ? 'page' : undefined}>
          {active && (
            <motion.span
              layoutId={pillId}
              data-slot="rail-active-pill"
              aria-hidden
              // Monochrome BY CONSTRUCTION: this is the exact chip the active
              // item wore before — `border-border bg-card shadow-xs` — lifted
              // off the button and onto its own element. Nothing new is drawn
              // and no colour is introduced; only the ownership of those three
              // classes changed, which is what lets them travel.
              //
              // `absolute inset-0` resolves against the LI, not the anchor: the
              // anchor is `overflow-hidden` (it clips long labels), and an
              // absolutely positioned box whose containing block is an ancestor
              // of the clipper is not clipped by it — the same mechanism that
              // already lets the icon-rail badge sit outside the tile. The li
              // and the anchor are the same box in both rail widths, so this
              // costs no geometry.
              className="border-border bg-card shadow-xs absolute inset-0 rounded-[10px] border"
              // `springGlide`, not `springDrawer`. This chip's travel is
              // whatever the reader's last two routes happen to be — 38px
              // between neighbours, 288px from the top of the column to Inbox
              // at the bottom — and an overshooting spring's PIXEL error scales
              // with that distance. `springDrawer` lands at 0.53px on the short
              // hop and 4.0px on the long one, and 4px on a 38px row pitch is
              // the pill barging into the row above its target. Glide is
              // calibrated to stay under a pixel at any distance.
              transition={springGlide}
            />
          )}
          <Icon
            aria-hidden
            // `relative` on the visible content, rather than a z-index on the
            // pill. Both are then positioned siblings in document order, so the
            // later one paints over the earlier one — no stacking context to
            // create, and no negative z-index, which would fall straight
            // through to behind the rail's own background (`sidebar-container`
            // is the nearest stacking context, and a non-positioned block's
            // background paints ABOVE negative-z children inside it).
            className={cn(
              'relative size-4 shrink-0',
              active ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
          {/* `data-slot`, because the label is no longer the only <span> inside
              this anchor — the active pill is one too. A test (or a stylesheet)
              reaching for "the rail entry's text" should say so rather than
              picking the first span and hoping. */}
          <span
            data-slot="rail-nav-label"
            // `relative` ONLY when the label is visible. `sr-only` sets
            // `position: absolute` to take the text out of flow, and a later
            // `relative` in the cascade beats it — which put a 1px box plus the
            // row's 11px gap back into the icon rail and slid every glyph 5px
            // off the 32px centre line the rail is aligned to. A hidden label
            // has no paint order to fix, so it does not need the class.
            className={cn('truncate', tooltip ? 'sr-only' : 'relative')}
          >
            {label}
          </span>
          <InboxBadge
            pending={badgeCount}
            className="relative ml-auto group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:-right-1 group-data-[collapsible=icon]:-top-1 group-data-[collapsible=icon]:ml-0"
          />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
