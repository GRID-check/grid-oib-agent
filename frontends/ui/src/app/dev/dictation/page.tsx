'use client'

/**
 * Voice dictation dev preview. The first block draws the microphone control in
 * every state it can be in, from `DictationControl` with a fixed state, because
 * the live button's state depends on the browser, the microphone and a backend
 * this page does not have. The second block is the REAL composer, so the
 * button's place in the control row is evidence too; in a browser with a
 * microphone it records, and the transcription call fails with the composer's
 * inline error (no backend here), which is the failure path worth seeing.
 * Not linked anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { DictationControl, type DictationState } from '@/features/dictation'
import { InputArea } from '@/features/layout/components'
import { useLocale } from '@/i18n'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { AppConfigProvider, type AppConfig } from '@/shared/context'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

const STATES: Array<{ label: string; state: DictationState; disabled?: boolean }> = [
  { label: 'idle', state: { phase: 'idle' } },
  {
    label: 'recording, 12 s, speaking',
    state: {
      phase: 'recording',
      elapsedSeconds: 12,
      levels: [0.1, 0.3, 0.6, 0.85, 0.5, 0.7, 0.95, 0.6, 0.35, 0.55, 0.8, 0.45, 0.25, 0.4],
    },
  },
  { label: 'recording, 3 s, silent', state: { phase: 'recording', elapsedSeconds: 3, levels: Array(14).fill(0) } },
  { label: 'transcribing', state: { phase: 'transcribing' } },
  { label: 'composer read-only', state: { phase: 'idle' }, disabled: true },
  { label: 'unavailable: microphone blocked', state: { phase: 'unavailable', reason: 'denied' } },
  { label: 'unavailable: no audio format', state: { phase: 'unavailable', reason: 'noFormat' } },
  { label: 'unavailable: no microphone API', state: { phase: 'unavailable', reason: 'unsupported' } },
  { label: 'unavailable: not https', state: { phase: 'unavailable', reason: 'insecure' } },
]

export default function DictationPreviewPage() {
  const { locale } = useLocale()
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <AppConfigProvider config={config}>
      <main className="min-h-dvh bg-muted/30 px-4 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
          <h1 className="font-mono text-xs text-muted-foreground" data-testid="dictation-preview">
            /dev/dictation — the composer&apos;s microphone button
          </h1>

          <ul className="grid gap-3 sm:grid-cols-2">
            {STATES.map(({ label, state, disabled }) => (
              <li key={label} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                <DictationControl state={state} locale={locale} disabled={disabled} onToggle={() => {}} />
                <span className="font-mono text-xs text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ in the real composer</div>
            <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
          </div>
        </div>
      </main>
    </AppConfigProvider>
  )
}
