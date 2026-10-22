'use client'

/**
 * What to do with a text the content check found something in (D13), asked
 * before filing because a filed text becomes part of a document Piloti reads.
 *
 * Three outcomes, „Unkenntlich ablegen“ selected: the findings are masked in
 * the E-Mail-Verlauf (the original keeps them, as evidence), the text starts
 * a mail thread of its own, or it goes in whole, which holds the whole
 * mail thread until someone checks it. The kinds found are named; what they
 * matched never is.
 */

import type { JSX } from 'react'
import { useId } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslations } from '@/i18n'
import type { InboundMailContentFinding } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import type { ContentFindingChoice as Choice } from '../lib/draft'

const CHOICES: readonly Choice[] = ['masked', 'own_thread', 'full']

export function ContentFindingChoice({
  findings,
  value,
  onChange,
  disabled = false,
}: {
  findings: readonly InboundMailContentFinding[]
  value: Choice
  onChange: (choice: Choice) => void
  disabled?: boolean
}): JSX.Element {
  const t = useTranslations('inboundMail')
  const id = useId()
  const kinds = [...new Set(findings)].map((kind) => t(`findings.kinds.${kind}`)).join(', ')
  return (
    <Alert data-testid="content-finding-choice">
      <ShieldAlert aria-hidden className="text-warning" />
      <AlertTitle className="line-clamp-none">{t('findings.title', { kinds })}</AlertTitle>
      <AlertDescription>
        <RadioGroup
          value={value}
          onValueChange={(next) => onChange(next as Choice)}
          aria-label={t('findings.choiceLabel')}
          disabled={disabled}
          className="mt-2 gap-2.5"
        >
          {CHOICES.map((choice) => (
            <div key={choice} className="flex items-start gap-2 pointer-coarse:min-h-11">
              <RadioGroupItem id={`${id}-${choice}`} value={choice} className="mt-0.5" data-testid={`finding-${choice}`} />
              <Label htmlFor={`${id}-${choice}`} className="flex flex-col items-start gap-0.5 font-normal">
                <span className="text-foreground text-sm font-medium">{t(`findings.${choice}`)}</span>
                <span className="text-muted-foreground text-xs leading-snug">{t(`findings.${choice}Hint`)}</span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      </AlertDescription>
    </Alert>
  )
}
