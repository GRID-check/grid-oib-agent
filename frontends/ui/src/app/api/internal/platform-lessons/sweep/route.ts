/**
 * Internal sweep trigger — the seam an external clock can drive.
 *
 * Distillation is event-driven (every down-vote kicks it) and self-healing, so
 * no scheduler container ships with it: a deployment where nobody votes is
 * also one where no backlog forms. This exists for the operator who wants a
 * clock anyway — a Kubernetes CronJob, a compose sidecar, `cron` — and for
 * draining a backlog after a long distiller outage without sitting in the
 * dashboard clicking the button.
 *
 * Token-guarded and cross-tenant like its sibling digest route. Bounded by the
 * same manual-sweep limit, so a clock pointed at it cannot spend more per call
 * than a person could.
 */

import { internalApiRoute } from '@/lib/api/handler'
import { runInternalLessonSweep } from '@/lib/platform-lessons/service'

export const POST = internalApiRoute(
  'platform-lessons-sweep',
  async () => {
    return { result: await runInternalLessonSweep() }
  },
  {
    tenancy: {
      crossTenant:
        'the lesson pipeline distills reports from every tenant into anonymized fleet-wide lessons',
    },
  }
)
