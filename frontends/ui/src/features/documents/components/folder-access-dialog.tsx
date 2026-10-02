'use client'

/**
 * „Zugriff auf …": who in the project may see one folder (ADR-0078).
 *
 * One question with two answers: everyone in the project, or only people
 * holding one of some roles. The roles are the organization's (WorkOS), the
 * office's own beside Piloti's. The dialog says the three things the reader
 * cannot see from here: saving moves and re-reads the folder's documents, a
 * restriction to roles you do not hold hides the folder from you too, and a
 * building model in a restricted folder is not yet fully protected.
 *
 * The PUT is the authority. It answers 404 for a reader who may not manage the
 * project, refuses a role the organization does not have, and reports how many
 * documents moved and which did not.
 */

import { type FC, useMemo, useState } from 'react'
import { AlertTriangle, Lock, Users } from 'lucide-react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import { setFolderAccess, type FolderAccessResult } from '@/adapters/api/folder-access-client'
import type { OrganizationRoles } from '@/adapters/api/organization-roles-client'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import type { FolderItem } from './project-file-workspace'

type Mode = 'everyone' | 'restricted'

export interface FolderAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** The folder being changed; the dialog renders nothing without one. */
  folder: FolderItem | null
  /** The organization's roles, or null while they load. */
  roles: OrganizationRoles | null
  rolesFailed?: boolean
  onRetryRoles?: () => void
  onSaved: (result: FolderAccessResult) => void
}

export const FolderAccessDialog: FC<FolderAccessDialogProps> = ({ open, onOpenChange, folder, ...rest }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {folder && (
      <FolderAccessForm
        key={`${folder.id}-${(folder.restrictedRoles ?? []).join(',')}-${open}`}
        folder={folder}
        onClose={() => onOpenChange(false)}
        {...rest}
      />
    )}
  </Dialog>
)

const FolderAccessForm: FC<
  Omit<FolderAccessDialogProps, 'open' | 'onOpenChange' | 'folder'> & { folder: FolderItem; onClose: () => void }
> = ({ folder, projectId, roles, rolesFailed = false, onRetryRoles, onSaved, onClose }) => {
  const t = useTranslations('files')
  const tc = useTranslations('common')
  const initialRoles = useMemo(() => folder.restrictedRoles ?? [], [folder.restrictedRoles])
  const [mode, setMode] = useState<Mode>(initialRoles.length > 0 ? 'restricted' : 'everyone')
  const [selected, setSelected] = useState<string[]>(initialRoles)
  const [saving, setSaving] = useState(false)

  // The organization's roles, plus any the folder names that no longer exist
  // (a deleted role): shown so they can be taken off, never offered fresh.
  const options = useMemo(() => {
    const rows = (roles?.roles ?? []).map((role) => ({ slug: role.slug, name: role.name, custom: role.custom }))
    for (const slug of initialRoles) {
      if (!rows.some((row) => row.slug === slug)) rows.push({ slug, name: slug, custom: true })
    }
    return rows
  }, [roles, initialRoles])

  const nextRoles = mode === 'restricted' ? selected : []
  const changed =
    nextRoles.length !== initialRoles.length || nextRoles.some((slug) => !initialRoles.includes(slug))
  const missingRole = mode === 'restricted' && selected.length === 0
  const canSave = !saving && changed && !missingRole

  const toggle = (slug: string, on: boolean): void =>
    setSelected((prev) => (on ? [...prev, slug] : prev.filter((held) => held !== slug)))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await setFolderAccess(projectId, folder.id, nextRoles.length > 0 ? nextRoles : null)
      const title = result.roles
        ? t('folders.access.savedRestricted', { name: folder.name })
        : t('folders.access.savedOpen', { name: folder.name })
      toast.success(title, {
        description: result.moved > 0 ? t('folders.access.moving', { count: result.moved }) : undefined,
      })
      if (result.failed.length > 0) toast.warning(t('folders.access.failed', { count: result.failed.length }))
      onSaved(result)
      onClose()
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0
      toast.error(
        status === 409
          ? t('folders.access.ifcRefused')
          : status === 403 || status === 404
            ? t('folders.access.forbidden')
            : t('folders.access.saveError')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent closeLabel={tc('actions.close')} data-testid="folder-access-dialog">
      <DialogHeader>
        <DialogTitle>{t('folders.access.title', { name: folder.name })}</DialogTitle>
        <DialogDescription>{t('folders.access.description')}</DialogDescription>
      </DialogHeader>

      <ChoiceCardGroup
        value={mode}
        onValueChange={(value) => setMode(value as Mode)}
        aria-label={t('folders.access.title', { name: folder.name })}
        className="grid-cols-1 sm:grid-cols-2"
        disabled={saving}
      >
        <ChoiceCard
          value="everyone"
          icon={Users}
          label={t('folders.access.everyone')}
          hint={t('folders.access.everyoneHint')}
          data-testid="folder-access-everyone"
        />
        <ChoiceCard
          value="restricted"
          icon={Lock}
          label={t('folders.access.restricted')}
          hint={t('folders.access.restrictedHint')}
          data-testid="folder-access-restricted"
        />
      </ChoiceCardGroup>

      {mode === 'restricted' && (
        <div role="group" aria-labelledby="folder-access-roles-label" className="flex flex-col gap-2.5">
          <FieldLabel id="folder-access-roles-label">{t('folders.access.roles')}</FieldLabel>
          {rolesFailed ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {t('folders.access.loadError')}
                {onRetryRoles && (
                  <Button variant="outline" size="sm" onClick={onRetryRoles}>
                    {tc('actions.retry')}
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          ) : !roles ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label={tc('states.loading')}>
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-56" />
            </div>
          ) : options.length === 0 ? (
            <FieldDescription>{t('folders.access.noRoles')}</FieldDescription>
          ) : (
            options.map((role) => {
              const id = `folder-access-role-${role.slug.replace(/[^a-z0-9]+/gi, '-')}`
              return (
                <Field key={role.slug} orientation="horizontal" className="justify-start gap-2.5">
                  <Checkbox
                    id={id}
                    checked={selected.includes(role.slug)}
                    disabled={saving}
                    onCheckedChange={(next) => toggle(role.slug, next === true)}
                  />
                  <FieldLabel htmlFor={id} className="font-normal">
                    {role.name}
                  </FieldLabel>
                  {role.custom && <Badge variant="secondary">{t('folders.access.customRole')}</Badge>}
                </Field>
              )
            })
          )}
          {missingRole && roles && options.length > 0 && (
            <FieldDescription data-testid="folder-access-pick-one">{t('folders.access.pickOne')}</FieldDescription>
          )}
          <FieldDescription>{t('folders.access.lockout')}</FieldDescription>
        </div>
      )}

      {changed && (
        <Alert variant="info" data-testid="folder-access-move-notice">
          <AlertDescription>{t('folders.access.moveNotice')}</AlertDescription>
        </Alert>
      )}
      {mode === 'restricted' && <FieldDescription>{t('folders.access.ifcNotice')}</FieldDescription>}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {tc('actions.cancel')}
        </Button>
        <Button type="button" onClick={() => void save()} disabled={!canSave} data-testid="folder-access-save">
          {saving ? t('folders.access.saving') : t('folders.access.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
