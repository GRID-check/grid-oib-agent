# PostHog event catalogue

Every product event Piloti sends to PostHog, the properties it carries and the
line that sends it ([ADR-0100](../adr/0100-posthog-is-the-product-platform-and-langfuse-feeds-it.md),
[`posthog-migration.md`](posthog-migration.md)). Read it before you add an
event, so a second spelling of an existing one does not split a funnel, and
before you build an insight, so you know which side of the wire sends the
numbers you are counting.

LLM traces, generations and scores are **not** in this list. They reach PostHog
through Langfuse's own PostHog integration (the `langfuse observation` and
`langfuse score` events, exported hourly), and our code never sends `$ai_*`
events. `tests/test_posthog_boundaries.py` enforces that.

## Rules every event follows

- **The distinct id is the WorkOS user id**, in the browser and on the server.
  A system action (a scheduled run starting, an ingest finishing, spend
  crossing a limit) is **personless**: the call site passes `null`, the event
  goes out with no distinct id of ours, and posthog-node gives it a fresh one
  with `$process_person_profile: false`, so no person is minted for it.
- **Every server event carries `release` and `service`**, the deployed commit
  (`GRID_GIT_SHA`) and the process (`OTEL_SERVICE_NAME`), registered once as
  super properties of the server client.
- **Tenant context is a property, never a group.** `organization_id` (the WorkOS
  organization) is registered as a super property in the browser and set by
  `captureServer({ organizationId })` on the server. PostHog group analytics is
  a paid add-on, so `posthog.group()` and the `groups` option are not used.
- **Properties are non-personal.** Ids of our own rows, kinds, enums, counts,
  durations and statuses. Never a question, an answer, a document or file name,
  an email, a name, a URL or an error message that can quote one.
- **Both sides use a closed union.** `PostHogEvent` in
  `frontends/ui/src/lib/analytics/posthog.ts` and `ServerEvent` in
  `frontends/ui/src/lib/analytics/posthog-server.ts`. A typo fails the build.
  Add the name to the union and a row here in the same change.
- **A server event never changes a route.** `captureServer` queues and returns;
  it cannot throw, and the budget checks that need the cache or the ledger run
  un-awaited behind their own `try`. With PostHog unconfigured every call is a
  no-op and reads nothing.
- **Every server event passes `scrubServerEvent`** (`lib/analytics/scrub-server-event.ts`),
  posthog-node's `before_send`, which removes the query and fragment parameters
  named `sig`, `token`, `secret`, `key`, `code` or `state` from any string in
  the event, so a signed image link or an OAuth callback cannot leave the process
  by accident.

Paths below are under `frontends/ui/src`.

## Server events

Sent from the BFF, where the server is the truth. The browser cannot see a
scheduled run, and cannot be trusted to survive a redirect or to be unblocked.

| Event | Distinct id | Properties | Emitted at |
|---|---|---|---|
| `user_signed_in` | the user | `method` (WorkOS `authenticationMethod`), `is_new_user` (account created in the last 10 minutes; absent if WorkOS gave no time), `organization_id` | `app/api/auth/callback/route.ts`, `handleAuth` `onSuccess` |
| `organization_created` | the creator | `organization_id` | `app/api/organizations/route.ts`, after the audit event. The browser no longer sends it |
| `resource_shared` | the sharer | `resource_type`, `audience_kind` (`person`), `role`, `organization_id` | `app/api/sharing/[resourceType]/[resourceId]/grants/route.ts`, `POST` of a grant. An owner escalation is not a share |
| `task_assigned` | the assigner | `resource_type`, `organization_id` | `app/api/assignments/[resourceType]/[resourceId]/route.ts`, `POST` |
| `mention_released` | the releaser | `resource_type`, `organization_id` | `lib/mentions/service.ts`, `releaseRequest`, only when a request was actually closed |
| `job_run_started` | personless | `job_id`, `run_id`, `trigger` (`schedule`), `output` (`chat` or `deep-research`), `organization_id` | `lib/jobs/service.ts`, `fireScheduledJob`, for a run the backend took. A skipped fire is not a start |
| `job_run_finished` | the run's requester | `job_id` (null without a definition), `run_id`, `status` (`success`, `failure`, `interrupted`), `trigger`, `output` (the run kind), `filing_status`, `duration_ms`, `organization_id` | `lib/tasks/service.ts`, `recordRunOutcome`, once per run (a retried worker report does not repeat it) |
| `document_ingest_finished` | personless | `status` (`completed`, `failed`, `quarantined`), `screening`, `file_type` (extension), `page_count`, `chunk_count`, `duration_ms` (from dispatch to the read that noticed), `organization_id` | `lib/analytics/ingest-events.ts`, called by `reconcileDocumentStatuses` for the rows that read moved |
| `bim_query_executed` | personless | `kind` (the query op), `ok`, `organization_id` | `app/api/internal/bim/query/route.ts` |
| `budget_blocked` | the refused user | `blocked_scope` (`organization`, `member`, `project`), `unit` (`credit`, `token`), `organization_id` | `lib/budgets/budget-events.ts`, called by `app/api/auth/websocket-scope/route.ts`. Once per person and scope per hour |
| `budget_threshold_crossed` | personless | `scope`, `window` (`day`, `month`), `pct` (`80` or `100`), `unit`, `subject_id` (the project id for a project budget, else absent), `organization_id` | `lib/budgets/budget-events.ts`, called by `app/api/internal/usage/route.ts` after the ledger write. Once per scope, window and threshold; the dedupe key is in the shared cache and starts with the organization |

