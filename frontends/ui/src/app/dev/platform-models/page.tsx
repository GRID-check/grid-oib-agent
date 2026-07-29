'use client'

/**
 * Dev preview for the platform default-model surface. Renders the REAL card
 * with fixture data so the three states that matter can be reviewed and
 * screenshotted without a backend or an OpenRouter key:
 *
 *  - a group pinned to a platform default (`shallow_research`, `intent`),
 *  - a group still on the workflow config (`clarifier`, `deep_research`, …),
 *  - a pinned default with no zero-data-retention endpoint (`deep_research_router`),
 *    which ZDR tenants cannot inherit.
 *
 * A module-scope fetch shim (browser + dev only) serves the defaults payload
 * and the picker search. Not linked from anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { PlatformModelDefaults } from '@/app/app/platform/models/platform-model-defaults'

const AGENT_GROUPS = [
  {
    id: 'intent',
    label: 'Intent & routing',
    description:
      'Classifies each message (meta vs research, shallow vs deep) and writes short meta answers. High-frequency, latency-sensitive.',
  },
  {
    id: 'clarifier',
    label: 'Clarifier',
    description:
      'Asks clarification questions and drafts research plans before deep research. Calls tools (e.g. web search) for context.',
  },
  {
    id: 'shallow_research',
    label: 'Shallow research',
    description: 'The default research agent: iterative tool-calling over knowledge and web sources.',
  },
  {
    id: 'deep_research',
    label: 'Deep research',
    description:
      'Orchestrator, planner, researcher, and report writer of multi-phase deep research. The heaviest reasoning and longest contexts in the system.',
  },
  {
    id: 'deep_research_router',
    label: 'Deep-research source router',
    description: 'Routes deep-research subtasks to data sources. Small, high-frequency structured outputs.',
  },
  {
    id: 'memory_reflection',
    label: 'Memory reflection',
    description:
      'Post-answer background pass that distills durable project memory from a finished turn. Cost-sensitive; runs after every substantive answer when enabled.',
  },
  {
    id: 'ingest_vlm',
    label: 'Document vision (ingestion)',
    description:
      'Captions images and describes vector/scanned drawings (plans, sections, elevations, perspectives) during document ingestion. Must be a vision model that accepts image input.',
  },
]

const DEFAULTS = {
  intent: {
    model: 'deepseek/deepseek-v4-flash',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-07-28T09:00:00Z',
    zdrSafe: true,
  },
  shallow_research: {
    model: 'anthropic/claude-sonnet-5',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-07-28T09:00:00Z',
    zdrSafe: true,
  },
  deep_research_router: {
    model: 'vendor/router-mini',
    updatedByEmail: 'owner@grid.example',
    updatedAt: '2026-07-28T09:00:00Z',
    zdrSafe: false,
  },
}

const WORKFLOW_DEFAULTS = Object.fromEntries(AGENT_GROUPS.map((group) => [group.id, 'deepseek/deepseek-v4-flash']))

const CATALOG = [
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', contextLength: 200000, promptPrice: 0.000003, completionPrice: 0.000015, zdrSafe: true },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextLength: 163840, promptPrice: 0.00000027, completionPrice: 0.0000011, zdrSafe: true },
  { id: 'vendor/router-mini', name: 'Router Mini', contextLength: 65536, promptPrice: 0.0000001, completionPrice: 0.0000004, zdrSafe: false },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformModelDefaultsShim?: boolean }
  if (!w.__platformModelDefaultsShim) {
    w.__platformModelDefaultsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/model-defaults/models')) {
        return Response.json({ group: 'preview', models: CATALOG })
      }
      if (url.startsWith('/api/platform/model-defaults')) {
        return Response.json({ agentGroups: AGENT_GROUPS, defaults: DEFAULTS, workflowDefaults: WORKFLOW_DEFAULTS })
      }
      return real(input, init)
    }
  }
}

export default function PlatformModelsDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8" data-testid="platform-models-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Default models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: the model each agent group runs on for every organization that has not chosen its own.
        </p>
      </div>
      <PlatformModelDefaults />
    </main>
  )
}
