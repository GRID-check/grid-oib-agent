/**
 * Commissioning from inside a thread is offered only where a run may file:
 * never in a closed project (ADR-0088), whose BFF refuses the run with 403
 * `project-closed`. Null hides „Klären" and „Bericht fortschreiben".
 */
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { CurrentProjectProvider, type CurrentProject } from '@/features/projects/lib/current-project'
import { useCommissionRun } from './use-commission-run'

vi.mock('@/lib/runs/run-view-client', () => ({ commissionRun: vi.fn() }))

const project = (status: CurrentProject['status']): CurrentProject => ({
  id: 'p1',
  name: 'Seestadt',
  status,
  closedAt: status === 'closed' ? '2026-10-01T00:00:00Z' : null,
  readsBecauseClosed: false,
})

const inProject = (value: CurrentProject) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <CurrentProjectProvider value={value}>{children}</CurrentProjectProvider>
  }

describe('useCommissionRun', () => {
  test('offers commissioning in an active project', () => {
    const { result } = renderHook(() => useCommissionRun('p1', 'c1'), { wrapper: inProject(project('active')) })
    expect(result.current).not.toBeNull()
  })

  test('offers nothing in a closed project', () => {
    const { result } = renderHook(() => useCommissionRun('p1', 'c1'), { wrapper: inProject(project('closed')) })
    expect(result.current).toBeNull()
  })

  test('offers nothing without a project or a conversation', () => {
    expect(renderHook(() => useCommissionRun(null, 'c1')).result.current).toBeNull()
    expect(renderHook(() => useCommissionRun('p1', null)).result.current).toBeNull()
  })
})
