'use client'

/**
 * Composer dev preview: renders the REAL InputArea (chat composer) backend-free —
 * `connectionMode="sse"` disables the WebSocket auto-connect, and a fixture
 * AppConfig satisfies `useAppConfig`. It renders the empty-thread state (source
 * preset chips under the field) at desktop + mobile widths so the composer — the
 * counterpart to the answer card — can be reviewed and screenshotted
 * (visual/registry.mjs → `composer`) in light + dark. Not linked anywhere and
 * 404s outside development.
 */

import { notFound } from 'next/navigation'
import { AppConfigProvider, type AppConfig } from '@/shared/context'
import { getFileUploadConfigFromEnv } from '@/shared/config/file-upload'
import { InputArea } from '@/features/layout/components'

const config: AppConfig = {
  authRequired: false,
  fileUpload: getFileUploadConfigFromEnv(),
}

export default function ComposerPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <AppConfigProvider config={config}>
      <main className="min-h-dvh bg-muted/30 px-4 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
          <h1 className="font-mono text-xs text-muted-foreground" data-testid="composer-preview">
            /dev/composer — chat composer (empty-thread state, desktop + mobile)
          </h1>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ desktop</div>
            <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
          </div>

          <div>
            <div className="mb-2 font-mono text-xs text-muted-foreground">↓ mobile width (390px)</div>
            <div className="w-[390px] max-w-full">
              <InputArea isAuthenticated connectionMode="sse" projectName="Stadthaus Wien 1090" />
            </div>
          </div>
        </div>
      </main>
    </AppConfigProvider>
  )
}
