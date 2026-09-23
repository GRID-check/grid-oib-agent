'use client'

/**
 * The plan's document step: optional, because the research may read every
 * document it can find. What the step offers is how far to steer it:
 *
 * - **Alle Unterlagen** (the default). Documents chosen through
 *   „Schwerpunkte wählen" are read first and in full; the research still
 *   reads whatever else it finds. „Ausschließen …" keeps documents out.
 * - **Nur ausgewählte.** Of the reader's own documents the research uses the
 *   chosen ones and no other. Norms and laws stay available: the confinement
 *   is to the reader's files, never to the measure they are held against.
 *
 * Choosing happens in the document picker (`DocumentPickerDialog`), the one
 * open panel every surface uses; this step shows the choice as chips the
 * reader can strike, so it reads as done without opening anything.
 */

import { useState, type FC } from 'react'
import { Ban, CircleCheck, FolderSearch, Library } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DocumentPickerDialog,
  type PickerDocument,
} from '@/features/documents/components/document-picker/DocumentPickerDialog'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { useTranslations } from '@/i18n'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { PlanDocLine, PlanNote, Segmented } from './plan-atoms'

export interface PlanDocumentChoice {
  grundlage: string[]
  ausgeschlossen: string[]
  nurGrundlage: boolean
  /** The documents just chosen, so a caller can add them to the plan's inventory. */
  picked: PlanDocument[]
}

type Scope = 'alle' | 'nur'
/** What the open picker chooses: a focus, the only documents, or exclusions. */
type Picking = 'focus' | 'only' | 'ausgeschlossen' | null

const fold = (name: string): string => name.trim().toLocaleLowerCase()

/** A picked document as the plan names it: the contract's three fields, nothing of the file row. */
const asPlanDocument = (doc: PickerDocument): PlanDocument => ({
  name: doc.name,
  ...(doc.title ? { title: doc.title } : {}),
  ...(doc.shelf ? { shelf: doc.shelf } : {}),
})

