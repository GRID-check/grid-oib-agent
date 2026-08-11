'use client'

/**
 * Org skill authoring dialog (org:skills:manage). Fields: name, description
 * and the instruction body in agentskills.io format, plus the two reserved
 * metadata controls the UI owns — execution mode (`grid-execution`, default
 * chat) and the scheduling opt-out (`grid-schedulable=false`) — and the
 * master enabled switch. Editing a clone shows its source. Platform-builtin
 * skills have no DB row and are never edited here; they are cloned instead
 * (see the toolbox).
 *
 * The server owns all final validation; this dialog only mirrors the write
 * boundary rules (name shape/lengths) for instant feedback and always sends a
 * deterministic `grid-execution` value, so the resolved mode cannot drift
 * from what the editor showed.
 */

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import {
  createSkill,
  deleteSkill,
  updateSkill,
  type CreateSkillInput,
  type SkillListItem,
} from '@/adapters/api/skills-client'
import { ConfirmDeleteDialog } from './confirm-delete-dialog'
import { SkillDocumentPreview } from './SkillDocumentPreview'
import { SkillReviewPanel } from './SkillReviewPanel'

/** Rule names must satisfy server-side: lowercase a-z/0-9, single hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Reserved metadata keys the editor writes. */
const METADATA_EXECUTION = 'grid-execution'
const METADATA_SCHEDULABLE = 'grid-schedulable'

interface SkillEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The skill being edited, or null when creating (optionally from a clone). */
  skill: SkillListItem | null
  /** Builtin platform skill name this new skill is cloned from. */
  cloneFrom?: string | null
  onSaved: () => void
}

interface EditorValues {
  name: string
  description: string
  body: string
}