`$exception` events from the server come from `@posthog/next`'s request-error
capture, configured in `lib/analytics/request-error.ts` (see
[`error-tracking.md`](error-tracking.md)), not from this table.

## Browser events

Sent by `capturePosthog(event, properties)` in `lib/analytics/posthog.ts`.
No-op until `initPosthogClient` ran, which needs the host and project token in
`AppConfig`.

| Event | Properties | Emitted at |
|---|---|---|
| `product_tour_completed` | `tour`, `stops` | `features/onboarding/components/product-tour.tsx` |
| `product_tour_skipped` | `tour`, `step`, `stop`, `stops` | `features/onboarding/components/product-tour.tsx` |
| `project_created` | none | `components/projects/create-project-form.tsx` |
| `project_member_access_changed` | `change` (`granted_or_updated`, `removed`), `role` | `components/projects/project-members-form.tsx` |
| `job_created` | `additional_source_count`, `schedule_enabled`, `cadence`, `enabled` | `features/jobs/components/schedule-wizard.tsx` |
| `job_updated` | the same as `job_created` | `features/jobs/components/schedule-wizard.tsx` |
| `job_enabled_changed` | `enabled` | `features/jobs/components/schedule-card.tsx` |
| `job_run_submitted` | `output` | `features/jobs/components/schedule-detail.tsx` (a person pressed "run now"; the schedule's own start is the server's `job_run_started`) |
| `job_deleted` | `output` | `features/jobs/components/schedule-detail.tsx` |
| `skill_created` | `scope`, `enabled`, `hidden`, `preferred_card_count`, `agent_count` | `features/skills/components/skill-editor-dialog.tsx` |
| `skill_updated` | the same as `skill_created` | `features/skills/components/skill-editor-dialog.tsx` |
| `skill_deleted` | `scope` | `features/skills/components/skill-toolbox.tsx`, `skill-editor-dialog.tsx` |
| `skill_enabled_changed` | `scope`, `enabled` | `features/skills/components/skill-toolbox.tsx`, `curated-skills.tsx` |
| `answer_retry_thorough` | `message_id`, `original_effort` | `features/chat/components/RetryThoroughButton.tsx` |
| `answer_feedback_submitted` | `verdict`, `reason` | `features/chat/hooks/use-answer-feedback.ts` |
| `product_feedback_submitted` | `kind` | `features/product-feedback/components/feedback-dialog.tsx` |
| `document_uploaded` | `count`, `types` (comma-joined extensions), `shelf` | `features/documents/hooks/use-file-upload.ts` |
| `chat_message_sent` | `has_attachments`, `effort`, `data_source_count` | `features/chat/hooks/use-websocket-chat.ts` |
| `similar_passages_searched` | `entry` (`citation` or `selection`), `origin` (`point` or `embedded`), `groups`, `documents`, `projects_searched` | `features/similar-passages/lib/use-similar-passages.ts`, when an answer arrives |
| `similar_passage_opened` | `group` (`current`, `project`, `archiv`), `rank` (the document's place in the answer) | `features/similar-passages/lib/use-similar-passages.ts`, `useSimilarPassagesViewer().open` |
| `report_exported` | `kind`, `format`. The trigger of the CSAT survey | `features/chat/components/AnswerActions.tsx`, `features/bim/components/ifc-model-tables.tsx`, `features/grid-cards/components/IfcDataCards.tsx` |

`organization_created` is still a member of the `PostHogEvent` union, but nothing
in the browser sends it any more: the route does. Drop it from the union when the
browser client is next edited.

The SDK adds its own events on top of these (pageviews, `$exception` from
unhandled errors, survey and replay events). They are configured in
`buildPosthogInitOptions` and described in [`posthog-migration.md`](posthog-migration.md).

## Considered and not emitted

| Event | Why not |
|---|---|
| `skill_run` | `GET /api/internal/skills/resolve` resolves the skills an agent MAY use at the start of a run; it is not a run of one, and a per-resolve event would fire on every turn. The honest site is where the agent loads a skill (`use_skill`, Python), through `aiq_agent.observability.posthog_client.capture` |
| `member_joined`, `member_removed`, `member_role_changed` | Done in WorkOS's own widgets in the browser; no code path of ours sees them. They need a WorkOS webhook route |
| `answer_completed`, `citation_opened`, `document_opened`, `ifc_model_opened` | Browser events the analytics review proposes; they belong to the browser client and get a row here when they land |
