'use client'

/**
 * The plan's Unterlagen — optional, and said as a sentence rather than a
 * setting: Piloti searches the sources the run was given and picks what fits
 * the question. Nothing here needs touching for that to happen.
 *
 * What the step offers, in the order a first-time reader needs it:
 *
 * 1. „Bestimmte Unterlagen zuerst lesen …" — the one main action. The chosen
 *    documents are read in full before anything else. Inside the picker, one
 *    checkbox narrows it further: „Nur diese verwenden" confines the reader's
 *    own documents to the chosen ones (norms and laws stay available). That
 *    choice lives with the documents it is about, not in a switch beside them.
 * 2. „Unterlagen ausschließen" — rare, so behind the product's one disclosure
 *    (`Advanced`), with a summary on its trigger when something is set.
 *
 * The sources the run searches close the sentence as locked chips: they are
 * what „alles" means, fixed when the run was commissioned.
 */

import { useState, type FC } from 'react'
import { Ban, BookOpenCheck, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Advanced } from '@/components/ui/step-form'
import {
  DocumentPickerDialog,
  type PickerDocument,
} from '@/features/documents/components/document-picker/DocumentPickerDialog'
import { PickerFooterCheck } from '@/features/documents/components/document-picker/picker-atoms'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { useTranslations } from '@/i18n'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { foldName } from '@/lib/text/fold'
import { PlanActions, PlanDocLine, PlanNote, PlanSourcesLine } from './plan-atoms'

export interface PlanDocumentChoice {
  grundlage: string[]
  ausgeschlossen: string[]
  nurGrundlage: boolean
  /** The documents just chosen, so a caller can add them to the plan's inventory. */
  picked: PlanDocument[]
}

type Picking = 'first' | 'excluded' | null

/** A picked document as the plan names it: the contract's three fields, nothing of the file row. */
const asPlanDocument = (doc: PickerDocument): PlanDocument => ({
  name: doc.name,
  ...(doc.title ? { title: doc.title } : {}),
  ...(doc.shelf ? { shelf: doc.shelf } : {}),
})

