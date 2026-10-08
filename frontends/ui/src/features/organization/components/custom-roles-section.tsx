'use client'

/**
 * Organisation → Personen & Zugriff → Eigene Rollen (ADR-0086).
 *
 * The office's own roles, kept in WorkOS, beside the platform's. Custom roles
 * are created, edited and deleted here; the platform's are listed read-only,
 * because they are the same for every organization and change only with the
 * catalog. Assigning a role to a person stays on the People tab (WorkOS's own
 * widget), and the copy says so, together with what a role is FOR here: a
 * folder can be restricted to it.
 *
 * Who may edit is read from the listing itself: `assignable` is present only
 * for `org:members:manage`, and it says which permissions this editor may put
 * into a role. The routes enforce both again.
 */

import { type FC, type ReactNode, useCallback, useEffect, useState } from 'react'
import { Info, Pencil, Plus, ShieldCheck, Trash2, UsersRound } from 'lucide-react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import {
  deleteCustomRole,
  getRoleUsage,
  ROLE_USED_BY_FOLDERS,
  type OrganizationRole,
  type RoleUsage,
} from '@/adapters/api/organization-roles-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { SectionCard } from '@/features/platform/components/section-card'
import { useTranslations } from '@/i18n'
import { useOrganizationRoles } from '../hooks/use-organization-roles'
import { permissionLabel } from '../lib/permission-labels'
import { CustomRoleDialog } from './custom-role-dialog'

type Editing = { mode: 'create' } | { mode: 'edit'; role: OrganizationRole } | null

export const CustomRolesSection: FC = () => {
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const { data, failed, reload } = useOrganizationRoles()
  const [editing, setEditing] = useState<Editing>(null)
  const [deleting, setDeleting] = useState<OrganizationRole | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)
  // Which folders name the role being deleted (ADR-0085), read when the dialog
  // opens so the confirmation can say what the deletion leaves behind.
  const [usage, setUsage] = useState<RoleUsage | null>(null)
  const [usageFailed, setUsageFailed] = useState(false)

  const loadUsage = useCallback(async (slug: string, signal?: AbortSignal): Promise<void> => {
    setUsageFailed(false)
    try {
      setUsage(await getRoleUsage(slug, signal))
    } catch {
      if (!signal?.aborted) setUsageFailed(true)
    }
  }, [])

  const deletingSlug = deleting?.slug ?? null
  useEffect(() => {
    setUsage(null)
    if (!deletingSlug) return
    const controller = new AbortController()
    void loadUsage(deletingSlug, controller.signal)
    return () => controller.abort()
  }, [deletingSlug, loadUsage])

  const assignable = data?.assignable ?? null
  const canEdit = assignable !== null
  const custom = (data?.roles ?? []).filter((role) => role.custom)
  const environment = (data?.roles ?? []).filter((role) => !role.custom)

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    setPendingDelete(true)
    try {
      await deleteCustomRole(deleting.slug, { confirmFolders: (usage?.total ?? 0) > 0 })
      toast.success(t('customRoles.deleteDialog.deleted', { name: deleting.name }))
      setDeleting(null)
      await reload()
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0
      if (error instanceof ApiRequestError && error.reason === ROLE_USED_BY_FOLDERS) {
        // Folders started naming the role after the list was read: show it again.
        toast.error(t('customRoles.deleteDialog.usedByFoldersNow'))
        void loadUsage(deleting.slug)
      } else {
        toast.error(status === 409 ? t('customRoles.deleteDialog.stillAssigned') : t('customRoles.deleteDialog.error'))
      }
    } finally {
      setPendingDelete(false)
    }
  }

  return (
    <SectionCard
      title={t('customRoles.title')}
      description={t('customRoles.description')}
      loading={!data && !failed}
      error={failed}
      errorMessage={t('customRoles.loadError')}
      onRetry={() => void reload()}
      testId="custom-roles"
      action={
        canEdit ? (
          <Button size="sm" onClick={() => setEditing({ mode: 'create' })} data-testid="custom-role-create">
            <Plus className="size-4" aria-hidden />
            {t('customRoles.create')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground text-sm leading-relaxed">{t('customRoles.howTo')}</p>
        <Alert variant="info">
          <Info />
          <AlertTitle>{t('customRoles.oneRoleTitle')}</AlertTitle>
          <AlertDescription>{t('customRoles.oneRoleBody')}</AlertDescription>
        </Alert>
        {!canEdit && (
          <p className="text-muted-foreground text-sm" data-testid="custom-roles-readonly">
            {t('customRoles.readOnly')}
          </p>
        )}

        <section className="flex flex-col gap-3" data-testid="custom-roles-own">
          <SectionLabel as="h3">{t('customRoles.customGroup')}</SectionLabel>
          {custom.length === 0 ? (
            <EmptyState
              icon={UsersRound}
              title={t('customRoles.emptyTitle')}
              description={t('customRoles.emptyDescription')}
            />
          ) : (
            <ItemList as="ul">
              {custom.map((role) => (
                <RoleRow
                  key={role.slug}
                  role={role}
                  actions={
                    canEdit ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('customRoles.editRole', { name: role.name })}
                          title={tc('actions.edit')}
                          onClick={() => setEditing({ mode: 'edit', role })}
                          data-testid={`custom-role-edit-${role.slug}`}
                        >
                          <Pencil className="size-4" aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('customRoles.deleteRole', { name: role.name })}
                          title={tc('actions.delete')}
                          onClick={() => setDeleting(role)}
                          data-testid={`custom-role-delete-${role.slug}`}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </>
                    ) : null
                  }
                />
              ))}
            </ItemList>
          )}
        </section>

        <section className="flex flex-col gap-3" data-testid="custom-roles-environment">
          <div className="flex flex-col gap-1">
            <SectionLabel as="h3">{t('customRoles.environmentGroup')}</SectionLabel>
            <p className="text-muted-foreground flex items-start gap-1.5 text-sm">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('customRoles.environmentHint')}
            </p>
          </div>
          <ItemList as="ul">
            {environment.map((role) => (
              <RoleRow key={role.slug} role={role} compact />
            ))}
          </ItemList>
        </section>
      </div>

      {assignable && (
        <CustomRoleDialog
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          role={editing?.mode === 'edit' ? editing.role : undefined}
          assignable={assignable}
          onSaved={() => void reload()}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !pendingDelete && setDeleting(null)}
        tone="destructive"
        title={t('customRoles.deleteDialog.title', { name: deleting?.name ?? '' })}
        description={t('customRoles.deleteDialog.description')}
        confirmLabel={
          (usage?.total ?? 0) > 0 ? t('customRoles.deleteDialog.confirmAnyway') : t('customRoles.deleteDialog.confirm')
        }
        cancelLabel={tc('actions.cancel')}
        pending={pendingDelete}
        // Not until the folders are known: the confirmation is the point.
        confirmDisabled={usage === null}
        onConfirm={() => void confirmDelete()}
        confirmTestId="custom-role-delete-confirm"
      >
        <RoleUsageNotice usage={usage} failed={usageFailed} />
      </ConfirmDialog>
    </SectionCard>
  )
}

