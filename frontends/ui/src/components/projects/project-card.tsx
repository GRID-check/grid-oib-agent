// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Card, Flex, Text } from '@/adapters/ui'
import { SelectEllipse, Document, Chat, Folder, Users } from '@/adapters/ui/icons'
import type { Project } from '@/lib/db/schema'

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps): JSX.Element {
  const createdAt = new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(project.createdAt)

  return (
    <Card className="group overflow-hidden rounded-[1.75rem] border-base bg-surface-raised-30 p-0 shadow-[0_24px_80px_-60px_rgba(15,23,42,0.65)] transition duration-300 hover:-translate-y-1 hover:bg-surface-raised-50">
      <Flex direction="col" gap="5" className="p-5">
        <Flex align="start" justify="between" gap="4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-base bg-surface-sunken text-brand">
            <Folder className="h-5 w-5" />
          </div>
          <Text kind="body/regular/xs" className="rounded-full border border-base px-3 py-1 text-subtle uppercase tracking-[0.18em]">
            Project
          </Text>
        </Flex>

        <Flex direction="col" gap="2">
          <Text kind="label/bold/lg" className="text-primary">
            {project.name}
          </Text>
          <Text kind="body/regular/sm" className="font-mono text-subtle">
            {project.collectionName}
          </Text>
        </Flex>

        <div className="grid grid-cols-[1fr_auto] items-end gap-4 border-t border-base pt-4">
          <Flex direction="col" gap="1">
            <Text kind="body/regular/xs" className="text-subtle uppercase tracking-[0.18em]">
              created
            </Text>
            <Text kind="body/regular/sm" className="text-primary">
              {createdAt}
            </Text>
          </Flex>
          <Flex gap="2">
           <a
            href={`/projects/${project.id}`}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-inverse transition hover:-translate-y-[1px]"
          >
            <SelectEllipse className="h-4 w-4" />
            Open overview
          </a>
          <a
            href={`/projects/${project.id}/files`}
            className="inline-flex items-center gap-2 rounded-full border border-base px-4 py-2 text-sm font-semibold text-primary transition hover:-translate-y-[1px] hover:bg-surface-sunken"
          >
            <Document className="h-4 w-4" />
            Files
          </a>
          <a
            href={`/projects/${project.id}/chat`}
            className="inline-flex items-center gap-2 rounded-full border border-base px-4 py-2 text-sm font-semibold text-primary transition hover:-translate-y-[1px] hover:bg-surface-sunken"
          >
            <Chat className="h-4 w-4" />
            Ask Grid
          </a>
          <a
            href={`/projects/${project.id}/members`}
            className="inline-flex items-center gap-2 rounded-full border border-base px-4 py-2 text-sm font-semibold text-primary transition hover:-translate-y-[1px] hover:bg-surface-sunken"
          >
            <Users className="h-4 w-4" />
            Members
          </a>
          </Flex>
        </div>
      </Flex>
    </Card>
  )
}
