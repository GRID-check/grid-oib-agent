// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link'
import { ClipboardList, Database, FileText, HardDrive, MessageSquare, PencilLine, Upload } from 'lucide-react'
import type { ProjectOverviewData } from '../types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { formatFileSize } from '@/lib/utils/format-file-size'

interface ProjectOverviewProps {
  data: ProjectOverviewData
}

type BadgeVariant = 'success' | 'info' | 'destructive' | 'secondary'

/** One consistent status vocabulary for document badges (design-language token map). */
function statusVariant(status: string | null): BadgeVariant {
  switch (status) {
    case 'uploaded':
    case 'ready':
    case 'ingested':
    case 'success':
      return 'success'
    case 'pending':
    case 'ingesting':
    case 'processing':
    case 'uploading':
      return 'info'
    case 'failed':
      return 'destructive'
    default:
      return 'secondary'
  }
}

function statusLabel(status: string | null): string {
  if (!status) return 'Unknown'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function ProjectOverview({ data }: ProjectOverviewProps) {
  const profile = data.profileDisplay
  const keyFacts = profile?.keyFacts ?? []
  const missingInfo = profile?.missingInfo ?? []
  const summary = profile?.summary?.trim()
  const hasDocuments = data.documentCount > 0

  let createdLabel = ''
  try {
    createdLabel = dateFormatter.format(new Date(data.createdAt))
  } catch {
    createdLabel = ''
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {createdLabel ? `Project workspace · created ${createdLabel}` : 'Project workspace'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={`/projects/${data.id}/chat`}>
              <MessageSquare className="size-4" aria-hidden />
              Ask Grid
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/projects/${data.id}/files`}>
              <Upload className="size-4" aria-hidden />
              Upload files
            </Link>
          </Button>
        </div>
      </header>

      {/* Project Brief — the architect-owned context Grid works from. Never blank. */}
      {profile ? (
        <section className="rounded-lg border bg-card p-6">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Project Brief
            </h2>
            <Link
              href={`/projects/${data.id}/intake`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <PencilLine className="size-3.5" aria-hidden />
              Edit brief
            </Link>
          </div>

          {summary && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{summary}</p>}

          {keyFacts.length > 0 ? (
            <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
              {keyFacts.map((fact, i) => (
                <div key={i}>
                  <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                  <dd className="mt-0.5 text-sm font-medium">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            !summary && (
              <p className="mt-3 text-sm text-muted-foreground">
                The brief has been started but no details are captured yet.{' '}
                <Link
                  href={`/projects/${data.id}/intake`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Complete the brief
                </Link>{' '}
                so Grid can ground its answers.
              </p>
            )
          )}

          {missingInfo.length > 0 && (
            <div className="mt-5 border-t pt-4">
              <p className="text-xs text-muted-foreground">
                Grid still doesn&apos;t know: {missingInfo.join(' · ')}
                {' — '}
                <Link
                  href={`/projects/${data.id}/intake`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  complete the brief
                </Link>
              </p>
            </div>
          )}
        </section>
      ) : (
        <EmptyState
          icon={ClipboardList}
          title="Set up the project brief"
          description="Tell Grid about this building — use, class, storeys and goals. A complete brief lets Grid ground every answer in your project's real context."
          action={
            <Button asChild>
              <Link href={`/projects/${data.id}/intake`}>Set up project context</Link>
            </Button>
          }
        />
      )}

      {/* Stats */}
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FileText className="size-4" aria-hidden />
            <span className="text-sm">Files</span>
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{data.documentCount}</p>
        </div>
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-muted-foreground">
            <HardDrive className="size-4" aria-hidden />
            <span className="text-sm">Total size</span>
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">
            {formatFileSize(data.totalFileSize)}
          </p>
        </div>
        <div className="col-span-2 rounded-lg border bg-card p-5 sm:col-span-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Database className="size-4" aria-hidden />
            <span className="text-sm">Knowledge base</span>
          </div>
          <p className="mt-2 truncate font-mono text-sm text-foreground" title={data.collectionName}>
            {data.collectionName}
          </p>
        </div>
      </section>

      {/* Recent Files */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Recent Files
          </h2>
          {hasDocuments && (
            <Link
              href={`/projects/${data.id}/files`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              View all
            </Link>
          )}
        </div>

        {hasDocuments ? (
          <div className="divide-y rounded-lg border bg-card">
            {data.recentDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate text-sm">{doc.filename}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatFileSize(doc.fileSize)}
                  </span>
                </div>
                <Badge variant={statusVariant(doc.status)}>{statusLabel(doc.status)}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={FileText}
            title="No files yet"
            description="Upload building documents — plans, reports, the Bauordnung excerpts — so Grid can cite your project when it answers."
            action={
              <Button asChild>
                <Link href={`/projects/${data.id}/files`}>Upload files</Link>
              </Button>
            }
          />
        )}
      </section>
    </div>
  )
}
