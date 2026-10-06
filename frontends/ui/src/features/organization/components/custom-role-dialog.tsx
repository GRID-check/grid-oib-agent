'use client'

/**
 * Create or edit one custom role (ADR-0080): a name, an optional description,
 * and permissions from the organization tier.
 *
 * A permission the editor does not hold is shown and disabled, with the reason
 * under it, rather than hidden: "it exists, and you cannot grant it" is the
 * actual rule, and the server refuses the same thing. A permission the role
 * already carries stays changeable either way, because taking one away grants
 * nothing.
 *
 * An editor form is a Dialog, and one with unsaved changes asks before Escape,
 * the X or a scrim click throws them away (`grid-design-language.md`).
 */

import { type FC, type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import {
  createCustomRole,
  updateCustomRole,
  type AssignablePermission,
  type CustomRoleFields,
  type OrganizationRole,
} from '@/adapters/api/organization-roles-client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import { ROLE_DESCRIPTION_MAX, ROLE_NAME_MAX } from '@/lib/authz/role-limits'
import { permissionLabel } from '../lib/permission-labels'

export interface CustomRoleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The role being edited; absent creates a new one. */
  role?: OrganizationRole
  /** What the editor may offer, from the roles listing. */
  assignable: readonly AssignablePermission[]
  onSaved: (role: OrganizationRole) => void
}

interface Draft {
  name: string
  description: string
  permissions: string[]
}

const draftOf = (role?: OrganizationRole): Draft => ({
  name: role?.name ?? '',
  description: role?.description ?? '',
  permissions: [...(role?.permissions ?? [])],
})

const samePermissions = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((slug) => b.includes(slug))

/** The fields a save sends: all of them on create, only what changed on edit. */
export function roleChanges(initial: Draft, draft: Draft, creating: boolean): Partial<CustomRoleFields> {
  const fields: CustomRoleFields = {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    permissions: draft.permissions,
  }
  if (creating) return fields
  const changes: Partial<CustomRoleFields> = {}
  if (fields.name !== initial.name.trim()) changes.name = fields.name
  if (fields.description !== (initial.description.trim() || null)) changes.description = fields.description
  if (!samePermissions(fields.permissions, initial.permissions)) changes.permissions = fields.permissions
  return changes
}

export const CustomRoleDialog: FC<CustomRoleDialogProps> = ({ open, onOpenChange, role, assignable, onSaved }) => {
  // Escape, the X and a scrim click all arrive here as `false`; the form
  // decides whether that closes or first asks about unsaved changes.
  const closeGuard = useRef<(() => void) | null>(null)
  // A new form per opening, so a second open starts from the role and not
  // from the last draft. The content stays mounted while closed so its exit
  // transition runs.
  const [session, setSession] = useState(0)
  useEffect(() => {
    if (open) setSession((n) => n + 1)
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true)
        else if (closeGuard.current) closeGuard.current()
        else onOpenChange(false)
      }}
    >
      <CustomRoleForm
        key={`${role?.slug ?? 'new'}-${session}`}
        role={role}
        assignable={assignable}
        closeGuard={closeGuard}
        onClose={() => onOpenChange(false)}
        onSaved={onSaved}
      />
    </Dialog>
  )
}

