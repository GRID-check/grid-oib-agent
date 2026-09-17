'use client'

/**
 * Org skill authoring dialog (org:skills:manage). Fields: name, description
 * and the instruction body in agentskills.io format, plus the reserved
 * metadata controls the UI owns — who may use the skill (`grid-agents`, the
 * ONE availability gate), whether its live line is muted (`grid-hidden`), and
 * its preferred output cards (`grid-cards`) — and the master enabled switch.
 *
 * There is no control for `grid-auto-invoke`. It was a switch an author
 * flipped to keep a skill OUT of the model's catalog, which is a person
 * deciding whether the model may pick — the thing ADR-0060 deleted everywhere
 * else. The key is still tolerated on a stored document (it rides through as
 * unreserved metadata, like `grid-execution`), so an old row keeps loading; it
 * is simply not written, not read and not offered. Editing a clone shows
 * its source. Platform-builtin skills have no DB row and are never edited here;
 * they are cloned instead (see the toolbox).
 *
 * There is deliberately nothing here about time or output. A skill does not
 * know when it runs or what a run produces: scheduling belongs to the JOB that
 * attaches it, and the output kind is that job's choice (`jobs.output`).
 *
 * Laid out as one view rather than a wizard. The fields are few; what is not
 * few is the number of things an author has to hold in mind at once — the
 * document the fields produce, whether the description will actually be
 * matched, and where the skill will exist. All three are live beside the
 * fields, and a step-by-step flow could only show them after the fact.
 *
 * The server owns all final validation; this dialog only mirrors the write
 * boundary rules (name shape/lengths) for instant feedback.
 */

import { useCallback, useMemo, useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { FieldShell, useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Item, ItemContent, ItemDescription, ItemList, ItemTitle } from '@/components/ui/item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchField } from '@/components/ui/search-field'
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
import { cn } from '@/lib/utils'
import {
  createSkill,
  deleteSkill,
  updateSkill,
  type CreateSkillInput,
  type SkillCategoryListItem,
  type SkillListItem,
} from '@/adapters/api/skills-client'
import {
  CARD_CATALOG,
  formatPreferredCardTypes,
  parsePreferredCardTypes,
  searchCardCatalog,
} from '../lib/card-catalog'
import {
  formatAgentScope,
  parseAgentScope,
  SKILL_AGENTS,
  type AgentScope,
} from '../lib/agent-scope'
import { renderSkillDocument, type ParsedSkillDocument } from '../lib/skill-document'
import { MarkdownEditor, type MarkdownEditorLabels } from './MarkdownEditor'
import { SkillRawDocumentSection } from './SkillRawDocumentSection'
import { SkillDocumentPreview } from './SkillDocumentPreview'
import { Stepper } from '@/components/ui/stepper'
import { Advanced, StepHeading } from '@/components/ui/step-form'
import { SkillFindingList } from './SkillFindingList'
import { SkillReviewPanel } from './SkillReviewPanel'
import { useSkillReview, type SkillReviewField } from '../hooks/use-skill-review'
import { capturePosthog } from '@/lib/analytics/posthog'

/** Rule names must satisfy server-side: lowercase a-z/0-9, single hyphens. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * The description budget, mirrored from the write boundary.
 *
 * Shown as a live counter rather than only as a rejection: this one field is
 * the entire basis on which an agent decides to load the skill, so an author
 * writing it deserves to see how much room they still have while they write —
 * not after the save bounces.
 */
const DESCRIPTION_MAX = 1024

/** Everything except the keys this dialog owns a control for. */
function withoutReservedKeys(metadata: Record<string, string>): Record<string, string> {
  const owned = new Set([
    METADATA_CARDS,
    METADATA_AGENTS,
    METADATA_HIDDEN,
  ])
  const rest: Record<string, string> = {}
  for (const key of Object.keys(metadata)) {
    if (owned.has(key)) continue
    rest[key] = metadata[key]
  }
  return rest
}

/**
 * Reserved metadata keys the editor writes.
 *
 * Spelled out here rather than imported from `@/lib/skills/types`: that module
 * is the server-side write boundary and pulls in the Drizzle schema, which has
 * no business in a client bundle. The values are asserted against the stored
 * document by this dialog's spec.
 */
const METADATA_CARDS = 'grid-cards'
const METADATA_AGENTS = 'grid-agents'
const METADATA_HIDDEN = 'grid-hidden'

const HIDDEN_TRUE = new Set(['true', '1', 'yes'])

function readHidden(metadata?: Record<string, string>): boolean {
  return HIDDEN_TRUE.has((metadata?.[METADATA_HIDDEN] ?? '').trim().toLowerCase())
}

/**
 * Where the document this dialog writes actually goes, and what its master
 * switch means.
 *
 * A seam, not a generalisation for its own sake. A skill curated in Platform →
 * Skills is the SAME agentskills.io document as one authored in an
 * organization — same name rules, same description budget, same reviewer, same
 * preview — and the only differences are the endpoint it is saved to and
 * whether the switch reads "enabled for this org" or "published to the fleet".
 * Writing a second dialog for those two differences would fork the SKILL.md
 * authoring experience in two, and the copy that gets less use is the one that
 * would quietly rot.
 *
 * Omitted, everything below defaults to the org toolbox.
 */
export interface SkillPersistence {
  /**
   * Persist the document. `enabled` carries the master switch's position;
   * `categoryId` the picker's (a UUID, or null for unsorted).
   */
  save: (input: CreateSkillInput & { categoryId?: string | null }, enabled: boolean) => Promise<void>
  /** Remove it while editing. Omitted = the dialog offers no delete. */
  remove?: () => Promise<void>
  /** Copy for the master switch. */
  switchLabels?: { label: string; hint: string }
  /** Copy for the header. */
  titles?: { create: string; edit: string; createSubtitle: string; editSubtitle: string }
  /** Toast on a successful save. */
  successMessage?: { create: string; edit: string }
  /**
   * Copy for the delete confirmation.
   *
   * The default text is about an org toolbox and the job snapshots a deletion
   * leaves running — true there, and wrong in front of a platform owner
   * withdrawing a skill from the whole fleet.
   */
  deleteCopy?: { title: string; description: string; confirm: string }
}

interface SkillEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The skill being edited, or null when creating. */
  skill: SkillListItem | null
  /** Where the document goes. Defaults to this organization's toolbox. */
  persistence?: SkillPersistence
  /**
   * The categories on offer — this org's categories for the toolbox, the platform
   * categories for the catalogue. Empty means unsorted is the only answer.
   */
  categories?: SkillCategoryListItem[]
  onSaved: () => void
}

