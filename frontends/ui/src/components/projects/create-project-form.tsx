// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useActionState } from 'react'
import { Button, Flex, FormField, Text, TextInput } from '@/adapters/ui'
import { createProject, type CreateProjectState } from '@/app/projects/actions'

const initialState: CreateProjectState = {}

export function CreateProjectForm(): JSX.Element {
  const [state, formAction, isPending] = useActionState(createProject, initialState)

  return (
    <form action={formAction}>
      <Flex direction="col" gap="4">
        <FormField slotLabel="Project name" className="w-full">
          <TextInput
            name="name"
            placeholder="OIB fire safety review"
            disabled={isPending}
            autoFocus
            aria-label="Project name"
            className="w-full"
          />
        </FormField>
        <Text kind="body/regular/sm" className="text-subtle">
          Create a focused workspace for documents, retrieval, members, and chat context.
        </Text>

        {state.error && (
          <div className="rounded-xl border border-status-error bg-status-error-muted p-3">
            <Text kind="body/regular/sm" className="text-status-error">
              {state.error}
            </Text>
          </div>
        )}

        <Flex gap="2" justify="end" className="pt-1">
          <Button kind="primary" size="large" type="submit" disabled={isPending} className="w-full sm:w-auto">
            {isPending ? 'Creating...' : 'Create project'}
          </Button>
        </Flex>
      </Flex>
    </form>
  )
}
