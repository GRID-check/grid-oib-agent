'use client'

/**
 * Live "What the agent receives" pane. Renders the client-side
 * `compilePreview` output verbatim — the WYSIWYG contract is that this text
 * equals the prompt the agent is submitted (the server compiles the same
 * output authoritatively at save time). Shown verbatim in a monospace block
 * so the preview is honest rather than re-styled.
 */

import { FileText } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslations } from '@/i18n'
import type { WorkflowDefinition } from '@/adapters/api/workflows-client'
import { compilePreview } from '../lib/compile-preview'

interface BriefPreviewProps {
  definition: WorkflowDefinition
}

export function BriefPreview({ definition }: BriefPreviewProps): JSX.Element {
  const t = useTranslations('workflows')
  const compiled = compilePreview(definition)

  return (
    <Card className="lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          {t('builder.preview.title')}
        </CardTitle>
        <CardDescription>{t('builder.preview.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {compiled ? (
          <pre
            data-testid="brief-preview"
            className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground"
          >
            {compiled}
          </pre>
        ) : (
          <p className="rounded-lg border border-dashed bg-muted/20 p-6 text-center text-sm text-muted-foreground">
            {t('builder.preview.empty')}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
