// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Link from 'next/link'
import type { ProjectOverviewData } from '../types'

interface ProjectOverviewProps {
  data: ProjectOverviewData
}

function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${size.toFixed(1)} ${units[i]}`
}

export function ProjectOverview({ data }: ProjectOverviewProps) {
  const hasProfile =
    data.profileDisplay && (data.profileDisplay.title || data.profileDisplay.summary)
  const hasDocuments = data.documentCount > 0

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-8">
      {/* Project Identity */}
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">{data.name}</h1>
        {data.profileDisplay?.summary && (
          <p className="mt-2 text-lg text-neutral-500">{data.profileDisplay.summary}</p>
        )}
      </div>

      {/* Context Summary Card */}
      {hasProfile && data.profileDisplay?.keyFacts && data.profileDisplay.keyFacts.length > 0 && (
        <div className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-400">
            Project Context
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-4 gap-x-8 gap-y-3 sm:grid-cols-3">
            {data.profileDisplay.keyFacts.map((fact, i) => (
              <div key={i}>
                <dt className="text-xs text-neutral-400">{fact.label}</dt>
                <dd className="mt-0.5 text-sm font-medium text-neutral-800">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Setup Prompt */}
      {!hasProfile && (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-6">
          <p className="text-sm text-neutral-500">
            Tell Grid about this project to get personalized assistance. Project context helps the
            AI understand your goals, requirements, and constraints.
          </p>
          <Link
            href={`/projects/${data.id}/settings`}
            className="mt-3 inline-flex items-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            Set up project context
          </Link>
        </div>
      )}

      {/* Quick Actions */}
      <div className="flex gap-3">
        <Link
          href={`/projects/${data.id}/chat`}
          className="inline-flex items-center rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Ask Grid
        </Link>
        <Link
          href={`/projects/${data.id}/files`}
          className="inline-flex items-center rounded-lg border border-neutral-300 bg-white px-5 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Upload Files
        </Link>
        {data.profileDisplay?.missingInfo && data.profileDisplay.missingInfo.length > 0 && (
          <Link
            href={`/projects/${data.id}/settings`}
            className="inline-flex items-center rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100"
          >
            Complete context
          </Link>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-2xl font-semibold text-neutral-900">{data.documentCount}</p>
          <p className="mt-1 text-sm text-neutral-400">Files</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-2xl font-semibold text-neutral-900">{formatFileSize(data.totalFileSize)}</p>
          <p className="mt-1 text-sm text-neutral-400">Total size</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-white p-5">
          <p className="text-2xl font-semibold text-neutral-900">{data.collectionName}</p>
          <p className="mt-1 text-sm text-neutral-400">Knowledge base</p>
        </div>
      </div>

      {/* Recent Documents */}
      {hasDocuments && (
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-400">
              Recent Files
            </h2>
            <Link
              href={`/projects/${data.id}/files`}
              className="text-sm text-neutral-500 hover:text-neutral-700"
            >
              View all
            </Link>
          </div>
          <div className="mt-3 divide-y divide-neutral-100 rounded-xl border border-neutral-200 bg-white">
            {data.recentDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-neutral-900">{doc.filename}</span>
                  <span className="text-xs text-neutral-400">{formatFileSize(doc.fileSize)}</span>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    doc.status === 'uploaded' || doc.status === 'ready'
                      ? 'bg-green-50 text-green-700'
                      : doc.status === 'pending' || doc.status === 'ingesting'
                        ? 'bg-blue-50 text-blue-700'
                        : doc.status === 'failed'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-neutral-50 text-neutral-500'
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
        <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-10 text-center">
          <p className="text-sm text-neutral-400">
            No files yet. Upload your first document to get started.
          </p>
          <Link
            href={`/projects/${data.id}/files`}
            className="mt-3 inline-flex items-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            Upload Files
          </Link>
        </div>
      )}
    </div>
  )
}