interface EditorValues {
  name: string
  description: string
  body: string
}

/**
 * The three questions, in the order an author can actually answer them.
 *
 * `what` before `instructions` because a skill that cannot be FOUND is not a
 * skill — the name and the one-line description are the whole of what an agent
 * reads every turn, and writing them first is writing the contract before the
 * implementation. `check` last because it reads all three.
 */
const STEP_KEYS = ['what', 'instructions', 'check'] as const
type StepKey = (typeof STEP_KEYS)[number]

/** Which step holds each field a finding can be about. */
const STEP_FOR_FIELD: Record<SkillReviewField, StepKey> = {
  name: 'what',
  description: 'what',
  body: 'instructions',
}

/** The control to put the caret in when a finding sends the author to a field. */
const CONTROL_ID: Record<SkillReviewField, string> = {
  name: 'name',
  description: 'description',
  body: 'skill-body',
}

export function SkillEditorDialog({
  open,
  onOpenChange,
  skill,
  persistence,
  categories = [],
  onSaved,
}: SkillEditorDialogProps): JSX.Element {
  const t = useTranslations('skills')
  const isEdit = skill !== null
  /**
   * The row every field starts from. Null for a new skill.
   *
   * Read in state INITIALISERS, which run once per mount — so this dialog is
   * remounted per open (`skills-panel.tsx` keys it). Seeding in an effect
   * instead would fight the author for the fields they had already typed into.
   */
  const source: SkillListItem | null = skill
  const [preferredCards, setPreferredCards] = useState<string[]>(() =>
    parsePreferredCardTypes(source?.metadata[METADATA_CARDS]),
  )
  const [cardQuery, setCardQuery] = useState('')
  /**
   * Which agents may use this skill (`grid-agents`).
   *
   * This is the ONLY scope there is. Absent means every agent, which is the
   * default a new skill gets — most skills are useful to both, and the ones
   * that are not say so.
   */
  const [agents, setAgents] = useState<AgentScope>(() =>
    parseAgentScope(source?.metadata[METADATA_AGENTS]),
  )
  /**
   * Whether a successful activation stays off the live one-liner.
   *
   * Default off (visible). On writes `grid-hidden: true`. A presentation choice
   * about the REPORT — whether this activation is worth a line while the answer
   * is being written — never about whether the skill runs. The skill is still
   * named under the answer either way.
   */
  const [hidden, setHidden] = useState(() => readHidden(source?.metadata))
  /**
   * Metadata keys this UI has no control for (anything a future version adds),
   * carried through a save untouched.
   *
   * Held in STATE rather than read off `skill` at build time so the raw
   * document section can also remove one: a SKILL.md pasted without a key
   * means the author deleted it, and re-adding it from the original row would
   * quietly overrule them.
   */
  const [extraMetadata, setExtraMetadata] = useState<Record<string, string>>(() =>
    source ? withoutReservedKeys(source.metadata) : {},
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
    const metadata: Record<string, string> = {}
    const scope = formatAgentScope(agents)
    if (scope) metadata[METADATA_AGENTS] = scope
    // Absent, not empty: "no preference" is the default, and an empty
    // `grid-cards:` line in the preview would read as a setting the author has
    // to understand rather than one they never touched.
    if (preferredCards.length > 0) {
      metadata[METADATA_CARDS] = formatPreferredCardTypes(preferredCards)
    }
    if (hidden) metadata[METADATA_HIDDEN] = 'true'
    return { ...metadata, ...extraMetadata }
  }, [agents, extraMetadata, hidden, preferredCards])
  const [enabled, setEnabled] = useState(isEdit ? skill.enabled : true)
  /**
   * The category this skill stands on, or null for unsorted.
   *
   * Arrangement, not document: pasting a whole SKILL.md (`applyDocument`)
   * leaves it alone — the document carries no category, and a paste that
   * re-categorized would surprise on every import.
   */
  const [categoryId, setCategoryId] = useState<string | null>(source?.categoryId ?? null)
  /**
   * Whether the draft as it now stands has been through the check.
   *
   * The save waits on it. A skill is an instruction the model will act on
   * unsupervised, and the one failure the author cannot see from inside the
   * form is a description that never gets matched — which is what the reviewer
   * reads for. Making the check a step, rather than a button beside the form
   * that nobody presses, is the only way that reading actually happens.
   *
   * What the findings SAY is not a condition. Blocking a save on a model's
   * verdict would be the forcing this codebase removed from every other
   * surface, aimed at the author instead of the agent; and a reviewer that
   * could not run blocks nothing at all, because our outage is not the
   * author's to pay for.
   */
  const [stepIndex, setStepIndex] = useState(0)
  /**
   * The furthest step reached, so everything behind the reader is a button and
   * nothing ahead is. A stepper that let somebody jump to the end would offer a
   * shortcut the form's own validation then takes back.
   */
  const [furthest, setFurthest] = useState(0)
  const step: StepKey = STEP_KEYS[stepIndex] ?? 'what'
  /**
   * Take the author to the field a finding is about, and put the caret in it.
   *
   * The focus waits a frame: the step it belongs to has not rendered at the
   * moment the row is pressed, so there is nothing to focus yet.
   */
  const goToField = useCallback((field: SkillReviewField) => {
    setStepIndex(STEP_KEYS.indexOf(STEP_FOR_FIELD[field]))
    requestAnimationFrame(() => {
      document.getElementById(CONTROL_ID[field])?.focus()
    })
  }, [])

  const goTo = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(next, STEP_KEYS.length - 1))
    setStepIndex(clamped)
    setFurthest((seen) => Math.max(seen, clamped))
  }, [])

  /**
   * What the last step's „Erweitert" is already holding, so nobody has to open
   * it to find out. An advanced section that quietly carries three of your
   * answers is a trap.
   */
  const advancedSummary = [
    agents.selected.length < SKILL_AGENTS.length ? t('editor.agents.heading') : null,
    hidden ? t('editor.hiddenLabel') : null,
    categoryId ? t('editor.category.heading') : null,
    preferredCards.length > 0 ? t('editor.cards.heading') : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  const [formError, setFormError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const catalogByType = useMemo(
    () => new Map(CARD_CATALOG.map((entry) => [entry.type, entry])),
    [],
  )
  /**
   * The pickable rows: the catalogue filtered by the query, minus what is
   * already chosen — a selected card is shown as a chip above, and leaving it in
   * the list too would make the list the second place to un-select it.
   */
  const cardResults = useMemo(
    () => searchCardCatalog(cardQuery).filter((entry) => !preferredCards.includes(entry.type)),
    [cardQuery, preferredCards],
  )
  const addCard = useCallback((type: string) => {
    setPreferredCards((current) => (current.includes(type) ? current : [...current, type]))
  }, [])
  const removeCard = useCallback((type: string) => {
    setPreferredCards((current) => current.filter((entry) => entry !== type))
  }, [])

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
      name: source?.name ?? '',
      description: source?.description ?? '',
      body: source?.body ?? '',
    } satisfies EditorValues,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setFormError(null)
      const metadata = buildMetadata()

      const document = {
        name: value.name.trim(),
        description: value.description.trim(),
        body: value.body.trim(),
        metadata,
        enabled,
      }
      // Omitted on create when unsorted (the schema takes no null there);
      // explicit null on edit removes the category. The category is
      // arrangement, and an edit that never touched the picker must not
      // move it.
      const payload: CreateSkillInput & { categoryId?: string | null } = isEdit
        ? { ...document, categoryId }
        : categoryId !== null
          ? { ...document, categoryId }
          : document

      try {
        if (persistence) {
          await persistence.save(payload, enabled)
          toast.success(
            isEdit
              ? (persistence.successMessage?.edit ?? t('editor.updateSuccess'))
              : (persistence.successMessage?.create ?? t('editor.createSuccess')),
          )
        } else if (isEdit) {
          await updateSkill(skill.id!, payload)
          toast.success(t('editor.updateSuccess'))
        } else {
          const { categoryId: unsorted, ...createPayload } = payload
          await createSkill(
            unsorted !== null && unsorted !== undefined
              ? { ...createPayload, categoryId: unsorted }
              : createPayload,
          )
          toast.success(t('editor.createSuccess'))
        }
        capturePosthog(isEdit ? 'skill_updated' : 'skill_created', {
          scope: persistence ? 'platform' : 'organization',
          enabled,
          hidden,
          preferred_card_count: preferredCards.length,
          agent_count: agents.selected.length,
        })
        onSaved()
      } catch {
        setFormError(t('editor.saveError'))
        toast.error(t('editor.saveError'))
      }
    },
  })

  /**
   * The draft as it stands, subscribed rather than read off `form.state`.
   *
   * The review's staleness is derived from these three strings, so they have to
   * cause a render when they change — a snapshot read in the body would leave a
   * verdict looking current about text that has moved on, which is the one lie
   * this surface must not tell.
   */
  const liveName = useStore(form.store, (state) => (state.values as EditorValues).name)
  const liveDescription = useStore(
    form.store,
    (state) => (state.values as EditorValues).description,
  )
  const liveBody = useStore(form.store, (state) => (state.values as EditorValues).body)
  const review = useSkillReview({
    name: liveName,
    description: liveDescription,
    body: liveBody,
  })

  /**
   * The steps, each marked with what the reviewer left open on it.
   *
   * This is the map a revision is done from: the critique sits under the field
   * it is about, and the rail says which steps still hold one — so an author
   * who has just read the verdict knows where to go without holding a list in
   * their head. Marked only while the verdict is CURRENT; a stale one describes
   * a draft that no longer exists.
   */
  const openOnStep = (key: StepKey): number =>
    review.stale
      ? 0
      : review.findings.filter((finding) => STEP_FOR_FIELD[finding.field] === key).length
  const steps = STEP_KEYS.map((key) => {
    const open = openOnStep(key)
    return {
      key,
      label: t(`editor.steps.${key}`),
      ...(open > 0 ? { note: t('editor.review.openCount', { count: open }) } : {}),
    }
  })


  /**
   * A whole SKILL.md, written back into the form.
   *
   * Every field the document can carry is replaced, including the ones it does
   * NOT mention: a metadata key the author removed has to disappear, or the
   * advanced section would be able to add settings but never take them away.
   */
  const applyDocument = useCallback(
    (parsed: ParsedSkillDocument) => {
      form.setFieldValue('name', parsed.name)
      form.setFieldValue('description', parsed.description)
      form.setFieldValue('body', parsed.body)
      setPreferredCards(parsePreferredCardTypes(parsed.metadata[METADATA_CARDS]))
      setAgents(parseAgentScope(parsed.metadata[METADATA_AGENTS]))
      setHidden(readHidden(parsed.metadata))
      setExtraMetadata(withoutReservedKeys(parsed.metadata))
      toast.success(t('editor.raw.applied'))
    },
    [form, t],
  )

  /** Toolbar tooltips for the Markdown editor, in the UI language. */
  const markdownLabels = useMemo<MarkdownEditorLabels>(
    () => ({
      h1: t('editor.markdown.h1'),
      h2: t('editor.markdown.h2'),
      h3: t('editor.markdown.h3'),
      bold: t('editor.markdown.bold'),
      italic: t('editor.markdown.italic'),
      code: t('editor.markdown.code'),
      codeBlock: t('editor.markdown.codeBlock'),
      bulletList: t('editor.markdown.bulletList'),
      numberedList: t('editor.markdown.numberedList'),
      taskList: t('editor.markdown.taskList'),
      link: t('editor.markdown.link'),
      quote: t('editor.markdown.quote'),
      table: t('editor.markdown.table'),
      edit: t('editor.markdown.edit'),
      split: t('editor.markdown.split'),
      preview: t('editor.markdown.preview'),
      fullscreen: t('editor.markdown.fullscreen'),
    }),
    [t],
  )

  /** Deletable only while editing, and only where the caller says how. */
  const canDelete = isEdit && (persistence ? Boolean(persistence.remove) : true)

  const confirmDelete = async () => {
    if (!skill) return
    setDeleting(true)
    try {
      if (persistence?.remove) await persistence.remove()
      else await deleteSkill(skill.id!)
      capturePosthog('skill_deleted', { scope: persistence ? 'platform' : 'organization' })
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
        {/* A reading column, not a page.

            This used to be a `sm:max-w-5xl` two-column form: the document on
            the left, a rail of eight settings on the right, everything at once.
            It asked an author to hold the whole skill in their head before
            they had written a line of it, and the rail — agents, cards,
            category, two switches — sat at the same weight as the description,
            which is the ONE field that decides whether the skill is ever
            picked.

            It is a stepped form now, the same shape and the same `Stepper` the
            task builder wears, because it asks the same kind of thing: a short
            sequence of questions where knowing how many are left is what
            decides whether somebody finishes. Everything that is not the
            document is behind one „Erweitert" on the last step. */}
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-border shrink-0 border-b px-6 py-5 pr-14">
            <DialogTitle>
              {isEdit
                ? (persistence?.titles?.edit ?? t('editor.editTitle'))
                : (persistence?.titles?.create ?? t('editor.createTitle'))}
            </DialogTitle>
            <DialogDescription>
              {isEdit
                ? (persistence?.titles?.editSubtitle ?? t('editor.editSubtitle'))
                : (persistence?.titles?.createSubtitle ?? t('editor.createSubtitle'))}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void form.handleSubmit()
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="flex flex-col gap-6">
                <Stepper
                  steps={steps}
                  current={stepIndex}
                  furthest={furthest}
                  onSelect={goTo}
                  label={t('editor.steps.label')}
                  progressLabel={t('editor.steps.progress', {
                    current: stepIndex + 1,
                    total: STEP_KEYS.length,
                  })}
                />

                <div className="min-h-[24rem]">
                  {step === 'what' && (
                    <section data-testid="skill-step-what">
                      <StepHeading
                        title={t('editor.steps.whatTitle')}
                        hint={t('editor.steps.whatHint')}
                      />
                      <div className="flex flex-col gap-5">
                        <form.AppField name="name">
                          {(field) => (
                            <field.TextField
                              label={t('editor.nameLabel')}
                              placeholder={t('editor.namePlaceholder')}
                              description={t('editor.nameHint')}
                              required
                              className="font-mono"
                            />
                          )}
                        </form.AppField>
                        {/* The reviewer's findings about THIS field, under it. The
                            critique belongs beside the thing criticised: an author revising
                            the name should not have to walk two steps back carrying the
                            advice in their head. */}
                        <SkillFindingList
                          findings={review.findingsFor('name')}
                          variant="inline"
                          stale={review.stale}
                          data-testid="skill-findings-name"
                        />
                        {/* The description is not a caption. It is the ONLY
                            thing an agent reads before deciding whether to load
                            the skill, so it gets its own step beside the name
                            and nothing else competes with it. */}
                        <form.AppField name="description">
                          {(field) => (
                            <div className="flex flex-col gap-1.5">
                              <field.TextAreaField
                                label={t('editor.descriptionLabel')}
                                placeholder={t('editor.descriptionPlaceholder')}
                                required
                                rows={3}
                              />
                              <div className="flex items-start justify-between gap-4">
                                <p className="text-muted-foreground text-xs leading-snug">
                                  {t('editor.descriptionHint')}
                                </p>
                                <span
                                  className={cn(
                                    'shrink-0 text-xs tabular-nums',
                                    (field.state.value ?? '').length > DESCRIPTION_MAX
                                      ? 'text-destructive'
                                      : 'text-muted-foreground',
                                  )}
                                >
                                  {(field.state.value ?? '').length}/{DESCRIPTION_MAX}
                                </span>
                              </div>
                            </div>
                          )}
                        </form.AppField>
                        {/* The reviewer's findings about THIS field, under it. The
                            critique belongs beside the thing criticised: an author revising
                            the description should not have to walk two steps back carrying the
                            advice in their head. */}
                        <SkillFindingList
                          findings={review.findingsFor('description')}
                          variant="inline"
                          stale={review.stale}
                          data-testid="skill-findings-description"
                        />
                      </div>
                    </section>
                  )}

                  {step === 'instructions' && (
                    <section data-testid="skill-step-instructions">
                      <StepHeading
                        title={t('editor.steps.instructionsTitle')}
                        hint={t('editor.steps.instructionsHint')}
                      />
                    <form.AppField name="body">
                      {(field) => {
                        const errors = field.state.meta.isTouched
                          ? (field.state.meta.errors as Array<string | { message: string } | undefined>)
                          : []
                        return (
                          <FieldShell
                            label={t('editor.bodyLabel')}
                            description={t('editor.bodyHint')}
                            required
                            htmlFor="skill-body"
                            errors={errors}
                          >
                            <MarkdownEditor
                              id="skill-body"
                              value={field.state.value ?? ''}
                              onChange={field.handleChange}
                              onBlur={field.handleBlur}
                              placeholder={t('editor.bodyPlaceholder')}
                              invalid={errors.length > 0}
                              labels={markdownLabels}
                            />
                          </FieldShell>
                        )
                      }}
                    </form.AppField>
                    {/* The reviewer's findings about THIS field, under it. The
                        critique belongs beside the thing criticised: an author revising
                        the instructions should not have to walk two steps back carrying the
                        advice in their head. */}
                    <SkillFindingList
                      findings={review.findingsFor('body')}
                      variant="inline"
                      stale={review.stale}
                      data-testid="skill-findings-body"
                    />
                      <form.Subscribe selector={(state) => state.values}>
                        {(values) => (
                          /* Not wrapped in `Advanced`: this section brings its
                             own disclosure, and a fold inside a fold is two
                             chevrons for one act. It is the only control that
                             can rewrite every field at once, so it sits last. */
                          <SkillRawDocumentSection
                            document={renderSkillDocument({
                              name: values.name,
                              description: values.description,
                              body: values.body,
                              metadata: buildMetadata(),
                            })}
                            onApply={applyDocument}
                          />
                        )}
                      </form.Subscribe>
                    </section>
                  )}

                  {step === 'check' && (
                    <section data-testid="skill-step-check">
                      <StepHeading
                        title={t('editor.steps.checkTitle')}
                        hint={t('editor.steps.checkHint')}
                      />
                      <form.Subscribe selector={(state) => state.values}>
                        {(values) => (
                          <div className="flex flex-col gap-5">
                            {/* The check is the step. Running it is what opens
                                the save; what it finds is the author's to
                                weigh. */}
                            <SkillReviewPanel
                              state={review.state}
                              stale={review.stale}
                              findings={review.findings}
                              onRun={() => void review.run()}
                              onGoToField={goToField}
                            />
                            <SkillDocumentPreview
                              name={values.name}
                              description={values.description}
                              body={values.body}
                              metadata={buildMetadata()}
                            />
                            <Advanced
                              label={t('editor.steps.advanced')}
                              summary={advancedSummary || null}
                              data-testid="skill-advanced"
                            >
                            <section className="border-border flex flex-col gap-4 rounded-xl border p-4">
                              <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-medium">{t('editor.agents.heading')}</h3>
                                <p className="text-muted-foreground text-xs">{t('editor.agents.hint')}</p>
                              </div>

                              <div className="flex flex-col gap-2.5">
                                {SKILL_AGENTS.map((agent) => {
                                  const checked = agents.selected.includes(agent)
                                  // Un-checking the last one would mean "available to no
                                  // agent", which `grid-agents` cannot express — an empty
                                  // allowlist reads as "all agents" to both resolvers. So
                                  // the last remaining box is held.
                                  const last = checked && agents.selected.length === 1
                                  const key = agent === 'researcher' ? 'chat' : 'deep'
                                  return (
                                    <Field
                                      key={agent}
                                      orientation="horizontal"
                                      className="justify-start gap-2.5"
                                    >
                                      <Checkbox
                                        id={`skill-agent-${agent}`}
                                        checked={checked}
                                        disabled={last}
                                        onCheckedChange={(next) =>
                                          setAgents((current) => ({
                                            ...current,
                                            selected:
                                              next === true
                                                ? SKILL_AGENTS.filter(
                                                    (name) =>
                                                      name === agent || current.selected.includes(name),
                                                  )
                                                : current.selected.filter((name) => name !== agent),
                                          }))
                                        }
                                        className="mt-0.5"
                                      />
                                      <div className="flex min-w-0 flex-col gap-0.5">
                                        <FieldLabel
                                          htmlFor={`skill-agent-${agent}`}
                                          className="font-medium"
                                        >
                                          {t(`editor.agents.${key}.label`)}
                                        </FieldLabel>
                                        <FieldDescription className="leading-snug">
                                          {t(`editor.agents.${key}.hint`)}
                                        </FieldDescription>
                                      </div>
                                    </Field>
                                  )
                                })}
                              </div>
                              <Field orientation="horizontal">
                                <div className="flex min-w-0 flex-col gap-0.5">
                                  <FieldLabel htmlFor="skill-hidden">{t('editor.hiddenLabel')}</FieldLabel>
                                  <FieldDescription>{t('editor.hiddenHint')}</FieldDescription>
                                </div>
                                <Switch id="skill-hidden" checked={hidden} onCheckedChange={setHidden} />
                              </Field>

                              <Field orientation="horizontal">
                                <div className="flex min-w-0 flex-col gap-0.5">
                                  <FieldLabel htmlFor="skill-enabled">
                                    {persistence?.switchLabels?.label ?? t('editor.enabledLabel')}
                                  </FieldLabel>
                                  <FieldDescription>
                                    {persistence?.switchLabels?.hint ?? t('editor.enabledHint')}
                                  </FieldDescription>
                                </div>
                                <Switch id="skill-enabled" checked={enabled} onCheckedChange={setEnabled} />
                              </Field>
                              </section>
                            <section className="border-border flex flex-col gap-2 rounded-xl border p-4">
                              <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-medium">{t('editor.category.heading')}</h3>
                                <p className="text-muted-foreground text-xs">{t('editor.category.hint')}</p>
                              </div>
                              <Field>
                                <FieldLabel htmlFor="skill-category">{t('editor.category.label')}</FieldLabel>
                                <Select
                                  value={categoryId ?? '__unsorted__'}
                                  onValueChange={(next) => setCategoryId(next === '__unsorted__' ? null : next)}
                                >
                                  <SelectTrigger id="skill-category">
                                    <SelectValue placeholder={t('editor.category.unsorted')} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__unsorted__">{t('editor.category.unsorted')}</SelectItem>
                                    {categories.map((category) => (
                                      <SelectItem key={category.id} value={category.id}>
                                        {category.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </Field>
                            </section>
                            <section className="border-border flex flex-col gap-2 rounded-xl border p-4">
                              <div className="flex flex-col gap-0.5">
                                <h3 className="text-sm font-medium">{t('editor.cards.heading')}</h3>
                                <p className="text-muted-foreground text-xs">{t('editor.cards.hint')}</p>
                              </div>

                              {preferredCards.length === 0 ? (
                                <EmptyState variant="bare" title={t('editor.cards.empty')} className="py-3" />
                              ) : (
                                <ul className="flex flex-col gap-1.5">
                                  {preferredCards.map((type) => (
                                    <li key={type} className="flex flex-col items-start gap-0.5">
                                      <Chip variant="secondary" size="sm">
                                        <span className="font-mono">{type}</span>
                                        <button
                                          type="button"
                                          aria-label={t('editor.cards.removeAria', { type })}
                                          onClick={() => removeCard(type)}
                                          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -mr-0.5 rounded-sm leading-none transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2"
                                        >
                                          <X className="size-3" aria-hidden />
                                        </button>
                                      </Chip>
                                      <span className="text-muted-foreground text-xs">
                                        {catalogByType.get(type)?.description}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}

                              <SearchField
                                type="text"
                                value={cardQuery}
                                onChange={setCardQuery}
                                placeholder={t('editor.cards.searchPlaceholder')}
                                label={t('editor.cards.searchPlaceholder')}
                              />

                              <div className="h-44">
                                {cardResults.length === 0 ? (
                                  <EmptyState
                                    variant="bare"
                                    title={t('editor.cards.noMatches')}
                                    className="flex h-full items-center py-3"
                                  />
                                ) : (
                                  <ScrollArea className="h-full">
                                    <ItemList>
                                      {cardResults.map((entry) => (
                                        <Item key={entry.type} asChild>
                                          <button type="button" onClick={() => addCard(entry.type)}>
                                            <ItemContent>
                                              <ItemTitle className="font-mono">{entry.type}</ItemTitle>
                                              <ItemDescription>{entry.description}</ItemDescription>
                                            </ItemContent>
                                          </button>
                                        </Item>
                                      ))}
                                    </ItemList>
                                  </ScrollArea>
                                )}
                              </div>
                            </section>
                            </Advanced>
                          </div>
                        )}
                      </form.Subscribe>
                    </section>
                  )}
                </div>
              </div>
            </div>

            <div className="border-border bg-popover shrink-0 border-t px-6 py-4">
              {formError && (
                <Alert variant="destructive" className="mb-3">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}
              {/* Back / Weiter, and Speichern only on the last step — the task
                  builder's nav, because this is the same kind of form.
                  „Weiter" never validates: a stepped form that refuses to move
                  on is one people answer defensively, and every field is
                  validated on the save anyway. */}
              <DialogFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => (stepIndex === 0 ? onOpenChange(false) : goTo(stepIndex - 1))}
                  data-testid="skill-back"
                >
                  {stepIndex === 0 ? t('editor.cancel') : t('editor.steps.back')}
                </Button>
                {step !== 'check' ? (
                  <Button type="button" onClick={() => goTo(stepIndex + 1)} data-testid="skill-next">
                    {t('editor.steps.next')}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
              {canDelete && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setConfirmOpen(true)}
                >
                  {t('actions.delete')}
                </Button>
              )}
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting] as const}
              >
                {([canSubmit, isSubmitting]) => (
                  <Button
                    type="submit"
                    disabled={!canSubmit || isSubmitting || !review.gate.checked}
                    aria-busy={isSubmitting}
                    // Named, not just greyed: a disabled button with no
                    // reason is a dead end, and the reason here is a step the
                    // author can take in one click.
                    aria-describedby={review.gate.checked ? undefined : 'skill-review-required'}
                  >
                    <span className="inline-grid justify-items-start">
                      <span
                        className={cn(
                          'col-start-1 row-start-1 inline-flex items-center gap-2',
                          isSubmitting && 'invisible',
                        )}
                        aria-hidden={isSubmitting}
                      >
                        {t('editor.save')}
                      </span>
                      <span
                        className={cn(
                          'col-start-1 row-start-1 inline-flex items-center gap-2',
                          !isSubmitting && 'invisible',
                        )}
                        aria-hidden={!isSubmitting}
                      >
                        <Spinner size="sm" aria-hidden />
                        {t('editor.saving')}
                      </span>
                    </span>
                  </Button>
                )}
              </form.Subscribe>
                  </div>
                )}
              </DialogFooter>
              {step === 'check' && !review.gate.checked && (
                <p
                  id="skill-review-required"
                  className="text-muted-foreground mt-2 text-right text-xs"
                  data-testid="skill-review-required"
                >
                  {t('editor.review.required')}
                </p>
              )}
            </div>

          </form>
        </DialogContent>
      </Dialog>

      {/* Edit-mode delete: removes the skill from the toolbox; schedules keep
          their saved snapshot, so they keep running unchanged. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone="destructive"
        title={persistence?.deleteCopy?.title ?? t('editor.deleteTitle')}
        description={
          persistence?.deleteCopy?.description ??
          t('editor.deleteDescription', { name: skill?.name ?? '' })
        }
        confirmLabel={persistence?.deleteCopy?.confirm ?? t('editor.deleteConfirm')}
        cancelLabel={t('editor.cancel')}
        pending={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}
