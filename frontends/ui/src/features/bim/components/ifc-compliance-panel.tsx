'use client'

/**
 * The Prüfbuch — OIB requirements with a verdict, on the model page.
 *
 * The rest of the model page answers "what is in this file". This answers
 * "where does it stand", which is the only question that ends up on a
 * Bestätigung.
 *
 * Three design commitments, each of which the UI has to make visible rather
 * than merely honour in the data:
 *
 * 1. **`Nicht entscheidbar` is shown as prominently as a failure**, because it
 *    is not a gap in the report — it is the reason the report cannot be
 *    trusted yet, and it is the architect's to-do list.
 * 2. **Every verdict shows the threshold it applied**, so the architect checks
 *    the rule and not only the result.
 * 3. **A rule that stood down says why**, on the row. "Gebäudeklasse nicht
 *    gesetzt" is a fixable state, and hiding the row would make an
 *    under-configured project look like a clean one.
 */

import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HelpCircle,
  MinusCircle,
  ShieldCheck,
  UserCheck,
  Wrench,
} from 'lucide-react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useLocale, useTranslations } from '@/i18n'
import { rulesWithOpenWork } from '@/lib/bim/rules'
import type { BimComplianceSummary, BimRuleResultWithConfirmation } from '@/lib/bim/rules'
import { buildModelHref } from '../lib/model-link'
import type { BimRuleFactKey } from '../hooks/use-bim-model'

export interface IfcCompliancePanelProps {
  rules: BimRuleResultWithConfirmation[] | null
  summary: BimComplianceSummary | null
  shoppingList: Array<{ path: string; elements: number; rules: string[] }> | null
  isLoading: boolean
  error: string | null
  /**
   * The catalogue ran over a CAPPED element list, so every count on this
   * screen is a count over part of the building.
   */
  truncated?: boolean
  projectId: string
  modelFilename: string
  /** Re-runs the catalogue after a failure. */
  onRetry?: () => void
  /**
   * Show these elements in the model.
   *
   * A PATCH of the view, not a fresh one. These used to be `<Link>`s built by
   * `buildModelHref` from scratch: clicking a failing door threw away the
   * storey filter, the camera and the section cut the reader had set up, and —
   * because a `<Link>` pushes while the stage navigates with `replace`
   * everywhere else — made the back button do something different from what
   * it had done a click earlier. The health panel beside it has always
   * patched; this is the same callback.
   */
  onShowElements?: (globalIds: string[], status: 'fail' | 'info') => void
  /** Set when the project brief is missing a fact some rules need. */
  /** Keys, not names — the panel owns the words. See `BimRuleFactKey`. */
  missingFacts: BimRuleFactKey[]
  /**
   * The brief could not be READ, which is not the same as it lacking a value.
   *
   * With this set the panel must not tell the reader to go and fill in facts
   * that are, as far as anyone knows, already there.
   */
  factsFailed?: boolean
  /**
   * The confirmation ledger could not be read.
   *
   * Distinct from "nothing is confirmed": a rule somebody signed off renders
   * with no signature and offers to confirm it again, on the surface whose job
   * is to be the record.
   */
  confirmationsFailed?: boolean
  onRetryFacts?: () => void
  /** Opens the chat so the user can supply what the brief lacks. */
  askHref: string
  /**
   * Record a human verdict on a rule the catalogue could not settle.
   *
   * Absent for a viewer without `project:edit` — the confirmations are still
   * SHOWN, because they are part of the record everyone needs to read; only
   * the ability to add one is withheld.
   */
  onConfirm?: (ruleId: string, note: string) => Promise<void>
  onWithdraw?: (ruleId: string) => Promise<void>
  /**
   * Download URL for the BCF archive of the open items, or `null` while the
   * catalogue has not run.
   *
   * A plain link rather than a fetch-and-blob: the browser's own download path
   * shows progress, survives a slow export, and gives the architect a URL they
   * can send to the person who actually owns the model.
   */
  bcfHref: string | null
}

/** Rows before a rule's list folds — the counts always speak for the rest. */
const VISIBLE_ROWS = 6

function verdictHref(
  projectId: string,
  modelFilename: string,
  globalIds: string[],
  status: 'fail' | 'info'
): string {
  return buildModelHref(projectId, {
    model: modelFilename,
    element: globalIds[0],
    highlights: [{ status, globalIds }],
    xray: true,
    // Without this the link carries no tab, the drawer falls back to
    // Überblick, and the finding the reader clicked — with its scroll
    // position and its half-filled confirmation form — is gone. There is no
    // back button either: the stage navigates with `replace`.
    tab: 'compliance',
  })
}

