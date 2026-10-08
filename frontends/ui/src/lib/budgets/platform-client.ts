import type { PlatformOrgBudget, PlatformOrgBudgetInput } from './platform-contract'

export class PlatformBudgetRequestError extends Error {
  constructor(readonly status: number) {
    super(`Organization budget request failed: ${status}`)
  }
}

export async function fetchPlatformOrgBudget(
  organizationId: string,
  input?: PlatformOrgBudgetInput,
): Promise<PlatformOrgBudget> {
  const response = await fetch(`/api/platform/organizations/${encodeURIComponent(organizationId)}/budgets`, {
    credentials: 'same-origin',
    ...(input ? {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    } : {}),
  })
  if (!response.ok) throw new PlatformBudgetRequestError(response.status)
  return (await response.json()) as PlatformOrgBudget
}
