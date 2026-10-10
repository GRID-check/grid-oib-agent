'use client'

/**
 * „Zugriff auf …": who may read and who may write one folder (ADR-0088, ADR-0097).
 *
 * Two answers: as the parent folder (the root folder's parent is the project:
 * everyone keeps what their project permissions allow), or an own list —
 * people of the project, each with „Lesen" or „Bearbeiten", and optionally
 * „Alle Projektmitglieder dürfen lesen", which leaves the list deciding only
 * who may write. Someone not on a list nobody else reads sees nothing of the
 * folder. The dialog says what the reader cannot see from here: a subfolder can
 * only be narrower than its parent, „Bearbeiten" never goes beyond what someone
 * may do in the project, saving a change of who may READ moves and re-reads
 * the folder's documents, a list without yourself hides the folder from you
 * too, and a building model cannot sit in a folder not everyone may read.
 *
 * Who is on a list is not in the folder listing: it is read when the dialog
 * opens, with the project's people to pick from. The PUT is the authority. It
 * answers 404 for a reader who may not manage the project, refuses someone
 * outside the organization, and reports how many documents moved and which did
 * not.
 */

import { type FC, useEffect, useState } from 'react'
import { AlertTriangle, FolderTree, Lock, X } from 'lucide-react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import {
  getFolderAccess,
  listProjectPeople,
  setFolderAccess,
  type FolderAccessResult,
  type FolderAccessSetting,
  type FolderPersonItem,
  type ProjectPerson,
} from '@/adapters/api/folder-access-client'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { FolderItem } from './project-file-workspace'

type Mode = 'inherit' | 'custom'
type CustomAccess = Extract<FolderAccessSetting, { mode: 'custom' }>

/** At most this many people; the route holds the same line (`FOLDER_ACCESS_MAX_PEOPLE`). */
const MAX_PEOPLE = 50

export interface FolderAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  /** The folder being changed; the dialog renders nothing without one. */
  folder: FolderItem | null
  onSaved: (result: FolderAccessResult) => void
}

const EMPTY_LIST: CustomAccess = { mode: 'custom', everyoneReads: false, people: [] }

/** The whole list, for "did anything change". */
const accessKey = (access: CustomAccess): string =>
  [
    access.everyoneReads ? '*' : '',
    ...access.people.map((person) => `${person.userId}:${person.level}`).sort(),
  ].join(',')

/** Who may READ under a list: everyone, or exactly the people on it. Levels do not change it. */
const readersKey = (access: CustomAccess): string =>
  access.everyoneReads ? '*' : access.people.map((person) => person.userId).sort().join(',')

export const FolderAccessDialog: FC<FolderAccessDialogProps> = ({ open, onOpenChange, folder, ...rest }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {folder && (
      <FolderAccessForm
        key={`${folder.id}-${folder.ownAccess ? `custom-${folder.ownAccess.everyoneReads}` : 'inherit'}-${open}`}
        folder={folder}
        onClose={() => onOpenChange(false)}
        {...rest}
      />
    )}
  </Dialog>
)

interface Loaded {
  /** The list as it is now: what an unchanged dialog would save. Null for a folder that inherits. */
  current: CustomAccess | null
  /** The project's people, to name and to add. */
  people: ProjectPerson[]
}

/**
 * What the dialog reads when it opens: the folder's list (a folder with its own
 * only) and the project's people. `retry` reads both again.
 */
function useFolderAccessData(projectId: string, folderId: string, hasOwnList: boolean) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setFailed(false)
    Promise.all([hasOwnList ? getFolderAccess(projectId, folderId) : null, listProjectPeople(projectId)])
      .then(([access, people]) => {
        if (live) setLoaded({ current: access?.mode === 'custom' ? access : null, people })
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [projectId, folderId, hasOwnList, attempt])

  return { loaded, failed, retry: () => setAttempt((count) => count + 1) }
}

const FolderAccessForm: FC<
  Omit<FolderAccessDialogProps, 'open' | 'onOpenChange' | 'folder'> & { folder: FolderItem; onClose: () => void }