export const PlanUnterlagen: FC<{
  /** What the picker offers: the project's and the Archiv's listing. */
  library: readonly PickerDocument[]
  /** How a named document is shown when the listing does not hold it (the plan's own inventory). */
  known: readonly PlanDocument[]
  folders?: readonly FolderItem[]
  loading?: boolean
  grundlage: readonly string[]
  ausgeschlossen: readonly string[]
  nurGrundlage: boolean
  /** The sources the run searches, by name; what „alles" means. */
  sources?: readonly string[]
  disabled?: boolean
  /** Called when a picker opens, so the caller can load the listing. */
  onBrowse?: () => void
  onChange: (choice: PlanDocumentChoice) => void
}> = ({
  library,
  known,
  folders,
  loading = false,
  grundlage,
  ausgeschlossen,
  nurGrundlage,
  sources = [],
  disabled = false,
  onBrowse,
  onChange,
}) => {
  const t = useTranslations('chat')
  const tr = useTranslations('runs')
  const [picking, setPicking] = useState<Picking>(null)
  // „Nur diese" is decided in the picker, beside the documents it is about,
  // and committed with them.
  const [onlyDraft, setOnlyDraft] = useState(nurGrundlage)

  const docOf = (name: string): PlanDocument => {
    const key = foldName(name)
    const fromLibrary = library.find((doc) => foldName(doc.name) === key)
    if (fromLibrary) return asPlanDocument(fromLibrary)
    return known.find((doc) => foldName(doc.name) === key) ?? { name }
  }
  const inList = (list: readonly string[], doc: PickerDocument) =>
    list.some((name) => foldName(name) === foldName(doc.name))

  const emit = (next: Partial<Omit<PlanDocumentChoice, 'picked'>>, picked: PlanDocument[] = []): void =>
    onChange({
      grundlage: [...(next.grundlage ?? grundlage)],
      ausgeschlossen: [...(next.ausgeschlossen ?? ausgeschlossen)],
      nurGrundlage: next.nurGrundlage ?? nurGrundlage,
      picked,
    })

  const open = (which: Exclude<Picking, null>): void => {
    onBrowse?.()
    setOnlyDraft(nurGrundlage)
    setPicking(which)
  }

  const firstLabel = nurGrundlage
    ? t('agentPrompt.plan.unterlagen.onlyThese')
    : t('agentPrompt.plan.unterlagen.readFirst')

  return (
    <div className="flex flex-col gap-3" data-testid="plan-unterlagen" data-scope={nurGrundlage ? 'nur' : 'alle'}>
      <PlanSourcesLine testId="plan-unterlagen-default">
        {sources.length > 0 ? (
          <>
            <span>{t('agentPrompt.plan.unterlagen.searchesLead')}</span>
            {sources.map((source) => (
              <Chip key={source} size="sm" variant="secondary">
                <Database aria-hidden />
                {source}
              </Chip>
            ))}
            <span>{t('agentPrompt.plan.unterlagen.searchesTail')}</span>
          </>
        ) : (
          t('agentPrompt.plan.unterlagen.searchesAll')
        )}
      </PlanSourcesLine>

      <PlanDocLine
        label={firstLabel}
        docs={grundlage.map(docOf)}
        removeLabel={(label) => t('agentPrompt.plan.unterlagen.removeRead', { name: label })}
        onRemove={
          disabled
            ? undefined
            : (doc) => {
                const rest = grundlage.filter((name) => foldName(name) !== foldName(doc.name))
                emit({ grundlage: rest, nurGrundlage: nurGrundlage && rest.length > 0 })
              }
        }
        testId="plan-grundlage"
      />
      {nurGrundlage && grundlage.length > 0 && (
        <PlanNote>{t('agentPrompt.plan.unterlagen.onlyTheseNote')}</PlanNote>
      )}

      {!disabled && (
        <PlanActions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => open('first')}
            data-testid="plan-unterlagen-pick"
          >
            <BookOpenCheck className="size-4" aria-hidden />
            {grundlage.length > 0
              ? t('agentPrompt.plan.unterlagen.changeFirst')
              : t('agentPrompt.plan.unterlagen.chooseFirst')}
          </Button>
        </PlanActions>
      )}

      <Advanced
        label={t('agentPrompt.plan.unterlagen.excludeLabel')}
        summary={
          ausgeschlossen.length > 0
            ? t('agentPrompt.plan.unterlagen.excludedSummary', { count: ausgeschlossen.length })
            : null
        }
        data-testid="plan-unterlagen-advanced"
      >
        <PlanNote>
          {nurGrundlage
            ? t('agentPrompt.plan.unterlagen.excludeWithOnly')
            : t('agentPrompt.plan.unterlagen.excludeHint')}
        </PlanNote>
        <PlanDocLine
          label={t('agentPrompt.plan.unterlagen.neverUsed')}
          docs={ausgeschlossen.map(docOf)}
          excluded
          removeLabel={(label) => t('agentPrompt.plan.unterlagen.removeExcluded', { name: label })}
          onRemove={
            disabled
              ? undefined
              : (doc) => emit({ ausgeschlossen: ausgeschlossen.filter((name) => foldName(name) !== foldName(doc.name)) })
          }
          testId="plan-ausgeschlossen"
        />
        {!disabled && (
          <PlanActions>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => open('excluded')}
              data-testid="plan-unterlagen-exclude"
            >
              <Ban className="size-4" aria-hidden />
              {t('agentPrompt.plan.unterlagen.chooseExcluded')}
            </Button>
          </PlanActions>
        )}
      </Advanced>

      <DocumentPickerDialog
        open={picking !== null}
        onOpenChange={(next) => !next && setPicking(null)}
        title={
          picking === 'excluded'
            ? t('agentPrompt.plan.unterlagen.pickExcludedTitle')
            : t('agentPrompt.plan.unterlagen.pickFirstTitle')
        }
        description={
          picking === 'excluded'
            ? t('agentPrompt.plan.unterlagen.pickExcludedDescription')
            : t('agentPrompt.plan.unterlagen.pickFirstDescription')
        }
        documents={library}
        folders={folders}
        loading={loading}
        initialSelected={picking === 'excluded' ? ausgeschlossen : grundlage}
        disabledReason={(doc) =>
          picking === 'excluded'
            ? inList(grundlage, doc)
              ? tr('unterlagen.isFirst')
              : null
            : inList(ausgeschlossen, doc)
              ? tr('unterlagen.isExcluded')
              : null
        }
        confirmLabel={tr('unterlagen.apply')}
        footer={
          picking === 'first' ? (
            <PickerFooterCheck
              id="plan-only-these"
              label={t('agentPrompt.plan.unterlagen.onlyTheseToggle')}
              checked={onlyDraft}
              onCheckedChange={setOnlyDraft}
              testId="plan-only-these"
            />
          ) : undefined
        }
        onConfirm={(docs) => {
          const names = docs.map((doc) => doc.name)
          const picked = docs.map(asPlanDocument)
          if (picking === 'excluded') emit({ ausgeschlossen: names }, picked)
          else emit({ grundlage: names, nurGrundlage: onlyDraft && names.length > 0 }, picked)
        }}
      />
    </div>
  )
}