export function SkillEditorDialog({
  open,
  onOpenChange,
  skill,
  cloneFrom = null,
  onSaved,
}: SkillEditorDialogProps): JSX.Element {
  const t = useTranslations('skills')
  const isEdit = skill !== null
  const [execution, setExecution] = useState<'chat' | 'deep-research'>(
    isEdit && skill.metadata[METADATA_EXECUTION] === 'deep-research' ? 'deep-research' : 'chat',
  )
  const [schedulable, setSchedulable] = useState(
    !isEdit || skill.metadata[METADATA_SCHEDULABLE] !== 'false',
  )

  /**
   * The frontmatter `metadata` this dialog will write.
   *
   * ONE function, used both by the submit and by the SKILL.md preview — the
   * preview's claim to be "exactly what gets stored" only holds if the two
   * cannot disagree, and two copies of this assembly is precisely how they
   * would start to.
   */
  const buildMetadata = useCallback((): Record<string, string> => {
    const metadata: Record<string, string> = {
      // Deterministic at write time, mirroring the server's executionOf.
      [METADATA_EXECUTION]: execution,
    }
    if (!schedulable) metadata[METADATA_SCHEDULABLE] = 'false'
    // Preserve opaque keys (grid-agents etc.) when editing; the two reserved
    // keys above are the only ones this UI ever writes.
    if (isEdit) {
      for (const key of Object.keys(skill.metadata)) {
        if (key !== METADATA_EXECUTION && key !== METADATA_SCHEDULABLE) {
          metadata[key] = skill.metadata[key]
        }
      }
    }
    return metadata
  }, [execution, isEdit, schedulable, skill])
  const [enabled, setEnabled] = useState(isEdit ? skill.enabled : true)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t('editor.nameRequired'))
          .max(64, t('editor.nameTooLong'))
          .regex(SKILL_NAME_PATTERN, t('editor.nameInvalid')),
        description: z
          .string()
          .trim()
          .min(1, t('editor.descriptionRequired'))
          .max(1024, t('editor.descriptionTooLong')),
        body: z
          .string()
          .trim()
          .min(1, t('editor.bodyRequired'))
          .max(32000, t('editor.bodyTooLong')),
      }),
    [t],
  )

  const form = useAppForm({
    defaultValues: {
      name: skill?.name ?? '',
      description: skill?.description ?? '',
      body: skill?.body ?? '',
    } satisfies EditorValues,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setFormError(null)
      const metadata = buildMetadata()

      const payload: CreateSkillInput = {
        name: value.name.trim(),
        description: value.description.trim(),
        body: value.body.trim(),
        metadata,
        enabled,
        clonedFrom: cloneFrom ?? undefined,
      }

      try {
        if (isEdit) {
          await updateSkill(skill.id!, payload)
          toast.success(t('editor.updateSuccess'))
        } else {
          await createSkill(payload)
          toast.success(t('editor.createSuccess'))
        }
        onSaved()
      } catch {
        setFormError(t('editor.saveError'))
        toast.error(t('editor.saveError'))
      }
    },
  })

  const confirmDelete = async () => {
    if (!skill) return
    setDeleting(true)
    try {
      await deleteSkill(skill.id!)
      setConfirmOpen(false)
      onSaved()
    } catch {
      toast.error(t('editor.saveError'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !form.state.isSubmitting && onOpenChange(next)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEdit ? t('editor.editTitle') : t('editor.createTitle')}</DialogTitle>
            <DialogDescription>
              {isEdit ? t('editor.editSubtitle') : t('editor.createSubtitle')}
              {cloneFrom ? ` ${t('editor.cloneFrom', { name: cloneFrom })}` : ''}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void form.handleSubmit()
            }}
            className="space-y-4"
          >
            <form.AppField name="name">
              {(field) => (
                <field.TextField
                  label={t('editor.nameLabel')}
                  placeholder={t('editor.namePlaceholder')}
                  required
                  className="font-mono"
                />
              )}
            </form.AppField>
            <form.AppField name="description">
              {(field) => (
                <field.TextAreaField
                  label={t('editor.descriptionLabel')}
                  placeholder={t('editor.descriptionPlaceholder')}
                  required
                  rows={2}
                />
              )}
            </form.AppField>
            <form.AppField name="body">
              {(field) => (
                <field.TextAreaField
                  label={t('editor.bodyLabel')}
                  placeholder={t('editor.bodyPlaceholder')}
                  required
                  rows={12}
                  className="font-mono"
                />
              )}
            </form.AppField>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('editor.executionLabel')}</span>
              <p className="text-xs text-muted-foreground">{t('editor.executionHint')}</p>
              <Select
                value={execution}
                onValueChange={(value) => setExecution(value as 'chat' | 'deep-research')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat">{t('toolbox.execution.chat')}</SelectItem>
                  <SelectItem value="deep-research">{t('toolbox.execution.deepResearch')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t('editor.schedulableLabel')}</span>
                <p className="text-xs text-muted-foreground">{t('editor.schedulableHint')}</p>
              </div>
              <Switch checked={schedulable} onCheckedChange={setSchedulable} />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{t('editor.enabledLabel')}</span>
                <p className="text-xs text-muted-foreground">{t('editor.enabledHint')}</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            {/* The document these fields produce. Placed after the controls
                that feed it — including the two switches, whose only visible
                effect otherwise is a line of frontmatter nobody ever sees. */}
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <>
                  <SkillDocumentPreview
                    name={values.name}
                    description={values.description}
                    body={values.body}
                    metadata={buildMetadata()}
                  />
                  {/* The review sits directly under the document it is about,
                      and is the same panel for everyone who can open this
                      dialog — the author most likely to write a description
                      that never matches anything is the one writing their
                      first skill. */}
                  <SkillReviewPanel
                    name={values.name}
                    description={values.description}
                    body={values.body}
                  />
                </>
              )}
            </form.Subscribe>

            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t('editor.cancel')}
              </Button>
              {isEdit && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmOpen(true)}
                >
                  {t('actions.delete')}
                </Button>
              )}
              <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
                {([canSubmit, isSubmitting]) => (
                  <Button type="submit" disabled={!canSubmit || isSubmitting}>
                    {isSubmitting && <Spinner size="sm" />}
                    {isSubmitting ? t('editor.saving') : t('editor.save')}
                  </Button>
                )}
              </form.Subscribe>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit-mode delete: removes the skill from the toolbox; schedules keep
          their saved snapshot, so they keep running unchanged. */}
      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('editor.deleteTitle')}
        description={t('editor.deleteDescription', { name: skill?.name ?? '' })}
        confirmLabel={t('editor.deleteConfirm')}
        cancelLabel={t('editor.cancel')}
        pending={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}