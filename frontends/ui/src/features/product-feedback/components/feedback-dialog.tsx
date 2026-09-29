'use client'

/**
 * The feedback form — the one door a member has to the people who run Piloti.
 *
 * Built to be finished in under a minute: pick what it is (four tiles, a bug
 * pre-selected because that is what most people come to report), write a few
 * sentences against a placeholder that asks the right question for that kind,
 * send. Everything a triager needs that the reporter would not know to type —
 * the page, the browser, the screen size — is captured automatically and shown
 * before sending, so nothing leaves the browser unseen.
 *
 * Distinct from the thumbs on an answer (`AnswerFeedback`): that rates one
 * reply, this reaches a person.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { Bug, CheckCircle2, ChevronDown, CircleHelp, Heart, Lightbulb, type LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyStateDisc } from '@/components/ui/empty-state'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useModifierLabel } from '@/components/shell/shortcut-keys'
import { useTranslations } from '@/i18n'
import {
  captureFeedbackContext,
  submitProductFeedback,
  type SubmitProductFeedbackRequest,
  type SubmitProductFeedbackResult,
} from '@/lib/product-feedback/client'
import {
  PRODUCT_FEEDBACK_KINDS,
  PRODUCT_FEEDBACK_MESSAGE_MAX,
  PRODUCT_FEEDBACK_MESSAGE_MIN,
  type ProductFeedbackKind,
} from '@/lib/product-feedback/types'
import { cn } from '@/lib/utils'

export const FEEDBACK_KIND_ICONS: Record<ProductFeedbackKind, LucideIcon> = {
  bug: Bug,
  idea: Lightbulb,
  praise: Heart,
  question: CircleHelp,
}

export interface FeedbackDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The kind pre-selected when the dialog opens. */
  defaultKind?: ProductFeedbackKind
  /** Shown in the contact hint, so the reporter knows where a reply goes. */
  userEmail?: string | null
  /** Injected by previews and specs; the app uses the real client. */
  submit?: (request: SubmitProductFeedbackRequest) => Promise<SubmitProductFeedbackResult>
}

type Phase = { kind: 'form' } | { kind: 'sending' } | { kind: 'sent' }