export function IfcCompliancePanel({
  rules,
  summary,
  shoppingList,
  isLoading,
  error,
  truncated = false,
  onRetry,
  onShowElements,
  projectId,
  modelFilename,
  missingFacts,
  factsFailed = false,
  confirmationsFailed = false,
  onRetryFacts,
  askHref,
  onConfirm,
  onWithdraw,
  bcfHref,
}: IfcCompliancePanelProps): JSX.Element {
  const t = useTranslations('bim')
  const openWork = rules === null ? 0 : rulesWithOpenWork(rules).length

  return (
    <section aria-labelledby="bim-compliance-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="bim-compliance-heading" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          {t('compliance.title')}
        </h2>
        {bcfHref && openWork > 0 && (
          <Button asChild variant="outline" size="sm">
            {/* `download` without a value: the filename comes from the
                response's Content-Disposition, which is the only place that
                knows which revision was exported. */}
            <a href={bcfHref} download>
              <Download className="size-3.5" aria-hidden="true" />
              {openWork === 1
                ? t('compliance.export.actionOne')
                : t('compliance.export.action', { count: openWork })}
            </a>
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('compliance.description')}</p>
      {bcfHref && openWork > 0 && (
        <p className="text-xs text-muted-foreground">{t('compliance.export.hint')}</p>
      )}

      {isLoading && <Spinner className="size-4" />}
      {error && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-destructive text-sm">{t('compliance.failed')}</p>
          {/* The rule the stage states and this panel used to break: "Every
              error state in this viewer used to be terminal." */}
          {onRetry && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={onRetry}
            >
              {t('loadFailed.action')}
            </Button>
          )}
        </div>
      )}

      {/* Above the badges on purpose: it invalidates every number in them. */}
      {truncated && (
        <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('compliance.truncatedModel')}</span>
        </p>
      )}

      {summary && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="success">
            {t('compliance.badge.passing')} {summary.rulesPassing}
          </Badge>
          <Badge variant="destructive">
            {t('compliance.badge.failing')} {summary.rulesFailing}
          </Badge>
          {/* Same visual weight as a failure on purpose: an undecidable
              requirement is not a smaller problem, it is an unknown one. */}
          <Badge variant="warning">
            {t('compliance.badge.undecidable')} {summary.rulesUndecidable}
          </Badge>
          <Badge variant="secondary">
            {t('compliance.badge.notApplicable')} {summary.rulesNotApplicable}
          </Badge>
          {/*
            The fifth bucket. `summarizeBimRules` produces it and nothing
            rendered it, so on a model with no doors and no stairs a
            seven-rule catalogue showed badges summing to five — and the rows
            that explain why are below the fold.
          */}
          {summary.rulesEmpty > 0 && (
            <Badge variant="secondary">
              {t('compliance.badge.noElements')} {summary.rulesEmpty}
            </Badge>
          )}
        </div>
      )}

      {/*
        A brief that could not be READ, said as itself. The rules stand down
        either way, but "diese Angaben fehlen im Briefing" sends the reader to
        re-enter values that are already there, and coming back changes
        nothing.
      */}
      {/*
        The ledger, separately from the brief. A rule that HAS been signed off
        renders here with no signature and an invitation to confirm it again —
        so the reader has to be told the record is the thing that is missing,
        not the answer.
      */}
      {confirmationsFailed && (
        <p className="bg-warning-subtle text-warning flex flex-wrap items-center gap-2 rounded-md p-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('compliance.confirmed.readFailed')}</span>
        </p>
      )}
      {factsFailed && (
        <p className="bg-warning-subtle text-warning flex flex-wrap items-center gap-2 rounded-md p-2 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{t('compliance.factsFailed')}</span>
          {onRetryFacts && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={onRetryFacts}
            >
              {t('loadFailed.action')}
            </Button>
          )}
        </p>
      )}

      {missingFacts.length > 0 && (
        <p className="flex items-start gap-2 rounded-md bg-warning-subtle p-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t('compliance.missingFacts', {
              facts: missingFacts.map((key) => t(`compliance.factName.${key}`)).join(', '),
            })}{' '}
            <Link href={askHref} className="underline underline-offset-2">
              {t('compliance.setFacts')}
            </Link>
          </span>
        </p>
      )}

      {shoppingList && shoppingList.length > 0 && (
        <div className="rounded-lg border p-3">
          <h3 className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Wrench className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t('compliance.shoppingList.title')}
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            {t('compliance.shoppingList.description')}
          </p>
          <ul className="space-y-1 text-sm">
            {shoppingList.slice(0, 8).map((entry) => (
              <li key={entry.path} className="flex flex-wrap items-baseline gap-x-2">
                <code className="rounded bg-muted px-1 py-0.5 text-xs">{entry.path}</code>
                <span className="text-muted-foreground">
                  {/* One sibling key per counted string — the translator
                      substitutes tokens and does not select plurals, and a
                      property missing from exactly one element is common. */}
                  {entry.elements === 1
                    ? t('compliance.shoppingList.countOne')
                    : t('compliance.shoppingList.count', { count: entry.elements })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rules && (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <RuleRow
              key={rule.ruleId}
              rule={rule}
              projectId={projectId}
              modelFilename={modelFilename}
              onConfirm={onConfirm}
              onWithdraw={onWithdraw}
              onShowElements={onShowElements}
            />
          ))}
        </ul>
      )}

      {rules && (
        <p className="text-xs text-muted-foreground">{t('compliance.disclaimer')}</p>
      )}
    </section>
  )
}

