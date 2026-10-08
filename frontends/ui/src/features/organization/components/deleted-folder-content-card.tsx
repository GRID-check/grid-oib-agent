'use client'

/**
 * Organisation → Sensible Daten → „Inhalte aus gelöschten Ordnern" (ADR-0087):
 * who sees chats, answers and notes drawn from a folder once it is purged.
 * Four choices as tiles; the server applies the choice when derived content
 * is read, so a change takes effect at once, for folders already purged too.
 */

import { useEffect, useState, type JSX } from 'react'
import { Eye, ShieldCheck, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  DELETED_FOLDER_CONTENT_POLICIES,
  getDeletedFolderContentPolicy,
  saveDeletedFolderContentPolicy,
  type DeletedFolderContentPolicy,
} from '@/adapters/api/folder-bin-client'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import { useTranslations } from '@/i18n'

const ICONS = { unchanged: Eye, project: Users, admins: ShieldCheck, remove: Trash2 } as const

export interface DeletedFolderContentCardProps {
  canEdit: boolean
  /** The saved choice, when the page already read it; otherwise the card asks. */
  initial?: DeletedFolderContentPolicy
}

export function DeletedFolderContentCard({ canEdit, initial }: DeletedFolderContentCardProps): JSX.Element {
  const t = useTranslations('organization')
  const [policy, setPolicy] = useState<DeletedFolderContentPolicy | null>(initial ?? null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (initial) return
    getDeletedFolderContentPolicy()
      .then(setPolicy)
      .catch(() => toast.error(t('deletedFolderContent.loadError')))
  }, [initial, t])

  const choose = async (next: string): Promise<void> => {
    const chosen = DELETED_FOLDER_CONTENT_POLICIES.find((value) => value === next)
    if (!chosen || chosen === policy) return
    const before = policy
    setPolicy(chosen)
    setSaving(true)
    try {
      setPolicy(await saveDeletedFolderContentPolicy(chosen))
      toast.success(t('deletedFolderContent.saved'))
    } catch {
      setPolicy(before)
      toast.error(t('deletedFolderContent.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="deleted-folder-content">
      <ChoiceCardGroup
        value={policy ?? undefined}
        onValueChange={(value) => void choose(value)}
        disabled={!canEdit || saving || policy === null}
        aria-label={t('deletedFolderContent.title')}
      >
        {DELETED_FOLDER_CONTENT_POLICIES.map((value) => (
          <ChoiceCard
            key={value}
            value={value}
            icon={ICONS[value]}
            label={t(`deletedFolderContent.options.${value}`)}
            hint={t(`deletedFolderContent.hints.${value}`)}
            data-testid={`deleted-folder-content-${value}`}
          />
        ))}
      </ChoiceCardGroup>
      <p className="text-muted-foreground text-xs">{t('deletedFolderContent.retentionNote')}</p>
      {!canEdit && <p className="text-muted-foreground text-xs">{t('deletedFolderContent.readOnly')}</p>}
    </div>
  )
}