> = ({ folder, projectId, onSaved, onClose }) => {
  const t = useTranslations('files')
  const tc = useTranslations('common')
  const initialMode: Mode = folder.ownAccess ? 'custom' : 'inherit'
  const { loaded, failed, retry } = useFolderAccessData(projectId, folder.id, Boolean(folder.ownAccess))
  const [mode, setMode] = useState<Mode>(initialMode)
  // The list as edited; until the first edit, the list as it is. A folder with
  // its own list has none to show or save until that is read.
  const [edited, setEdited] = useState<CustomAccess | null>(null)
  const [saving, setSaving] = useState(false)

  const current = loaded?.current ?? null
  const draft: CustomAccess | null = edited ?? current ?? (folder.ownAccess && !loaded ? null : EMPTY_LIST)
  const people = draft?.people ?? []
  const everyoneReads = draft?.everyoneReads ?? false
  const nameOf = (userId: string): string =>
    loaded?.people.find((person) => person.userId === userId)?.name ?? t('folders.access.unknownPerson')
  const addable = (loaded?.people ?? []).filter((person) => !people.some((entry) => entry.userId === person.userId))

  const custom = mode === 'custom'
  const comparable = custom && draft !== null && current !== null
  const changed = mode !== initialMode || (comparable && accessKey(draft) !== accessKey(current))
  const readersChange = mode !== initialMode || (comparable && readersKey(draft) !== readersKey(current))
  const missingPerson = custom && (draft === null || (draft.people.length === 0 && !draft.everyoneReads))
  const canSave = !saving && changed && !missingPerson
  // A list not every member may read: its documents move into their own
  // collection, and a model may not sit there.
  const restrictsReading = custom && !everyoneReads

  const edit = (change: (prev: CustomAccess) => CustomAccess): void => {
    if (draft) setEdited(change(draft))
  }
  const updatePeople = (change: (prev: FolderPersonItem[]) => FolderPersonItem[]): void =>
    edit((prev) => ({ ...prev, people: change(prev.people) }))
  const setLevel = (userId: string, level: FolderPersonItem['level']): void =>
    updatePeople((prev) => prev.map((entry) => (entry.userId === userId ? { ...entry, level } : entry)))
  const remove = (userId: string): void => updatePeople((prev) => prev.filter((entry) => entry.userId !== userId))
  const add = (userId: string): void =>
    updatePeople((prev) => (prev.some((entry) => entry.userId === userId) ? prev : [...prev, { userId, level: 'read' }]))
  const setEveryoneReads = (value: boolean): void => edit((prev) => ({ ...prev, everyoneReads: value }))

  const save = async (): Promise<void> => {
    const next: FolderAccessSetting | null = custom ? draft : { mode: 'inherit' }
    if (!next) return
    setSaving(true)
    try {
      const result = await setFolderAccess(projectId, folder.id, next)
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

      {custom && (
        <div className="flex flex-col gap-3">
          {failed ? (
            <Alert variant="destructive" data-testid="folder-access-load-error">
              <AlertTriangle />
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {t('folders.access.loadError')}
                <Button variant="outline" size="sm" onClick={retry}>
                  {tc('actions.retry')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : !loaded || !draft ? (
            <div
              className="flex flex-col gap-2"
              aria-busy="true"
              aria-label={tc('states.loading')}
              data-testid="folder-access-loading"
            >
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : (
            <>
              <Field orientation="horizontal">
                <div className="flex min-w-0 flex-col gap-1">
                  <FieldLabel htmlFor="folder-access-everyone-reads">{t('folders.access.everyoneReads')}</FieldLabel>
                  <FieldDescription>{t('folders.access.everyoneReadsHint')}</FieldDescription>
                </div>
                <Switch
                  id="folder-access-everyone-reads"
                  checked={everyoneReads}
                  onCheckedChange={setEveryoneReads}
                  disabled={saving}
                  data-testid="folder-access-everyone-reads"
                />
              </Field>
              <div role="group" aria-labelledby="folder-access-people-label" className="flex flex-col gap-2.5">
                <FieldLabel id="folder-access-people-label">{t('folders.access.people')}</FieldLabel>
                {missingPerson && (
                  <FieldDescription data-testid="folder-access-pick-one">{t('folders.access.pickOne')}</FieldDescription>
                )}
                <ul className="flex flex-col gap-2" data-testid="folder-access-people">
                  {people.map((entry) => {
                    const name = nameOf(entry.userId)
                    return (
                      <li
                        key={entry.userId}
                        className="flex flex-wrap items-center gap-2"
                        data-testid={`folder-access-person-${entry.userId}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                        <ToggleGroup
                          type="single"
                          size="sm"
                          value={entry.level}
                          onValueChange={(value) => {
                            if (value === 'read' || value === 'write') setLevel(entry.userId, value)
                          }}
                          aria-label={t('folders.access.levelFor', { name })}
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
                          aria-label={t('folders.access.remove', { name })}
                          onClick={() => remove(entry.userId)}
                          disabled={saving}
                        >
                          <X className="size-4" aria-hidden />
                        </Button>
                      </li>
                    )
                  })}
                </ul>
                {addable.length > 0 && people.length < MAX_PEOPLE && (
                  <Select value="" onValueChange={add} disabled={saving}>
                    <SelectTrigger size="sm" aria-label={t('folders.access.add')} data-testid="folder-access-add">
                      <SelectValue placeholder={t('folders.access.add')} />
                    </SelectTrigger>
                    <SelectContent>
                      {addable.map((person) => (
                        <SelectItem key={person.userId} value={person.userId}>
                          {person.name}
                          {person.email && <span className="text-muted-foreground"> · {person.email}</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </>
          )}
          <FieldDescription>{t('folders.access.nesting')}</FieldDescription>
          <FieldDescription>{t('folders.access.ceiling')}</FieldDescription>
          <FieldDescription>
            {everyoneReads ? t('folders.access.lockoutEveryoneReads') : t('folders.access.lockout')}
          </FieldDescription>
        </div>
      )}

      {readersChange && (
        <Alert variant="info" data-testid="folder-access-move-notice">
          <AlertDescription>{t('folders.access.moveNotice')}</AlertDescription>
        </Alert>
      )}
      {restrictsReading && (
        <FieldDescription data-testid="folder-access-ifc-notice">{t('folders.access.ifcNotice')}</FieldDescription>
      )}

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