function RuleRow({
  rule,
  projectId,
  modelFilename,
  onConfirm,
  onWithdraw,
  onShowElements,
}: {
  rule: BimRuleResultWithConfirmation
  projectId: string
  modelFilename: string
  onConfirm?: (ruleId: string, note: string) => Promise<void>
  onWithdraw?: (ruleId: string) => Promise<void>
  /** Patches the view rather than replacing it — see the panel's prop doc. */
  onShowElements?: (globalIds: string[], status: 'fail' | 'info') => void
}): JSX.Element {
  const t = useTranslations('bim')
  const checked = rule.passed + rule.failed + rule.undecidable

  const { Icon, tone } = !rule.applicable
    ? { Icon: MinusCircle, tone: 'text-muted-foreground' }
    : rule.failed > 0
      ? { Icon: AlertTriangle, tone: 'text-destructive' }
      : checked === 0
        ? { Icon: MinusCircle, tone: 'text-muted-foreground' }
        : // ANY undecidable element leaves the requirement unsettled, not met.
          // This used to read `rule.passed === 0`, so "9 erfüllt, 2 nicht
          // entscheidbar" scored a green tick — the precise reading the
          // three-state design exists to prevent, and the one the badge row
          // above already refuses to give: `summarizeBimRules` counts that
          // rule under `rulesUndecidable`, and `standing()` returns `unknown`
          // for it. Only this icon disagreed, and the icon is what a reader
          // scans.
          rule.undecidable > 0
          ? { Icon: HelpCircle, tone: 'text-warning' }
          : { Icon: CheckCircle2, tone: 'text-success' }

  return (
    <li className="rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {rule.titleDe}{' '}
            <span className="font-normal text-muted-foreground">
              ({rule.richtlinie}, Punkt {rule.clause})
            </span>
          </p>
          {/* The threshold, always — the architect checks the rule, not only
              the verdict. */}
          <p className="text-xs text-muted-foreground">{rule.thresholdDe}</p>

          {!rule.applicable ? (
            // A rule that stood down says why. Hiding it would make an
            // under-configured project look like a clean one.
            <p className="text-xs text-muted-foreground">
              {t('compliance.notApplicable')}: {rule.notApplicableReason}
            </p>
          ) : checked === 0 ? (
            <p className="text-xs text-muted-foreground">{t('compliance.noElements')}</p>
          ) : (
            <>
              <p className="text-xs tabular-nums text-muted-foreground">
                {t('compliance.counts', {
                  passed: rule.passed,
                  failed: rule.failed,
                  undecidable: rule.undecidable,
                })}
              </p>
              <VerdictList
                heading={t('compliance.failures')}
                verdicts={rule.failures}
                total={rule.failed}
                projectId={projectId}
                modelFilename={modelFilename}
                status="fail"
                tone="text-destructive"
                onShowElements={onShowElements}
              />
              <VerdictList
                heading={t('compliance.unknowns')}
                verdicts={rule.unknowns}
                total={rule.undecidable}
                projectId={projectId}
                modelFilename={modelFilename}
                status="info"
                tone="text-warning"
                onShowElements={onShowElements}
              />
              {rule.truncated && (
                <p className="text-xs text-muted-foreground">{t('compliance.truncated')}</p>
              )}
            </>
          )}

          <Confirmation rule={rule} onConfirm={onConfirm} onWithdraw={onWithdraw} />
        </div>
      </div>
    </li>
  )
}

