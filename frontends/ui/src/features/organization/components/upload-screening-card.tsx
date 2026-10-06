'use client'

/**
 * Organisation → Sensible Daten: the office's upload-screening policy
 * (ADR-0079), as one form.
 *
 * Two gates read it. Names are checked in the browser before anything is sent;
 * content is checked on Piloti's server before any model reads it. The form is
 * laid out in that order, so each list sits under the sentence that says when
 * it runs. The last sentence says what the check cannot do: it sees words and
 * number shapes, not meaning, and the ADR forbids the UI claiming more.
 *
 * Every member may read it (an uploader whose file was held back comes here to
 * find out why); only `org:settings:manage` may change it, and the PUT enforces
 * that again. While the office has never saved a list, Piloti's suggestion is in
 * force and the form says so; saving it unchanged makes it the office's own.
 */

import { type FC, useCallback, useEffect, useState } from 'react'
import { Info, Lock, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'

import { ApiRequestError } from '@/adapters/api/api-error'
import {
  getUploadScreening,
  saveUploadScreening,
  type UploadScreeningState,
} from '@/adapters/api/upload-screening-client'
import { clearUploadScreeningPolicyCache } from '@/adapters/api/upload-screening-policy'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { SectionLabel } from '@/components/ui/section-label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { TagInput } from '@/components/ui/tag-input'
import { useTranslations } from '@/i18n'
import {
  normalizeTermList,
  SCREENING_DETECTORS,
  uploadScreeningPolicySchema,
  type ScreeningDetector,
  type UploadScreeningPolicy,
} from '@/lib/upload-screening/policy'

type TermListKey = 'nameTerms' | 'nameExceptions' | 'contentTerms'

/** The policy as it will be saved: clean term lists, detectors in their canonical order. */
export function normalizeScreeningPolicy(policy: UploadScreeningPolicy): UploadScreeningPolicy {
  return {
    enabled: policy.enabled,
    nameTerms: normalizeTermList(policy.nameTerms),
    nameExceptions: normalizeTermList(policy.nameExceptions),
    contentTerms: normalizeTermList(policy.contentTerms),
    detectors: SCREENING_DETECTORS.filter((detector) => policy.detectors.includes(detector)),
  }
}

const samePolicy = (a: UploadScreeningPolicy, b: UploadScreeningPolicy): boolean =>
  JSON.stringify(normalizeScreeningPolicy(a)) === JSON.stringify(normalizeScreeningPolicy(b))

/** Loads the policy, then hands it to the form. */
export const UploadScreeningCard: FC<{ canEdit: boolean }> = ({ canEdit }) => {
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const [state, setState] = useState<UploadScreeningState | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    setFailed(false)
    try {
      setState(await getUploadScreening(signal))
    } catch {
      if (!signal?.aborted) setFailed(true)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  if (failed) {
    return (
      <EmptyState
        variant="bare"
        title={t('screening.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {tc('actions.retry')}
          </Button>
        }
      />
    )
  }
  if (!state) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={tc('states.loading')}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  return <UploadScreeningForm initial={state} canEdit={canEdit} />
}

export const UploadScreeningForm: FC<{ initial: UploadScreeningState; canEdit: boolean }> = ({
  initial,
  canEdit,
}) => {
  const t = useTranslations('organization')
  const tc = useTranslations('common')
  const [draft, setDraft] = useState<UploadScreeningPolicy>(initial.policy)
  const [baseline, setBaseline] = useState<UploadScreeningPolicy>(initial.policy)
  const [suggested, setSuggested] = useState(initial.suggested)
  const [saving, setSaving] = useState(false)
  const readOnly = !canEdit

  const dirty = !samePolicy(draft, baseline)
  // Saving the suggestion unchanged is a real act: it becomes the office's own
  // list, which a later change to Piloti's suggestion no longer moves.
  const canSave = canEdit && !saving && (dirty || suggested)
  const atSuggestion = samePolicy(draft, initial.suggestion)

  const setTerms = (key: TermListKey) => (terms: string[]) => setDraft((prev) => ({ ...prev, [key]: terms }))

  const toggleDetector = (detector: ScreeningDetector, on: boolean): void =>
    setDraft((prev) => ({
      ...prev,
      detectors: on ? [...prev.detectors, detector] : prev.detectors.filter((d) => d !== detector),
    }))

  const save = async (): Promise<void> => {
    const parsed = uploadScreeningPolicySchema.safeParse(normalizeScreeningPolicy(draft))
    if (!parsed.success) {
      toast.error(t('screening.invalid'))
      return
    }
    setSaving(true)
    try {
      const saved = await saveUploadScreening(parsed.data)
      setBaseline(saved.policy)
      setDraft(saved.policy)
      setSuggested(saved.suggested)
      // The upload dialog on this page reads the policy through a short cache.
      clearUploadScreeningPolicyCache()
      toast.success(t('screening.saved'))
    } catch (error) {
      toast.error(
        error instanceof ApiRequestError && error.status === 403 ? t('screening.saveForbidden') : t('screening.saveError')
      )
    } finally {
      setSaving(false)
    }
  }

  const termList = (key: TermListKey, label: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={readOnly ? undefined : `screening-${key}`}>{label}</FieldLabel>
      <TagInput
        id={`screening-${key}`}
        value={draft[key]}
        onChange={setTerms(key)}
        normalize={normalizeTermList}
        readOnly={readOnly}
        aria-label={label}
        aria-describedby={`screening-${key}-hint`}
        placeholder={t('screening.termPlaceholder')}
        removeLabel={(term) => t('screening.removeTerm', { term })}
        emptyLabel={t('screening.emptyList')}
      />
      <FieldDescription id={`screening-${key}-hint`}>{hint}</FieldDescription>
    </Field>
  )

  return (
    <FieldGroup className="gap-6" data-testid="upload-screening-form">
      {readOnly && (
        <FieldDescription className="flex items-center gap-1.5" data-testid="upload-screening-readonly">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {t('screening.readOnly')}
        </FieldDescription>
      )}

      <Field orientation="horizontal" className="rounded-lg border p-4">
        <div className="min-w-0">
          <FieldLabel htmlFor="screening-enabled">{t('screening.enabled')}</FieldLabel>
          <FieldDescription className="mt-0.5">{t('screening.enabledHint')}</FieldDescription>
        </div>
        <Switch
          id="screening-enabled"
          checked={draft.enabled}
          disabled={readOnly || saving}
          onCheckedChange={(enabled) => setDraft((prev) => ({ ...prev, enabled }))}
          aria-label={t('screening.enabled')}
        />
      </Field>

      {suggested && (
        <Alert variant="info" data-testid="upload-screening-suggested">
          <Info />
          <AlertTitle>{t('screening.suggestedTitle')}</AlertTitle>
          <AlertDescription>{t('screening.suggestedBody')}</AlertDescription>
        </Alert>
      )}

      <FieldGroup>
        <div>
          <SectionLabel as="h3">{t('screening.namesTitle')}</SectionLabel>
          <FieldDescription className="mt-1">{t('screening.namesHint')}</FieldDescription>
        </div>
        {termList('nameTerms', t('screening.nameTerms'), t('screening.nameTermsHint'))}
        {termList('nameExceptions', t('screening.nameExceptions'), t('screening.nameExceptionsHint'))}
      </FieldGroup>

      <Separator />

      <FieldGroup>
        <div>
          <SectionLabel as="h3">{t('screening.contentTitle')}</SectionLabel>
          <FieldDescription className="mt-1">{t('screening.contentHint')}</FieldDescription>
        </div>
        {termList('contentTerms', t('screening.contentTerms'), t('screening.contentTermsHint'))}
        <div role="group" aria-labelledby="screening-detectors-label" className="flex flex-col gap-2">
          <FieldLabel id="screening-detectors-label">{t('screening.detectors')}</FieldLabel>
          {SCREENING_DETECTORS.map((detector) => (
            <Field key={detector} orientation="horizontal" className="justify-start gap-2">
              <Checkbox
                id={`screening-detector-${detector}`}
                checked={draft.detectors.includes(detector)}
                disabled={readOnly || saving}
                onCheckedChange={(checked) => toggleDetector(detector, checked === true)}
              />
              <FieldLabel htmlFor={`screening-detector-${detector}`} className="font-normal">
                {t(`screening.detector.${detector}`)}
              </FieldLabel>
            </Field>
          ))}
          <FieldDescription>{t('screening.detectorsHint')}</FieldDescription>
        </div>
      </FieldGroup>

      <FieldDescription>{t('screening.limits')}</FieldDescription>

      {canEdit && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setDraft(initial.suggestion)}
            disabled={saving || atSuggestion}
          >
            <RotateCcw className="size-4" aria-hidden />
            {t('screening.useSuggestion')}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} data-testid="upload-screening-save">
            {saving ? tc('states.saving') : tc('actions.save')}
          </Button>
        </div>
      )}
    </FieldGroup>
  )
}