export function FeedbackDialog({
  open,
  onOpenChange,
  defaultKind = 'bug',
  userEmail = null,
  submit = submitProductFeedback,
}: FeedbackDialogProps): JSX.Element {
  const t = useTranslations('feedback')
  const mod = useModifierLabel()
  const messageId = React.useId()
  const contactId = React.useId()

  const [kind, setKind] = React.useState<ProductFeedbackKind>(defaultKind)
  const [message, setMessage] = React.useState('')
  const [allowContact, setAllowContact] = React.useState(true)
  const [phase, setPhase] = React.useState<Phase>({ kind: 'form' })
  const [error, setError] = React.useState<string | null>(null)
  const [showLengthHint, setShowLengthHint] = React.useState(false)
  const [captured, setCaptured] = React.useState(() => captureFeedbackContext())
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  // A fresh form every time it opens. The context is re-read at the same
  // moment, so it describes the page the reporter opened the form from.
  React.useEffect(() => {
    if (!open) return
    setKind(defaultKind)
    setMessage('')
    setAllowContact(true)
    setPhase({ kind: 'form' })
    setError(null)
    setShowLengthHint(false)
    setCaptured(captureFeedbackContext())
  }, [open, defaultKind])

  const trimmedLength = message.trim().length
  const tooShort = trimmedLength < PRODUCT_FEEDBACK_MESSAGE_MIN
  const sending = phase.kind === 'sending'

  async function send(): Promise<void> {
    if (sending) return
    if (tooShort) {
      setShowLengthHint(true)
      textareaRef.current?.focus()
      return
    }
    setError(null)
    setPhase({ kind: 'sending' })
    const result = await submit({
      kind,
      message: message.trim(),
      allowContact,
      pagePath: captured.pagePath,
      context: captured.context,
    })
    if (result.ok) {
      setPhase({ kind: 'sent' })
      return
    }
    setPhase({ kind: 'form' })
    setError(result.reason === 'rate-limited' ? t('dialog.rateLimited') : t('dialog.error'))
  }

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault()
    void send()
  }

  function handleKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing mid-send would drop the only confirmation the reporter gets.
        if (sending) return
        onOpenChange(next)
      }}
    >
      <DialogContent
        className="sm:max-w-[560px]"
        data-testid="feedback-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          textareaRef.current?.focus()
        }}
      >
        {phase.kind === 'sent' ? (
          <SentPanel
            onAnother={() => {
              setMessage('')
              setShowLengthHint(false)
              setPhase({ kind: 'form' })
            }}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="flex flex-col gap-5">
            <DialogHeader>
              <DialogTitle className="text-base leading-snug">{t('dialog.title')}</DialogTitle>
              <DialogDescription>{t('dialog.description')}</DialogDescription>
            </DialogHeader>

            <fieldset className="flex flex-col gap-2" disabled={sending}>
              <legend className="mb-2 text-sm font-medium">{t('dialog.kindLabel')}</legend>
              <ChoiceCardGroup
                value={kind}
                onValueChange={(value) => setKind(value as ProductFeedbackKind)}
                aria-label={t('dialog.kindLabel')}
              >
                {PRODUCT_FEEDBACK_KINDS.map((option) => (
                  <ChoiceCard
                    key={option}
                    value={option}
                    icon={FEEDBACK_KIND_ICONS[option]}
                    label={t(`kinds.${option}.label`)}
                    hint={t(`kinds.${option}.hint`)}
                    data-testid={`feedback-kind-${option}`}
                  />
                ))}
              </ChoiceCardGroup>
            </fieldset>

            <Field>
              <div className="flex items-baseline justify-between gap-3">
                <FieldLabel htmlFor={messageId}>{t('dialog.messageLabel')}</FieldLabel>
                <span
                  className={cn(
                    'text-muted-foreground text-xs tabular-nums',
                    message.length > PRODUCT_FEEDBACK_MESSAGE_MAX * 0.9 && 'text-warning',
                  )}
                  aria-live="polite"
                >
                  {t('dialog.counter', { count: message.length, max: PRODUCT_FEEDBACK_MESSAGE_MAX })}
                </span>
              </div>
              <Textarea
                id={messageId}
                ref={textareaRef}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onBlur={() => trimmedLength > 0 && setShowLengthHint(true)}
                placeholder={t(`kinds.${kind}.placeholder`)}
                maxLength={PRODUCT_FEEDBACK_MESSAGE_MAX}
                disabled={sending}
                aria-invalid={showLengthHint && tooShort}
                aria-describedby={`${messageId}-hint`}
                className="max-h-[40vh] min-h-32"
                data-testid="feedback-message"
              />
              {showLengthHint && tooShort ? (
                <FieldError id={`${messageId}-hint`}>
                  {t('dialog.tooShort', { min: PRODUCT_FEEDBACK_MESSAGE_MIN })}
                </FieldError>
              ) : (
                <FieldDescription id={`${messageId}-hint`} className="flex items-center gap-1.5">
                  <KbdGroup>
                    <Kbd>{mod}</Kbd>
                    <Kbd>↵</Kbd>
                  </KbdGroup>
                  {t('dialog.shortcut')}
                </FieldDescription>
              )}
            </Field>

            <CapturedContext pagePath={captured.pagePath} context={captured.context} />

            <div className="flex items-start gap-2.5">
              <Checkbox
                id={contactId}
                checked={allowContact}
                onCheckedChange={(checked) => setAllowContact(checked === true)}
                disabled={sending}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={contactId} className="text-sm font-normal">
                  {t('dialog.allowContact')}
                </Label>
                {userEmail && allowContact && (
                  <span className="text-muted-foreground text-xs">
                    {t('dialog.allowContactHint', { email: userEmail })}
                  </span>
                )}
              </div>
            </div>

            {error && (
              <p role="alert" className="text-destructive text-sm font-medium">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
                {t('dialog.cancel')}
              </Button>
              <Button type="submit" disabled={sending} data-testid="feedback-send">
                {sending && <Spinner className="size-4" />}
                {sending ? t('dialog.sending') : t('dialog.send')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * What is sent along without being typed, shown before it is sent. Collapsed:
 * it is disclosure, not a question, and most reporters never need to open it.
 */
function CapturedContext({
  pagePath,
  context,
}: ReturnType<typeof captureFeedbackContext>): JSX.Element {
  const t = useTranslations('feedback')
  const rows: Array<[string, string | undefined | null]> = [
    [t('dialog.context.page'), pagePath],
    [t('dialog.context.browser'), context.userAgent],
    [t('dialog.context.screen'), context.viewport],
  ]
  return (
    <Collapsible className="bg-muted/40 rounded-lg border">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs font-medium">
        {t('dialog.context.summary')}
        <ChevronDown
          aria-hidden
          className="size-3.5 transition-transform duration-quick group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pb-3 text-xs">
          {rows.map(([label, value]) => (
            <React.Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-foreground min-w-0 break-words">{value || t('dialog.context.none')}</dd>
            </React.Fragment>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SentPanel({ onAnother, onClose }: { onAnother: () => void; onClose: () => void }): JSX.Element {
  const t = useTranslations('feedback')
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center" data-testid="feedback-sent">
      <EmptyStateDisc icon={CheckCircle2} className="bg-success-subtle text-success border-transparent" />
      <div className="flex flex-col gap-1.5">
        <DialogTitle className="text-base">{t('dialog.success.title')}</DialogTitle>
        <DialogDescription className="max-w-sm text-pretty">{t('dialog.success.body')}</DialogDescription>
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onAnother}>
          {t('dialog.success.another')}
        </Button>
        <Button type="button" onClick={onClose} autoFocus>
          {t('dialog.success.close')}
        </Button>
      </div>
    </div>
  )
}
