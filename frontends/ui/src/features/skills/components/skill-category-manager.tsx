'use client'

/**
 * The category manager — arrange the categories without leaving the Skills tab.
 *
 * Create, rename, remove. Removing never removes the skills standing on the
 * category: they fall back to unsorted, and the confirmation says how many that
 * is, because "remove category" reads as "remove skills" until it is told
 * otherwise.
 *
 * Owner-agnostic: the org toolbox passes its categories with the org endpoints,
 * the platform catalogue its categories with the platform ones. The dialog knows
 * neither — it calls what it was given.
 */

import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { useTranslations } from '@/i18n'
import type { SkillCategoryListItem } from '@/adapters/api/skills-client'

interface SkillCategoryManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The categories this curator owns — org categories here, platform categories there. */
  categories: SkillCategoryListItem[]
  /** Skills standing on each category, by category id — for the delete warning. */
  counts: Record<string, number>
  onCreate: (input: { name: string; description?: string }) => Promise<SkillCategoryListItem>
  onRename: (id: string, name: string) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
  /** Refetch the lists above after any mutation. */
  onChanged: () => void
}

export function SkillCategoryManager({
  open,
  onOpenChange,
  categories,
  counts,
  onCreate,
  onRename,
  onDelete,
  onChanged,
}: SkillCategoryManagerProps): JSX.Element {
  const t = useTranslations('skills')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    setCreating(true)
    try {
      await onCreate({ name: trimmed })
      setName('')
      onChanged()
    } catch {
      toast.error(t('toolbox.categories.createError'))
    } finally {
      setCreating(false)
    }
  }

  const saveRename = async (id: string) => {
    const trimmed = editName.trim()
    if (!trimmed || savingId) return
    setSavingId(id)
    try {
      await onRename(id, trimmed)
      setEditingId(null)
      onChanged()
    } catch {
      toast.error(t('toolbox.categories.createError'))
    } finally {
      setSavingId(null)
    }
  }

  const confirmRemove = async () => {
    if (!confirmId || deleting) return
    setDeleting(true)
    try {
      await onDelete(confirmId)
      setConfirmId(null)
      onChanged()
    } catch {
      toast.error(t('toolbox.categories.deleteError'))
    } finally {
      setDeleting(false)
    }
  }

  const confirming = confirmId ? (categories.find((category) => category.id === confirmId) ?? null) : null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent data-testid="category-manager">
          <DialogHeader>
            <DialogTitle>{t('toolbox.categories.title')}</DialogTitle>
            <DialogDescription>{t('toolbox.categories.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-3">
            {categories.length === 0 ? (
              <EmptyState variant="bare" title={t('toolbox.categories.empty')} className="py-4" />
            ) : (
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {categories.map((category) => (
                  <li
                    key={category.id}
                    className="border-border flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    {editingId === category.id ? (
                      <>
                        <Input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveRename(category.id)
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          aria-label={t('toolbox.categories.nameLabel')}
                          className="h-8"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          disabled={savingId === category.id || editName.trim().length === 0}
                          onClick={() => void saveRename(category.id)}
                        >
                          {t('toolbox.categories.save')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                          {t('toolbox.categories.cancel')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{category.name}</p>
                          <p className="text-muted-foreground text-xs tabular-nums">
                            {t('toolbox.categories.count', { count: counts[category.id] ?? 0 })}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('toolbox.categories.renameAria', { name: category.name })}
                          onClick={() => {
                            setEditingId(category.id)
                            setEditName(category.name)
                          }}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          aria-label={t('toolbox.categories.deleteAria', { name: category.name })}
                          onClick={() => setConfirmId(category.id)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-center gap-2">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create()
                }}
                placeholder={t('toolbox.categories.newPlaceholder')}
                aria-label={t('toolbox.categories.newPlaceholder')}
                className="h-9"
              />
              <Button size="sm" disabled={name.trim().length === 0 || creating} onClick={() => void create()}>
                <Plus className="size-4" aria-hidden />
                {t('toolbox.categories.create')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && setConfirmId(null)}
        tone="destructive"
        title={t('toolbox.categories.deleteTitle', { name: confirming?.name ?? '' })}
        description={t('toolbox.categories.deleteDescription', {
          count: counts[confirmId ?? ''] ?? 0,
        })}
        confirmLabel={t('toolbox.categories.deleteConfirm')}
        cancelLabel={t('toolbox.categories.cancel')}
        pending={deleting}
        onConfirm={confirmRemove}
      />
    </>
  )
}