/**
 * The human verdict on a rule, and the way to record one.
 *
 * Rendered BESIDE the machine counts, never instead of them: an architect who
 * confirms a failing rule has said "I know, and it is fine", and turning the
 * row green would hide what the model actually says from the next reader.
 *
 * A confirmation made against an older revision stays visible and is marked
 * stale rather than being deleted or silently honoured — "I checked this" was
 * true of the building that person looked at.
 */
function Confirmation({
  rule,
  onConfirm,
  onWithdraw,
}: {
  rule: BimRuleResultWithConfirmation
  onConfirm?: (ruleId: string, note: string) => Promise<void>
  onWithdraw?: (ruleId: string) => Promise<void>
}): JSX.Element | null {
  const t = useTranslations('bim')
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // A signature that did not save must SAY so. Without this the request failed
  // silently, the form stayed open with no explanation, and the architect had
  // every reason to believe the rule was confirmed — a record of a decision
  // that was never recorded, on the one surface that exists to be a record.
  const [failed, setFailed] = useState(false)

  /**
   * Where focus goes when a control removes itself.
   *
   * Pressing "Bestätigen" unmounts the button that was pressed and mounts a
   * note field in its place; saving or cancelling does the reverse. Neither
   * moved focus, so each press threw the reader's place to the top of the
   * enclosing dialog and left them Tabbing back through the whole Prüfbuch to
   * reach a field they had just asked for — a signature workflow that a
   * keyboard cannot complete without counting Tab stops.
   */
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)
  /** Only after an interaction: focusing on mount would steal it from the page. */
  const interacted = useRef(false)

  useEffect(() => {
    if (!interacted.current) return
    if (open) noteRef.current?.focus()
    else openerRef.current?.focus()
  }, [open])

  /**
   * Whether the last write was refused for lack of permission.
   *
   * A project VIEWER can open the Prüfbuch — the confirmations are part of the
   * record everyone reads — and the panel's own prop doc says the write
   * callbacks are "absent for a viewer without `project:edit`". Nothing ever
   * omits them, so a viewer could fill in a note, save it, get a 403 and be
   * told "bitte erneut versuchen": a retry that can never succeed, with the
   * note retyped each time.
   */
  const [denied, setDenied] = useState(false)
  /** Withdrawing is destructive and irreversible, so it asks first. */
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false)

  // Nothing to confirm on a rule that stood down or that the model settled
  // cleanly — offering a signature there would invite one nobody needs.
  const needsHuman = rule.applicable && (rule.failed > 0 || rule.undecidable > 0)
  if (!needsHuman && !rule.confirmation) return null

  const submit = async (): Promise<void> => {
    if (!onConfirm) return
    setBusy(true)
    setFailed(false)
    try {
      await onConfirm(rule.ruleId, note.trim())
      // Sends focus back to the button that opened the form — which by then
      // reads "Erneut bestätigen", so the reader lands on a control that
      // confirms the save happened.
      interacted.current = true
      setOpen(false)
      setNote('')
    } catch (error) {
      if (error instanceof Error && error.message === '403') setDenied(true)
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (): Promise<void> => {
    if (!onWithdraw) return
    setBusy(true)
    setFailed(false)
    try {
      await onWithdraw(rule.ruleId)
      // Back to the opener, which by then reads "Manuell bestätigen": a
      // control that confirms the withdrawal happened, rather than a focus
      // ring thrown to the top of the dialog.
      interacted.current = true
      setConfirmingWithdraw(false)
    } catch (error) {
      if (error instanceof Error && error.message === '403') setDenied(true)
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-1 border-t pt-2">
      {rule.confirmation && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-success">
            <UserCheck className="size-3.5" aria-hidden="true" />
            {t('compliance.confirmed.by', {
              who: rule.confirmation.confirmedBy,
              when: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                new Date(rule.confirmation.confirmedAt)
              ),
            })}
          </span>
          {rule.confirmationStale && (
            <Badge variant="warning">{t('compliance.confirmed.stale')}</Badge>
          )}
          {rule.confirmation.note && (
            <span className="text-muted-foreground">„{rule.confirmation.note}“</span>
          )}
        </p>
      )}

      {rule.confirmationStale && (
        <p className="text-xs text-muted-foreground">{t('compliance.confirmed.staleHint')}</p>
      )}

      {onConfirm && !open && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="bim-confirm-open"
            ref={openerRef}
            onClick={() => {
              interacted.current = true
              setOpen(true)
            }}
          >
            {rule.confirmation
              ? t('compliance.confirmed.reconfirm')
              : t('compliance.confirmed.confirm')}
          </Button>
          {rule.confirmation &&
            onWithdraw &&
            (confirmingWithdraw ? (
              /*
                One click used to delete a signed record — permanently, across
                every revision of the building, with no confirmation, no undo
                and no feedback beyond the button vanishing. Everything else in
                this component asks first: the note form is itself a two-step
                disclosure. This is the same shape, so no new pattern and no
                dialog.
              */
              <>
                <span className="text-muted-foreground text-xs">
                  {t('compliance.confirmed.withdrawConfirm')}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => void withdraw()}
                  disabled={busy}
                >
                  {busy ? <Spinner className="size-3" /> : null}
                  {t('compliance.confirmed.withdraw')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingWithdraw(false)}
                  disabled={busy}
                >
                  {t('compliance.confirmed.cancel')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmingWithdraw(true)}
                disabled={busy}
              >
                {t('compliance.confirmed.withdraw')}
              </Button>
            ))}
        </div>
      )}

      {onConfirm && open && (
        <div className="space-y-2">
          <Textarea
            ref={noteRef}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder={t('compliance.confirmed.notePlaceholder')}
            aria-label={t('compliance.confirmed.noteLabel')}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="bim-confirm-save"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? <Spinner className="size-3" /> : null}
              {t('compliance.confirmed.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                interacted.current = true
                setOpen(false)
              }}
            >
              {t('compliance.confirmed.cancel')}
            </Button>
          </div>
        </div>
      )}

      {failed && (
        <p role="alert" data-testid="bim-confirmation-failed" className="text-xs text-destructive">
          {t('compliance.confirmed.failed')}
        </p>
      )}
      {/* A refusal, not a failure: no retry, because there is nothing to
          retry. Stated once and the form stays open with the note in it, so
          nothing the reader typed is lost. */}
      {denied && (
        <p role="alert" className="text-warning text-xs">
          {t('compliance.confirmed.denied')}
        </p>
      )}
    </div>
  )
}