const CustomRoleForm: FC<{
  role?: OrganizationRole
  assignable: readonly AssignablePermission[]
  closeGuard: MutableRefObject<(() => void) | null>
  onClose: () => void
  onSaved: (role: OrganizationRole) => void
}> = ({ role, assignable, closeGuard, onClose, onSaved }) => {
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const creating = !role
  const initial = useMemo(() => draftOf(role), [role])
  const [draft, setDraft] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const changes = roleChanges(initial, draft, creating)
  const dirty = creating
    ? draft.name.trim() !== '' || draft.description.trim() !== '' || draft.permissions.length > 0
    : Object.keys(changes).length > 0

  // The permissions on offer, plus any the role carries that are not on offer
  // (set in the WorkOS dashboard): those can be taken away, never added.
  const offered = useMemo(() => {
    const rows = assignable.map((entry) => ({ slug: entry.slug, grantable: entry.grantable }))
    for (const slug of initial.permissions) {
      if (!rows.some((row) => row.slug === slug)) rows.push({ slug, grantable: false })
    }
    return rows
  }, [assignable, initial.permissions])

  const requestClose = (): void => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }
  useEffect(() => {
    closeGuard.current = requestClose
  })

  const toggle = (slug: string, on: boolean): void =>
    setDraft((prev) => ({
      ...prev,
      permissions: on ? [...prev.permissions, slug] : prev.permissions.filter((held) => held !== slug),
    }))

  const save = async (): Promise<void> => {
    if (!draft.name.trim()) {
      setNameError(t('customRoles.editor.nameRequired'))
      return
    }
    setSaving(true)
    setNameError(null)
    try {
      const saved = role
        ? await updateCustomRole(role.slug, changes)
        : await createCustomRole(changes as CustomRoleFields)
      toast.success(
        creating
          ? t('customRoles.editor.created', { name: saved.name })
          : t('customRoles.editor.saved', { name: saved.name })
      )
      onSaved(saved)
      onClose()
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0
      if (status === 409) setNameError(t('customRoles.editor.nameTaken'))
      else toast.error(status === 403 ? t('customRoles.editor.forbidden') : t('customRoles.editor.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogContent
        closeLabel={tc('actions.close')}
        data-testid="custom-role-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {role ? t('customRoles.editor.editTitle', { name: role.name }) : t('customRoles.editor.createTitle')}
          </DialogTitle>
          <DialogDescription>
            {creating ? t('customRoles.editor.createDescription') : t('customRoles.editor.editDescription')}
          </DialogDescription>
        </DialogHeader>

        <form
          id="custom-role-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="custom-role-name">{t('customRoles.editor.name')}</FieldLabel>
              <Input
                id="custom-role-name"
                value={draft.name}
                maxLength={ROLE_NAME_MAX}
                autoComplete="off"
                placeholder={t('customRoles.editor.namePlaceholder')}
                aria-invalid={nameError ? true : undefined}
                aria-describedby="custom-role-name-hint"
                disabled={saving}
                onChange={(event) => {
                  setNameError(null)
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }}
              />
              {nameError && <FieldError data-testid="custom-role-name-error">{nameError}</FieldError>}
              <FieldDescription id="custom-role-name-hint">
                {role ? <code className="font-mono text-xs">{role.slug}</code> : t('customRoles.editor.nameHint')}
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="custom-role-description">{t('customRoles.editor.description')}</FieldLabel>
              <Textarea
                id="custom-role-description"
                value={draft.description}
                maxLength={ROLE_DESCRIPTION_MAX}
                rows={2}
                placeholder={t('customRoles.editor.descriptionPlaceholder')}
                disabled={saving}
                onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              />
            </Field>

            <div role="group" aria-labelledby="custom-role-permissions-label" className="flex flex-col gap-3">
              <div>
                <FieldLabel id="custom-role-permissions-label">{t('customRoles.editor.permissions')}</FieldLabel>
                <FieldDescription className="mt-1">{t('customRoles.editor.permissionsHint')}</FieldDescription>
              </div>
              {offered.map(({ slug, grantable }) => {
                const checked = draft.permissions.includes(slug)
                const label = permissionLabel(t, slug)
                // Taking a permission away grants nothing, so one the role
                // already carries stays changeable.
                const locked = !grantable && !initial.permissions.includes(slug)
                const id = `custom-role-permission-${slug.replace(/[^a-z0-9]+/g, '-')}`
                return (
                  <Field key={slug} orientation="horizontal" className="items-start justify-start gap-3">
                    <Checkbox
                      id={id}
                      checked={checked}
                      disabled={saving || locked}
                      aria-describedby={`${id}-hint`}
                      onCheckedChange={(next) => toggle(slug, next === true)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <FieldLabel htmlFor={id} className="font-normal">
                        {label.name}
                      </FieldLabel>
                      <FieldDescription id={`${id}-hint`} className="mt-0.5">
                        {locked ? t('customRoles.editor.notGrantable') : label.hint ?? slug}
                      </FieldDescription>
                    </div>
                  </Field>
                )
              })}
            </div>
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={requestClose} disabled={saving}>
            {tc('actions.cancel')}
          </Button>
          <Button
            type="submit"
            form="custom-role-form"
            disabled={saving || (!creating && !dirty)}
            data-testid="custom-role-save"
          >
            {saving
              ? t('customRoles.editor.saving')
              : creating
                ? t('customRoles.editor.create')
                : t('customRoles.editor.save')}
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        tone="warning"
        title={t('customRoles.editor.discardTitle')}
        description={t('customRoles.editor.discardDescription')}
        confirmLabel={t('customRoles.editor.discardConfirm')}
        cancelLabel={t('customRoles.editor.keepEditing')}
        onConfirm={() => {
          setConfirmDiscard(false)
          onClose()
        }}
      />
    </>
  )
}
