'use client'

/**
 * The Unterlagen picker: a dialog over the thread, never a pane beside it.
 *
 * Two uses of one list. On the Rechercheplan card (`mode="pick"`) every row
 * can be named as Grundlage — read in full — or as Ausgeschlossen — never
 * used — and the choice travels with the approval. On a running block
 * (`mode="add"`) a row is added to the Grundlage and the run plans it next.
 *
 * The list is whatever the caller can name: the plan card's fence carries the
 * turn's inventory, the block fetches the project's listing. A row's label is
 * its title when it has one, else its file name — the name is what the run is
 * told, the title is what the reader recognises.
 */

import { useMemo, useState, type FC } from 'react'
import { BookOpen, Ban, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslations } from '@/i18n'
import { planDocumentLabel, type PlanDocument } from '@/lib/runs/plan-documents'
import { cn } from '@/lib/utils'

export type UnterlagenRole = 'grundlage' | 'ausgeschlossen' | null

interface CommonProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What can be named: the inventory the caller holds. */
  documents: readonly PlanDocument[]
  loading?: boolean
}

export type UnterlagenDialogProps = CommonProps &
  (
    | {
        mode: 'pick'
        grundlage: readonly string[]
        ausgeschlossen: readonly string[]
        onChange: (next: { grundlage: string[]; ausgeschlossen: string[] }) => void
      }
    | {
        mode: 'add'
        /** Already named: a row already on the Grundlage offers no second add. */
        named: readonly string[]
        onAdd: (doc: PlanDocument) => void | Promise<void>
      }
  )

const fold = (name: string): string => name.trim().toLocaleLowerCase()

const shelfKey = (shelf: string | undefined): 'project' | 'archiv' | 'session' | 'base' | null =>
  shelf === 'project' || shelf === 'archiv' || shelf === 'session' || shelf === 'base' ? shelf : null

export const UnterlagenDialog: FC<UnterlagenDialogProps> = (props) => {
  const { open, onOpenChange, documents, loading = false } = props
  const t = useTranslations('runs')
  const [query, setQuery] = useState('')
  const rows = useMemo(() => {
    const needle = fold(query)
    if (!needle) return documents
    return documents.filter(
      (doc) => fold(planDocumentLabel(doc)).includes(needle) || fold(doc.name).includes(needle)
    )
  }, [documents, query])

  const roleOf = (doc: PlanDocument): UnterlagenRole => {
    if (props.mode !== 'pick') return null
    const key = fold(doc.name)
    if (props.grundlage.some((name) => fold(name) === key)) return 'grundlage'
    if (props.ausgeschlossen.some((name) => fold(name) === key)) return 'ausgeschlossen'
    return null
  }

  const setRole = (doc: PlanDocument, role: UnterlagenRole): void => {
    if (props.mode !== 'pick') return
    const key = fold(doc.name)
    const grundlage = props.grundlage.filter((name) => fold(name) !== key)
    const ausgeschlossen = props.ausgeschlossen.filter((name) => fold(name) !== key)
    if (role === 'grundlage') grundlage.push(doc.name)
    if (role === 'ausgeschlossen') ausgeschlossen.push(doc.name)
    props.onChange({ grundlage, ausgeschlossen })
  }

  const alreadyNamed = (doc: PlanDocument): boolean =>
    props.mode === 'add' && props.named.some((name) => fold(name) === fold(doc.name))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="unterlagen-dialog">
        <DialogHeader>
          <DialogTitle>
            {props.mode === 'pick' ? t('unterlagen.pickTitle') : t('unterlagen.addTitle')}
          </DialogTitle>
          <DialogDescription>
            {props.mode === 'pick' ? t('unterlagen.pickDescription') : t('unterlagen.addDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('unterlagen.searchPlaceholder')}
            aria-label={t('unterlagen.search')}
            className="h-9 pl-8"
          />
        </div>
        <ul
          className="border-border divide-border max-h-80 divide-y overflow-y-auto rounded-md border"
          aria-label={t('unterlagen.list')}
          data-testid="unterlagen-list"
        >
          {loading && rows.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              {t('unterlagen.loading')}
            </li>
          )}
          {!loading && rows.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">
              {t('unterlagen.empty')}
            </li>
          )}
          {rows.map((doc) => {
            const role = roleOf(doc)
            const shelf = shelfKey(doc.shelf)
            return (
              <li
                key={doc.name}
                className="flex items-center gap-2 px-3 py-2"
                data-testid="unterlagen-row"
                data-role={role ?? undefined}
              >
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-sm" title={doc.name}>
                    {planDocumentLabel(doc)}
                  </span>
                  {shelf && (
                    <span className="text-muted-foreground text-[11px]">
                      {t(`unterlagen.shelf.${shelf}`)}
                    </span>
                  )}
                </span>
                {props.mode === 'pick' ? (
                  <span className="flex shrink-0 gap-1" role="group" aria-label={planDocumentLabel(doc)}>
                    <button
                      type="button"
                      aria-pressed={role === 'grundlage'}
                      aria-label={t('unterlagen.markRead', { name: planDocumentLabel(doc) })}
                      onClick={() => setRole(doc, role === 'grundlage' ? null : 'grundlage')}
                      className={cn(
                        'focus-visible:ring-ring/60 rounded-md focus-visible:outline-none focus-visible:ring-2'
                      )}
                    >
                      <Chip size="sm" variant={role === 'grundlage' ? 'default' : 'outline'}>
                        <BookOpen className="size-3" aria-hidden />
                        {t('unterlagen.read')}
                      </Chip>
                    </button>
                    <button
                      type="button"
                      aria-pressed={role === 'ausgeschlossen'}
                      aria-label={t('unterlagen.markExcluded', { name: planDocumentLabel(doc) })}
                      onClick={() =>
                        setRole(doc, role === 'ausgeschlossen' ? null : 'ausgeschlossen')
                      }
                      className="focus-visible:ring-ring/60 rounded-md focus-visible:outline-none focus-visible:ring-2"
                    >
                      <Chip size="sm" variant={role === 'ausgeschlossen' ? 'destructive' : 'outline'}>
                        <Ban className="size-3" aria-hidden />
                        {t('unterlagen.exclude')}
                      </Chip>
                    </button>
                  </span>
                ) : alreadyNamed(doc) ? (
                  <Chip size="sm" variant="muted">
                    {t('unterlagen.alreadyNamed')}
                  </Chip>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => {
                      void props.onAdd(doc)
                      onOpenChange(false)
                    }}
                    aria-label={t('unterlagen.addOne', { name: planDocumentLabel(doc) })}
                  >
                    <Plus className="size-3.5" aria-hidden />
                    {t('unterlagen.add')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
        {props.mode === 'pick' && (
          <DialogFooter>
            <Button size="sm" onClick={() => onOpenChange(false)}>
              {t('unterlagen.done')}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
