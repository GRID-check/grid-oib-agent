// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link'
import type { ProjectOverviewData } from '../types'
import { formatFileSize } from '@/lib/utils/format-file-size'

interface ProjectOverviewProps {
  data: ProjectOverviewData
}

export function ProjectOverview({ data }: ProjectOverviewProps) {
  const hasProfile =
    data.profileDisplay && (data.profileDisplay.title || data.profileDisplay.summary)
  const hasDocuments = data.documentCount > 0

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8">
      {/* Project Identity */}
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-primary">{data.name}</h1>
        {data.profileDisplay?.summary && (
          <p className="mt-2 text-lg text-subtle">{data.profileDisplay.summary}</p>
        )}
      </div>

      {/* Context Summary Card */}
      {hasProfile && data.profileDisplay?.keyFacts && data.profileDisplay.keyFacts.length > 0 && (
        <div className="rounded-xl border border-base bg-surface-base p-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-subtle">
            Project Context
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-4 gap-x-8 gap-y-3 sm:grid-cols-3">
            {data.profileDisplay.keyFacts.map((fact, i) => (
              <div key={i}>
                <dt className="text-xs text-subtle">{fact.label}</dt>
                <dd className="mt-0.5 text-sm font-medium text-primary">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Setup Prompt */}
      {!hasProfile && (
        <div className="rounded-xl border border-base bg-surface-sunken p-6">
          <p className="text-sm text-subtle">
            Tell Grid about this project to get personalized assistance. Project context helps the
            AI understand your goals, requirements, and constraints.
          </p>
          <Link
            href={`/projects/${data.id}/intake`}
            className="mt-3 inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Set up project context
          </Link>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex gap-3">
        <Link
          href={`/projects/${data.id}/chat`}
          className="inline-flex items-center rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Ask Grid
        </Link>
        <Link
          href={`/projects/${data.id}/files`}
          className="inline-flex items-center rounded-lg border border-base bg-surface-base px-5 py-2.5 text-sm font-medium text-secondary hover:bg-surface-sunken"
        >
          Upload Files
        </Link>
        {data.profileDisplay?.missingInfo && data.profileDisplay.missingInfo.length > 0 && (
          <Link
            href={`/projects/${data.id}/intake`}
            className="inline-flex items-center rounded-lg border border-warning bg-warning-subtle px-4 py-2.5 text-sm font-medium text-warning hover:bg-warning-subtle-hover"
          >
            Complete context
          </Link>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-base bg-surface-base p-5">
          <p className="text-2xl font-semibold text-primary">{data.documentCount}</p>
          <p className="mt-1 text-sm text-subtle">Files</p>
        </div>
        <div className="rounded-xl border border-base bg-surface-base p-5">
          <p className="text-2xl font-semibold text-primary">{formatFileSize(data.totalFileSize)}</p>
          <p className="mt-1 text-sm text-subtle">Total size</p>
        </div>
        <div className="rounded-xl border border-base bg-surface-base p-5">
          <p className="text-2xl font-semibold text-primary">{data.collectionName}</p>
          <p className="mt-1 text-sm text-subtle">Knowledge base</p>
        </div>
      </div>

      {/* Recent Documents */}
      {hasDocuments && (
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-subtle">
              Recent Files
            </h2>
            <Link
              href={`/projects/${data.id}/files`}
              className="text-sm text-subtle hover:text-secondary"
            >
              View all
            </Link>
          </div>
          <div className="mt-3 divide-y divide-base rounded-xl border border-base bg-surface-base">
            {data.recentDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-primary">{doc.filename}</span>
                  <span className="text-xs text-subtle">{formatFileSize(doc.fileSize)}</span>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    doc.status === 'uploaded' || doc.status === 'ready'
                      ? 'bg-success-subtle text-success'
                      : doc.status === 'pending' || doc.status === 'ingesting'
                        ? 'bg-info-subtle text-info'
                        : doc.status === 'failed'
                          ? 'bg-danger-subtle text-danger'
                          : 'bg-surface-sunken text-subtle'
                  }`}
                >
                  {doc.status ?? 'unknown'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!hasDocuments && (
        <div className="rounded-xl border border-dashed border-base bg-surface-sunken p-10 text-center">
          <p className="text-sm text-subtle">
            No files yet. Upload your first document to get started.
          </p>
          <Link
            href={`/projects/${data.id}/files`}
            className="mt-3 inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Upload Files
          </Link>
        </div>
      )}
    </div>
  )
}