export const PlanUnterlagen: FC<{
  /** Everything that can be named: the plan's inventory and the project's listing, merged. */
  documents: readonly PickerDocument[]
  folders?: readonly FolderItem[]
  loading?: boolean
  grundlage: readonly string[]
  ausgeschlossen: readonly string[]
  nurGrundlage: boolean
  disabled?: boolean
  /** Called when a picker opens, so the caller can load the listing. */
  onBrowse?: () => void
  onChange: (choice: PlanDocumentChoice) => void
}> = ({ documents, folders, loading = false, grundlage, ausgeschlossen, nurGrundlage, disabled = false, onBrowse, onChange }) => {
  const t = useTranslations('chat')
  const tr = useTranslations('runs')
  const [picking, setPicking] = useState<Picking>(null)
  const scope: Scope = nurGrundlage ? 'nur' : 'alle'
  const docOf = (name: string): PlanDocument => {
    const doc = documents.find((row) => fold(row.name) === fold(name))
    return doc ? asPlanDocument(doc) : { name }
  }
  const emit = (next: Partial<Omit<PlanDocumentChoice, 'picked'>>, picked: PlanDocument[] = []): void =>
    onChange({
      grundlage: [...(next.grundlage ?? grundlage)],
      ausgeschlossen: [...(next.ausgeschlossen ?? ausgeschlossen)],
      nurGrundlage: next.nurGrundlage ?? nurGrundlage,
      picked,
    })

  const open = (which: Exclude<Picking, null>): void => {
    onBrowse?.()
    setPicking(which)
  }

  const setScope = (next: Scope): void => {
    // Under „Nur ausgewählte" every unchosen document is out already; a
    // separate exclusion list would only be a second way of saying it.
    emit({ nurGrundlage: next === 'nur', ausgeschlossen: next === 'nur' ? [] : [...ausgeschlossen] })
    if (next === 'nur' && grundlage.length === 0) open('only')
  }

  const inList = (list: readonly string[], doc: PickerDocument) => list.some((name) => fold(name) === fold(doc.name))

  return (
    <div className="flex flex-col gap-2.5" data-testid="plan-unterlagen" data-scope={scope}>
      <div className="flex flex-col gap-1.5">
        <Segmented<Scope>
          label={t('agentPrompt.plan.unterlagen.scope')}
          value={scope}
          disabled={disabled}
          onPick={setScope}
          options={[
            { value: 'alle', icon: Library, label: t('agentPrompt.plan.unterlagen.scopeAll') },
            { value: 'nur', icon: CircleCheck, label: t('agentPrompt.plan.unterlagen.scopeOnly') },
          ]}
        />
        <PlanNote>
          <span data-testid="plan-unterlagen-scope-hint">
            {scope === 'nur'
              ? grundlage.length > 0
                ? t('agentPrompt.plan.unterlagen.scopeOnlyHint', { count: grundlage.length })
                : t('agentPrompt.plan.unterlagen.scopeOnlyEmpty')
              : t('agentPrompt.plan.unterlagen.scopeAllHint')}
          </span>
        </PlanNote>
      </div>

      <PlanDocLine
        label={
          scope === 'nur' ? t('agentPrompt.plan.unterlagen.grundlageOnly') : t('agentPrompt.plan.unterlagen.grundlage')
        }
        docs={grundlage.map(docOf)}
        removeLabel={(label) => t('agentPrompt.plan.unterlagen.removeRead', { name: label })}
        onRemove={disabled ? undefined : (doc) => emit({ grundlage: grundlage.filter((name) => fold(name) !== fold(doc.name)) })}
        testId="plan-grundlage"
      />
      <PlanDocLine
        label={t('agentPrompt.plan.unterlagen.ausgeschlossen')}
        docs={ausgeschlossen.map(docOf)}
        excluded
        removeLabel={(label) => t('agentPrompt.plan.unterlagen.removeExcluded', { name: label })}
        onRemove={
          disabled ? undefined : (doc) => emit({ ausgeschlossen: ausgeschlossen.filter((name) => fold(name) !== fold(doc.name)) })
        }
        testId="plan-ausgeschlossen"
      />

      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => open(scope === 'nur' ? 'only' : 'focus')}
            data-testid="plan-unterlagen-pick"
          >
            <FolderSearch className="size-3.5" aria-hidden />
            {scope === 'nur' ? t('agentPrompt.plan.unterlagen.chooseOnly') : t('agentPrompt.plan.unterlagen.chooseFocus')}
          </Button>
          {scope === 'alle' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={() => open('ausgeschlossen')}
              data-testid="plan-unterlagen-exclude"
            >
              <Ban className="size-3.5" aria-hidden />
              {t('agentPrompt.plan.unterlagen.chooseExcluded')}
            </Button>
          )}
        </div>
      )}

      <DocumentPickerDialog
        open={picking !== null}
        onOpenChange={(next) => !next && setPicking(null)}
        title={
          picking === 'ausgeschlossen'
            ? t('agentPrompt.plan.unterlagen.pickExcludedTitle')
            : picking === 'only'
              ? t('agentPrompt.plan.unterlagen.pickOnlyTitle')
              : t('agentPrompt.plan.unterlagen.pickFocusTitle')
        }
        description={
          picking === 'ausgeschlossen'
            ? t('agentPrompt.plan.unterlagen.pickExcludedDescription')
            : picking === 'only'
              ? t('agentPrompt.plan.unterlagen.pickOnlyDescription')
              : t('agentPrompt.plan.unterlagen.pickFocusDescription')
        }
        documents={documents}
        folders={folders}
        loading={loading}
        initialSelected={picking === 'ausgeschlossen' ? ausgeschlossen : grundlage}
        disabledReason={(doc) =>
          picking === 'ausgeschlossen'
            ? inList(grundlage, doc)
              ? tr('unterlagen.isFocus')
              : null
            : inList(ausgeschlossen, doc)
              ? tr('unterlagen.isExcluded')
              : null
        }
        confirmLabel={tr('unterlagen.apply')}
        onConfirm={(docs) => {
          const names = docs.map((doc) => doc.name)
          const picked = docs.map(asPlanDocument)
          if (picking === 'ausgeschlossen') emit({ ausgeschlossen: names }, picked)
          else emit({ grundlage: names, ...(picking === 'only' ? { nurGrundlage: true, ausgeschlossen: [] } : {}) }, picked)
        }}
      />
    </div>
  )
}
