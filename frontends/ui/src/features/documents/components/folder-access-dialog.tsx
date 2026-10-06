'use client'

/**
 * „Zugriff auf …": who may read and who may write one folder (ADR-0079).
 *
 * Two answers: as the parent folder (the root folder's parent is the project:
 * everyone keeps what their project permissions allow), or an own list —
 * roles of the organization, and „Alle Projektmitglieder", each with „Lesen"
 * or „Bearbeiten". A role not on the list sees nothing of the folder. The
 * dialog says what the reader cannot see from here: a subfolder can only be
 * narrower than its parent, „Bearbeiten" never goes beyond what someone may do
 * in the project, saving a change of who may READ moves and re-reads the
 * folder's documents, a list without your roles hides the folder from you too,
 * and a building model cannot sit in a folder not everyone may read.
 *
 * The PUT is the authority. It answers 404 for a reader who may not manage the
 * project, refuses a role the organization does not have, and reports how many
 * documents moved and which did not.
 */

import { type FC, useMemo, useState } from 'react'
import { AlertTriangle, FolderTree, Lock, X } from 'lucide-react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import {
  EVERY_PROJECT_MEMBER,
  setFolderAccess,
  type FolderAccessResult,
  type FolderGrantItem,
} from '@/adapters/api/folder-access-client'
import type { OrganizationRoles } from '@/adapters/api/organization-roles-client'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { FolderItem } from './project-file-workspace'

type Mode = 'inherit' | 'custom'

/** At most this many entries; the route and the 0108 trigger hold the same line. */
const MAX_GRANTS = 20

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

const grantsKey = (grants: readonly FolderGrantItem[]): string =>
  grants
    .map((grant) => `${grant.role}:${grant.level}`)
    .sort()
    .join(',')

export const FolderAccessDialog: FC<FolderAccessDialogProps> = ({ open, onOpenChange, folder, ...rest }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {folder && (
      <FolderAccessForm
        key={`${folder.id}-${folder.grants ? grantsKey(folder.grants) : 'inherit'}-${open}`}
        folder={folder}
        onClose={() => onOpenChange(false)}
        {...rest}
      />
    )}
  </Dialog>
)

interface RoleOption {
  slug: string
  name: string
  custom: boolean
}

const FolderAccessForm: FC<
  Omit<FolderAccessDialogProps, 'open' | 'onOpenChange' | 'folder'> & { folder: FolderItem; onClose: () => void }
