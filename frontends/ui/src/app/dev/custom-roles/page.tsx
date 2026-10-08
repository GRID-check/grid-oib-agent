'use client'

/**
 * Dev preview for Organisation → Personen & Zugriff → Eigene Rollen (ADR-0087).
 * Renders the REAL section with fixtures and no backend.
 *
 * The editor is a User Admin: they may manage roles and hold the Archiv and
 * People permissions, but not AI models or budgets, so the role editor shows
 * those boxes disabled with the reason. „Geschäftsführung" already carries
 * „KI-Modelle verwalten", which stays changeable (taking away grants nothing).
 *
 * A module-scope fetch shim (browser + dev only) serves the roles listing and
 * applies create, edit and delete to an in-memory list, so the round trip can
 * be tried. Deleting „Projektleitung" answers 409 (still assigned).
 *
 * Deleting „Geschäftsführung" (ADR-0087) shows the folders that name it and
 * deletes only with the confirmation (`?confirmFolders=1`); `?usage=hidden` is
 * the role manager who may not read those folders, who is told how many.
 *
 * `?dialog=create` and `?dialog=edit` open the editor on load, for captures;
 * `?dialog=delete` opens the deletion confirmation of „Geschäftsführung".
 * Not linked from anywhere and 404s outside development.
 */

import type { JSX } from 'react'
import { useEffect } from 'react'
import { notFound, useSearchParams } from 'next/navigation'

import type { AssignablePermission, OrganizationRole } from '@/adapters/api/organization-roles-client'
import { CustomRolesSection } from '@/features/organization/components/custom-roles-section'

const ROLES: OrganizationRole[] = [
  {
    slug: 'org-geschaeftsfuehrung',
    name: 'Geschäftsführung',
    description: 'Sieht Honorarvereinbarungen, Verträge und Personalakten.',
    custom: true,
    permissions: ['org:archiv:manage', 'org:models:manage', 'org:projects:administer'],
  },
  {
    slug: 'org-projektleitung',
    name: 'Projektleitung',
    description: null,
    custom: true,
    permissions: ['org:projects:create'],
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Verwaltet die gesamte Organisation.',
    custom: false,
    permissions: Array.from({ length: 16 }, (_, i) => `org:p${i}`),
  },
  {
    slug: 'member',
    name: 'Member',
    description: 'Arbeitet in den Projekten, in die sie oder er aufgenommen ist.',
    custom: false,
    permissions: ['org:projects:create'],
  },
  {
    slug: 'org-auditor',
    name: 'Auditor',
    description: 'Liest den Audit-Trail.',
    custom: false,
    permissions: ['org:audit:view'],
  },
]

/** The folders whose own list names „Geschäftsführung"; the admin may read them. */
const FOLDERS_USING = [
  { folderId: 'f-honorare', folderName: 'Honorare', projectId: 'p-sued', projectName: 'Schule Süd' },
  { folderId: 'f-vertraege', folderName: 'Verträge', projectId: 'p-sued', projectName: 'Schule Süd' },
  { folderId: 'f-personal', folderName: 'Personal', projectId: 'p-halle', projectName: 'Halle 3' },
]

const HELD = new Set(['org:archiv:manage', 'org:members:manage', 'org:projects:create', 'org:skills:manage'])
const ASSIGNABLE: AssignablePermission[] = [
  'org:settings:manage',
  'org:models:manage',
  'org:budgets:manage',
  'org:compliance:manage',
  'org:audit:view',
  'org:archiv:manage',
  'org:skills:manage',
  'org:projects:create',
  'org:projects:administer',
  'org:members:manage',
].map((slug) => ({ slug, grantable: HELD.has(slug) }))

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __customRolesShim?: boolean }
  if (!w.__customRolesShim) {
    w.__customRolesShim = true
    const roles = [...ROLES]
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith('/api/organization/roles')) return real(input, init)
      const method = init?.method ?? 'GET'
      const rest = (url.split('/api/organization/roles/')[1] ?? '').split('?')[0]
      const slug = decodeURIComponent(rest.split('/')[0] ?? '')
      if (method === 'GET' && rest.endsWith('/usage')) {
        const hidden = new URLSearchParams(window.location.search).get('usage') === 'hidden'
        return Response.json({ total: FOLDERS_USING.length, folders: hidden ? [] : FOLDERS_USING })
      }
      if (method === 'GET') return Response.json({ roles, assignable: ASSIGNABLE })
      if (method === 'DELETE') {
        if (slug === 'org-geschaeftsfuehrung' && !url.includes('confirmFolders=1')) {
          return Response.json(
            { error: { message: 'folders' }, details: { reason: 'role-used-by-folders', total: FOLDERS_USING.length } },
            { status: 409 }
          )
        }
        if (slug === 'org-projektleitung') {
          return Response.json({ error: { message: 'still assigned' } }, { status: 409 })
        }
        roles.splice(
          roles.findIndex((role) => role.slug === slug),
          1
        )
        return Response.json({ slug })
      }
      const body = JSON.parse(String(init?.body)) as Partial<OrganizationRole>
      if (method === 'POST') {
        const created: OrganizationRole = {
          slug: `org-${String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name: String(body.name),
          description: body.description ?? null,
          custom: true,
          permissions: body.permissions ?? [],
        }
        roles.unshift(created)
        return Response.json({ role: created }, { status: 201 })
      }
      const index = roles.findIndex((role) => role.slug === slug)
      roles[index] = { ...roles[index], ...body }
      return Response.json({ role: roles[index] })
    }
  }
}

export default function CustomRolesDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return <CustomRolesPreview />
}

function CustomRolesPreview(): JSX.Element {
  const dialog = useSearchParams()?.get('dialog')

  // The editor is internal state of the section, so a capture opens it the
  // way a person would: by pressing the control, once the list has loaded.
  useEffect(() => {
    if (!dialog) return
    const testId =
      dialog === 'edit'
        ? 'custom-role-edit-org-geschaeftsfuehrung'
        : dialog === 'delete'
          ? 'custom-role-delete-org-geschaeftsfuehrung'
          : 'custom-role-create'
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      if (!button) return
      window.clearInterval(timer)
      button.click()
    }, 100)
    return () => window.clearInterval(timer)
  }, [dialog])

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-8" data-testid="custom-roles-preview">
      <div>
        <h1 className="text-lg font-semibold">Organisation — Eigene Rollen</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ADR-0087: an office&apos;s own roles in WorkOS, as a User Admin without the models or budgets permission
          sees them.
        </p>
      </div>
      <CustomRolesSection />
    </main>
  )
}