/**
 * What deleting a role leaves behind: the folders whose own list names it
 * (ADR-0085). Names only for someone who may read those folders; anyone else is
 * told how many.
 */
const RoleUsageNotice: FC<{ usage: RoleUsage | null; failed: boolean }> = ({ usage, failed }) => {
  const t = useTranslations('organization')
  if (failed) {
    return (
      <p className="text-sm text-error" data-testid="role-usage-error">
        {t('customRoles.deleteDialog.usageError')}
      </p>
    )
  }
  if (!usage || usage.total === 0) return null
  const more = usage.total - usage.folders.length
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="role-usage">
      <p className="font-medium">{t('customRoles.deleteDialog.foldersCount', { count: usage.total })}</p>
      {usage.folders.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {usage.folders.map((folder) => (
            <li key={folder.folderId} data-testid="role-usage-folder">
              <span className="font-medium">{folder.folderName}</span>
              <span className="text-muted-foreground"> · {folder.projectName}</span>
            </li>
          ))}
          {more > 0 && (
            <li className="text-muted-foreground">{t('customRoles.deleteDialog.foldersMore', { count: more })}</li>
          )}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t('customRoles.deleteDialog.foldersNamesHidden')}</p>
      )}
      <p className="text-muted-foreground">{t('customRoles.deleteDialog.foldersEffect')}</p>
    </div>
  )
}

/**
 * One role: name and identifier, description, and what it may do. A
 * platform role (`compact`) shows the count only; its permissions are read on
 * the Roles tab, which renders the catalog it comes from.
 */
const RoleRow: FC<{ role: OrganizationRole; compact?: boolean; actions?: ReactNode }> = ({
  role,
  compact = false,
  actions,
}) => {
  const t = useTranslations('organization')
  const permissions = role.permissions ?? []
  return (
    <Item as="li" className="items-start" data-testid={`role-row-${role.slug}`}>
      <ItemContent className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h4 className="text-sm font-medium">{role.name}</h4>
          <code className="text-muted-foreground font-mono text-xs">{role.slug}</code>
        </div>
        {role.description && <p className="text-muted-foreground text-sm">{role.description}</p>}
        {role.permissions !== undefined &&
          (compact || permissions.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {t('customRoles.permissionCount', { count: permissions.length })}
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1" aria-label={t('customRoles.editor.permissions')}>
              {permissions.map((slug) => (
                <li key={slug}>
                  <Badge variant="secondary">{permissionLabel(t, slug).name}</Badge>
                </li>
              ))}
            </ul>
          ))}
      </ItemContent>
      {actions && <ItemActions>{actions}</ItemActions>}
    </Item>
  )
}