function VerdictList({
  heading,
  verdicts,
  total,
  projectId,
  modelFilename,
  status,
  tone,
  onShowElements,
}: {
  heading: string
  verdicts: BimRuleResultWithConfirmation['failures']
  /**
   * How many elements are in this bucket, which is NOT `verdicts.length`.
   *
   * The rule engine carries at most `VISIBLE_VERDICTS` (25) individual
   * verdicts per bucket, so a rule with 300 failures arrives here with 25 of
   * them. Counting the remainder off the array said "19 weitere" when 294
   * were missing — a number produced entirely by two caps and true of
   * neither the model nor the finding.
   */
  total: number
  projectId: string
  modelFilename: string
  status: 'fail' | 'info'
  tone: string
  onShowElements?: (globalIds: string[], status: 'fail' | 'info') => void
}): JSX.Element | null {
  const t = useTranslations('bim')
  if (verdicts.length === 0) return null
  const shown = verdicts.slice(0, VISIBLE_ROWS)

  /**
   * A button when the stage can patch the view, a link otherwise.
   *
   * Patching keeps the storey, the camera and the cut the reader set up, and
   * navigates with `replace` like the rest of the stage. The link stays for
   * the surfaces that render this panel without a viewport to talk to — the
   * dev page, and any future read-only embed — where a fresh view is the only
   * thing a click can mean.
   */
  const show = (globalIds: string[], children: React.ReactNode, className: string) =>
    onShowElements ? (
      <button
        type="button"
        onClick={() => onShowElements(globalIds, status)}
        className={className}
      >
        {children}
      </button>
    ) : (
      <Link href={verdictHref(projectId, modelFilename, globalIds, status)} className={className}>
        {children}
      </Link>
    )

  return (
    <div className="mt-1 space-y-0.5">
      <p className={`text-xs font-medium ${tone}`}>
        {heading}{' '}
        {show(
          verdicts.map((verdict) => verdict.globalId),
          t('compliance.showInModel'),
          'font-normal underline underline-offset-2'
        )}
      </p>
      <ul className="space-y-0.5">
        {shown.map((verdict) => (
          <li key={verdict.globalId} className="text-xs text-muted-foreground">
            {show(
              [verdict.globalId],
              verdict.name ?? verdict.globalId,
              'underline underline-offset-2'
            )}
            {verdict.storeyName ? ` · ${verdict.storeyName}` : ''} — {verdict.reading}
          </li>
        ))}
      </ul>
      {total > shown.length && (
        <p className="text-xs text-muted-foreground">
          {total - shown.length === 1
            ? t('compliance.moreOne')
            : t('compliance.more', { count: total - shown.length })}
        </p>
      )}
    </div>
  )
}
