'use client'

/**
 * The composer's microphone button. Press to record, press again (or wait
 * 45 seconds) to stop; the text arrives through `onTranscript`. When this
 * browser cannot dictate, the button stays visible, disabled, and says why on
 * hover and keyboard focus.
 */

import { Loader2, Mic, Square } from 'lucide-react'
import { AudioWave } from '@/components/ui/audio-wave'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { MAX_DICTATION_SECONDS } from '@/lib/dictation/contract'
import { formatDurationElapsed } from '@/lib/format'
import { useDictation, type DictationErrorKey, type DictationState } from '../hooks/use-dictation'

export interface DictationButtonProps {
  /** The UI language: a wording hint for the transcript, never its language. */
  locale: string
  /** The composer cannot take input right now (no permission, busy). */
  disabled?: boolean
  onTranscript: (text: string) => void
  /** A translated message for the composer's usual inline error. */
  onError: (message: string) => void
}

export function DictationButton({ locale, disabled = false, onTranscript, onError }: DictationButtonProps) {
  const t = useTranslations('chat')
  const { state, toggle } = useDictation({
    locale,
    onTranscript,
    onError: (key: DictationErrorKey) => onError(t(`dictation.errors.${key}`)),
  })
  return <DictationControl state={state} locale={locale} disabled={disabled} onToggle={toggle} />
}

export interface DictationControlProps {
  state: DictationState
  locale: string
  disabled?: boolean
  onToggle: () => void
}

/** The button for one dictation state, with no behaviour of its own (the `/dev/dictation` preview draws each). */
export function DictationControl({ state, locale, disabled = false, onToggle }: DictationControlProps) {
  const t = useTranslations('chat')
  if (state.phase === 'unavailable' || state.phase === 'checking') {
    const reason = state.phase === 'unavailable' ? t(`dictation.unavailable.${state.reason}`) : t('dictation.start')
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button fires no hover events; the span carries the tooltip. */}
          <span className="inline-flex" tabIndex={0} data-testid="dictation-unavailable">
            <Button
              variant="ghost"
              size="icon"
              className="text-subtle size-[34px] rounded-lg"
              disabled
              aria-label={`${t('dictation.start')}: ${reason}`}
            >
              <Mic className="size-4" aria-hidden="true" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64">
          {reason}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (state.phase === 'recording') {
    const elapsed = formatDurationElapsed(state.elapsedSeconds, locale)
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive h-[34px] gap-1.5 rounded-lg px-2.5 tabular-nums"
        onClick={onToggle}
        aria-label={`${t('dictation.stop')} (${t('dictation.recording', { elapsed })})`}
        title={t('dictation.stop')}
        data-testid="dictation-recording"
      >
        <Square className="size-3 fill-current" aria-hidden="true" />
        <AudioWave levels={state.levels} />
        <span aria-hidden="true">{elapsed}</span>
      </Button>
    )
  }

  const busy = state.phase === 'starting' || state.phase === 'transcribing'
  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-subtle size-[34px] rounded-lg"
      onClick={onToggle}
      disabled={disabled || busy}
      aria-label={state.phase === 'transcribing' ? t('dictation.transcribing') : t('dictation.start')}
      aria-busy={busy}
      title={
        state.phase === 'transcribing'
          ? t('dictation.transcribing')
          : t('dictation.startHint', { seconds: MAX_DICTATION_SECONDS })
      }
      data-testid="dictation-button"
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Mic className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
}
