/**
 * What the composer says when a message contains something the office's
 * „Sensible Daten" policy covers (ADR-0079, "Chat messages are screened too").
 *
 * It names what was found — the term the office wrote, or the kind of number
 * with a masked sample, never the value — and offers two ways on: send the
 * message with each match replaced by its placeholder, or go back and edit it.
 * There is deliberately no third button that sends it as typed: the policy's
 * promise is that the model never sees it.
 *
 * A molecule over the `Alert` and `Button` atoms; the composer owns the state.
 */

import type { FC } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import type { ContentFinding } from '@/lib/upload-screening/content-screen'

export interface ChatScreeningNoticeProps {
  findings: readonly ContentFinding[]
  /** The message as it would be sent masked. */
  maskedText: string
  onSendMasked: () => void
  onEdit: () => void
}

export const ChatScreeningNotice: FC<ChatScreeningNoticeProps> = ({
  findings,
  maskedText,
  onSendMasked,
  onEdit,
}) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()

  const items = findings.map((finding) => {
    const item =
      finding.kind === 'term'
        ? t('screening.term', { term: finding.term ?? '' })
        : t(`screening.${finding.kind}`, { count: finding.count })
    return finding.sample && finding.count === 1
      ? t('screening.withSample', { item, sample: finding.sample })
      : item
  })
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items)

  return (
    <Alert variant="warning" className="mt-2" data-testid="chat-screening-notice">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{t('screening.title', { items: list })}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{t('screening.body')}</span>
        <span className="text-muted-foreground line-clamp-3 text-xs">
          {t('screening.preview', { text: maskedText })}
        </span>
        <span className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={onSendMasked}>
            {t('screening.sendMasked')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onEdit}>
            {t('screening.edit')}
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}
