'use client'

/**
 * The GRID application sidebar — the product's primary navigation surface.
 *
 * Composes the shadcn Sidebar primitive (Sheet on mobile, icon-collapse on
 * desktop) rather than owning a drawer, a rail, and collapse itself. IA is
 * still the click-dummy overhaul: "Piloti" wordmark → project switcher →
 * grouped section nav → pinned Settings → user footer. Active section is a
 * raised white card on the sunken rail.
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
import {
  PROJECT_SETTINGS_SECTION,
  railGroups,
  type ProjectSection,
} from './project-sections'

export interface AppSidebarProps {
  projectId: string
  projects: ProjectSwitcherProject[]
  user?: SidebarUser
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
  tCollaboration: (key: string) => string,
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
  const base = `/app/projects/${projectId}`
  const t = useTranslations('nav')
  const tCollaboration = useTranslations('collaboration')
  const { state, isMobile } = useSidebar()
  const { pending: inboxPending } = useInboxBadge(canAccessInbox)

  const storeOpen = useLayoutStore((s) => s.isMobileNavOpen)
  const setStoreOpen = useLayoutStore((s) => s.setMobileNavOpen)

  // Chat owns its top chrome (floating pills), so the global mobile top bar is
  // redundant there — hide it and let the chat toolbar host the nav opener.
  const isChatRoute = pathname === `${base}/chat` || pathname.startsWith(`${base}/chat/`)
  const iconRail = state === 'collapsed' && !isMobile

  useRecordProjectSection(projectId)

  React.useEffect(() => {
    pruneProjectSections(projects.map((project) => project.id))
  }, [projects])

  const groups = railGroups({
    showSkills,
    showModels,
    canAccessArchiv,
    canAccessInbox,
  })
  const navItems = groups.flatMap((group) => group.items)
  const activeItem = [...navItems, PROJECT_SETTINGS_SECTION].find((item) =>
    pathname.startsWith(itemHref(item, base)),
  )

  const openLabel =
    inboxPending > 0
      ? `${t('openNavigation')} — ${
          inboxPending === 1
            ? tCollaboration('inbox.badgeAriaOne')
            : tCollaboration('inbox.badgeAria', { count: inboxPending })
        }`
      : t('openNavigation')

  return (
    <>
      <MobileNavSync pathname={pathname} />

      {/* Slim mobile top bar. Hidden on chat: the toolbar hosts the hamburger. */}
      <header
        className={cn(
          'h-14 w-full shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunken px-3 md:hidden',
          isChatRoute ? 'hidden' : 'flex',
        )}
      >
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setStoreOpen(true)}
            aria-label={openLabel}
            aria-expanded={storeOpen}
            className="relative flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <Menu className="size-5" aria-hidden />
            <InboxBadge
              pending={inboxPending}
              className="absolute top-1 right-1 translate-x-1/3 -translate-y-1/3"
            />
          </button>
          <Link
            href="/app/projects"
            aria-label={t('allProjects')}
            className="rounded-md text-[19px] font-semibold tracking-[-0.015em] text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            Piloti
          </Link>
        </div>
        {activeItem && (
          <span className="truncate text-sm font-medium text-muted-foreground">
            {sectionLabel(activeItem, t, tCollaboration)}
          </span>
        )}
      </header>

      <Sidebar collapsible="icon" aria-label={t('projectNavigation')}>
        <SidebarHeader
          className={cn('gap-0 p-0 pt-[18px]', iconRail ? 'overflow-hidden px-0' : 'px-3')}
        >
          <SidebarBrand iconRail={iconRail} />
          {!iconRail && (
            <div className="mt-[18px]">
              <ProjectSwitcher projects={projects} activeProjectId={projectId} collapsed={false} />
            </div>
          )}
        </SidebarHeader>

        <SidebarContent
          className={cn(
            'mt-5 gap-4',
            // overflow-y-auto here used to replace the primitive's
            // group-data-[collapsible=icon]:overflow-hidden, so labels kept
            // painting past the 64px rail.
            iconRail ? 'overflow-hidden px-0' : 'overflow-y-auto px-3',
          )}
        >
          <nav aria-label={t('projectSections')}>
            {groups.map((group) => {
              const label = t(`sectionGroups.${group.group}`)
              return (
                <SidebarGroup key={group.group} className="p-0">
                  {label && !iconRail ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-0.5" aria-label={label}>
                      {group.items.map((item) => (
                        <RailNavItem
                          key={item.key}
                          item={item}
                          href={navLinkHref(item, base)}
                          active={pathname.startsWith(itemHref(item, base))}
                          label={sectionLabel(item, t, tCollaboration)}
                          badgeCount={item.key === 'inbox' ? inboxPending : 0}
                          tooltip={iconRail}
                        />
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              )
            })}
          </nav>
        </SidebarContent>

        <SidebarFooter
          className={cn('gap-0 p-0 pb-[14px]', iconRail ? 'overflow-hidden px-0' : 'px-3')}
        >
          <div className={cn('mb-2.5', iconRail && 'flex justify-center')}>
            <SidebarMenu className="gap-0.5">
              <RailNavItem
                item={PROJECT_SETTINGS_SECTION}
                href={itemHref(PROJECT_SETTINGS_SECTION, base)}
                active={pathname.startsWith(itemHref(PROJECT_SETTINGS_SECTION, base))}
                label={sectionLabel(PROJECT_SETTINGS_SECTION, t, tCollaboration)}
                badgeCount={0}
                tooltip={iconRail}
              />
            </SidebarMenu>
          </div>

          <div className={cn('pb-2.5', iconRail ? 'flex justify-center' : 'px-1.5')}>
            <ConnectionPresenceIndicator compact={iconRail} />
          </div>

          <div className={cn('border-t border-border pt-3', iconRail && 'flex w-full justify-center')}>
            <SidebarUserMenu
              user={user}
              authRequired={authRequired}
              compact={iconRail}
              canManageOrganization={canManageOrganization}
              canViewOrganization={canViewOrganization}
              canManagePlatform={canManagePlatform}
              canAccessArchiv={canAccessArchiv}
            />
          </div>
        </SidebarFooter>
        <SidebarRail />
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
          'rounded-md focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
          iconRail
            ? 'flex h-7 items-center justify-center'
            : 'text-[19px] font-semibold tracking-[-0.015em] text-foreground',
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
            'flex items-center justify-center rounded-lg text-muted-foreground transition-colors duration-200 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
            iconRail ? 'mt-[18px] h-9 w-10' : 'ml-auto size-7',
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
  item,
  href,
  active,
  label,
  badgeCount,
  tooltip,
}: {
  item: ProjectSection
  href: string
  active: boolean
  label: string
  badgeCount: number
  tooltip: boolean
}) {
  const Icon = item.icon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={tooltip ? label : undefined}
        className={cn(
          'h-9 gap-[11px] rounded-[10px] px-3 text-[13px]',
          'group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!',
          active
            ? 'border border-border bg-card font-medium text-foreground shadow-xs hover:bg-card hover:text-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-muted-foreground',
        )}
      >
        <Link href={href} aria-current={active ? 'page' : undefined}>
          <Icon
            aria-hidden
            className={cn('size-4 shrink-0', active ? 'text-foreground' : 'text-muted-foreground')}
          />
          <span className={cn('truncate', tooltip && 'sr-only')}>{label}</span>
          <InboxBadge
            pending={badgeCount}
            className="ml-auto group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:-top-1 group-data-[collapsible=icon]:-right-1 group-data-[collapsible=icon]:ml-0"
          />
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
