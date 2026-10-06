'use client'

/**
 * „Ordner ohne gültige Rolle" in the project settings (ADR-0079).
 *
 * A folder whose own access list names only roles that were deleted since
 * matches nobody, so only organization admins read it. This says so and links
 * each such folder, where its access dialog sets a valid role again. Shown to a
 * project manager and only when there is something to show; the list is already
 * limited to folders that reader may see.
 */

import type { FC } from 'react'
import Link from 'next/link'
import { AlertTriangle, FolderLock } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useTranslations } from '@/i18n'
import type { FolderWithoutRole } from '../types'

interface FoldersWithoutRoleProps {
  projectId: string
  folders: readonly FolderWithoutRole[]
}

export const FoldersWithoutRole: FC<FoldersWithoutRoleProps> = ({ projectId, folders }) => {
  const t = useTranslations('settings')
  if (folders.length === 0) return null
  return (
    <section aria-label={t('project.foldersWithoutRole.title')} data-testid="folders-without-role">
      <Alert variant="warning">
        <AlertTriangle aria-hidden />
        <AlertTitle className="line-clamp-none">{t('project.foldersWithoutRole.title')}</AlertTitle>
        <AlertDescription className="flex flex-col gap-2">
          <p>{t('project.foldersWithoutRole.description')}</p>
          <ul className="flex flex-col gap-1">
            {folders.map((folder) => (
              <li key={folder.id}>
                <Link
                  href={`/app/projects/${encodeURIComponent(projectId)}/files?folder=${encodeURIComponent(folder.id)}`}
                  className="inline-flex items-center gap-1.5 font-medium underline underline-offset-2"
                  aria-label={t('project.foldersWithoutRole.open', { name: folder.name })}
                  data-testid="folder-without-role-link"
                >
                  <FolderLock className="size-4" aria-hidden />
                  {folder.name}
                </Link>
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    </section>
  )
}