> = ({ folder, projectId, roles, rolesFailed = false, onRetryRoles, onSaved, onClose }) => {
  const t = useTranslations('files')
  const tc = useTranslations('common')
  const initialGrants = useMemo(() => folder.grants ?? [], [folder.grants])
  const [mode, setMode] = useState<Mode>(folder.grants ? 'custom' : 'inherit')
  const [grants, setGrants] = useState<FolderGrantItem[]>(initialGrants)
  const [saving, setSaving] = useState(false)

  // The organization's roles, „Alle Projektmitglieder", and any role the folder
  // names that no longer exists (a deleted role): shown so it can be taken
  // off, never offered fresh.
  const options = useMemo(() => {
    const rows: RoleOption[] = [
      { slug: EVERY_PROJECT_MEMBER, name: t('folders.access.everyMember'), custom: false },
      ...(roles?.roles ?? []).map((role) => ({ slug: role.slug, name: role.name, custom: role.custom })),
    ]
    for (const grant of initialGrants) {
      if (!rows.some((row) => row.slug === grant.role)) rows.push({ slug: grant.role, name: grant.role, custom: true })
    }
    return rows
  }, [roles, initialGrants, t])
  const nameOf = (slug: string): RoleOption | undefined => options.find((option) => option.slug === slug)
  const addable = options.filter((option) => !grants.some((grant) => grant.role === option.slug))

  const next: FolderGrantItem[] | null = mode === 'custom' ? grants : null
  const changed =
    (next === null) !== (folder.grants == null) || (next !== null && grantsKey(next) !== grantsKey(initialGrants))
  const missingRole = mode === 'custom' && grants.length === 0
  const canSave = !saving && changed && !missingRole
  // A list without „Alle Projektmitglieder" is one not every member may read:
  // its documents move into their own collection, and a model may not sit there.
  const restrictsReading = mode === 'custom' && !grants.some((grant) => grant.role === EVERY_PROJECT_MEMBER)

  const setLevel = (role: string, level: FolderGrantItem['level']): void =>
    setGrants((prev) => prev.map((grant) => (grant.role === role ? { ...grant, level } : grant)))
  const remove = (role: string): void => setGrants((prev) => prev.filter((grant) => grant.role !== role))
  const add = (role: string): void =>
    setGrants((prev) => (prev.some((grant) => grant.role === role) ? prev : [...prev, { role, level: 'read' }]))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await setFolderAccess(
        projectId,
        folder.id,
        next ? { mode: 'custom', grants: next } : { mode: 'inherit' }
      )
      const title =
        result.access.mode === 'custom'
          ? t('folders.access.savedCustom', { name: folder.name })
          : t('folders.access.savedInherit', { name: folder.name })
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
          value="inherit"
          icon={FolderTree}
          label={t('folders.access.inherit')}
          hint={t('folders.access.inheritHint')}
          data-testid="folder-access-inherit"
        />
        <ChoiceCard
          value="custom"
          icon={Lock}
          label={t('folders.access.custom')}
          hint={t('folders.access.customHint')}
          data-testid="folder-access-custom"
        />
      </ChoiceCardGroup>

      {mode === 'custom' && (
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
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <>
              {grants.length === 0 && (
                <FieldDescription data-testid="folder-access-pick-one">{t('folders.access.pickOne')}</FieldDescription>
              )}
              <ul className="flex flex-col gap-2" data-testid="folder-access-grants">
                {grants.map((grant) => {
                  const option = nameOf(grant.role)
                  const name = option?.name ?? grant.role
                  return (
                    <li
                      key={grant.role}
                      className="flex flex-wrap items-center gap-2"
                      data-testid={`folder-access-grant-${grant.role === EVERY_PROJECT_MEMBER ? 'all' : grant.role}`}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                      {option?.custom && grant.role !== EVERY_PROJECT_MEMBER && (
                        <Badge variant="secondary">{t('folders.access.customRole')}</Badge>
                      )}
                      <ToggleGroup
                        type="single"
                        size="sm"
                        value={grant.level}
                        onValueChange={(value) => {
                          if (value === 'read' || value === 'write') setLevel(grant.role, value)
                        }}
                        aria-label={t('folders.access.levelFor', { role: name })}
                        disabled={saving}
                      >
                        <ToggleGroupItem value="read">{t('folders.access.levelRead')}</ToggleGroupItem>
                        <ToggleGroupItem value="write">{t('folders.access.levelWrite')}</ToggleGroupItem>
                      </ToggleGroup>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={t('folders.access.remove', { role: name })}
                        onClick={() => remove(grant.role)}
                        disabled={saving}
                      >
                        <X className="size-4" aria-hidden />
                      </Button>
                    </li>
                  )
                })}
              </ul>
              {addable.length > 0 && grants.length < MAX_GRANTS && (
                <Select value="" onValueChange={add} disabled={saving}>
                  <SelectTrigger size="sm" aria-label={t('folders.access.add')} data-testid="folder-access-add">
                    <SelectValue placeholder={t('folders.access.add')} />
                  </SelectTrigger>
                  <SelectContent>
                    {addable.map((option) => (
                      <SelectItem key={option.slug} value={option.slug}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )}
          <FieldDescription>{t('folders.access.nesting')}</FieldDescription>
          <FieldDescription>{t('folders.access.ceiling')}</FieldDescription>
          <FieldDescription>{t('folders.access.lockout')}</FieldDescription>
        </div>
      )}

      {changed && (
        <Alert variant="info" data-testid="folder-access-move-notice">
          <AlertDescription>{t('folders.access.moveNotice')}</AlertDescription>
        </Alert>
      )}
      {restrictsReading && <FieldDescription>{t('folders.access.ifcNotice')}</FieldDescription>}

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
