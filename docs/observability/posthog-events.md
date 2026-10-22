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
- **Every server event carries `release`, `service` and `app_host`**, the
  deployed commit (`GRID_GIT_SHA`), the process (`OTEL_SERVICE_NAME`) and the
  deployment's host (`app.piloti.at`, `app.dev.piloti.at`, from the pinned
  redirect URI), registered once as super properties of the server client.
  Staging and production share the project and both run `APP_ENV=production`,
  so `app_host` is what tells their server events apart; before 2026-10-20
  nothing did.
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
| `document_ingest_finished` | personless | `status` (`completed`, `failed`, `quarantined`), `screening`, `file_type` (extension), `page_count`, `chunk_count`, `duration_ms` (from dispatch to the read that noticed), `organization_id` | `lib/analytics/ingest-events.ts`, called by `reconcileDocumentStatuses` for the rows that read moved; a row a person stopped is not announced, because a stop reports no read |
| `bim_query_executed` | personless | `kind` (the query op), `ok`, `organization_id` | `app/api/internal/bim/query/route.ts` |
| `agent_operation_called` | the person the call acted for | `operation` (catalog name, or `search-operations`, `describe-operation`, `call-operation`), `domain`, `door` (`mcp` for an external agent, `piloti` for the in-product agent, `a2a` for the A2A door's call of an ask route, `platform` for the platform door at `/api/platform/mcp`), `mode` (`search`, `tools`; null on the A2A door; `search` was `discovery` until October 2026), `decision` (`run`, `propose`, `refused`, `confirm`: an outside agent's destructive call put to the person through MCP elicitation, `declined`: they did not confirm it, `person_required`: not run because it needs the person's yes and the client cannot ask for it, status 403), `decision_source` (`elicitation` on the round that runs a confirmed call; absent otherwise), `status` (HTTP status of the route that ran, or the refusal's), `duration_ms`, `client_id` (the OAuth client; null for Piloti), `organization_id` | `lib/agent-api/telemetry.ts`, called by the MCP server's tool handlers (`lib/agent-api/mcp-server.ts`, `discovery.ts`) and by the A2A door (`lib/a2a/request-handler.ts`). One per tool call or A2A method, including refusals and Piloti's proposals; not the polls an A2A call waits with |
| `agent_operation_missing` | the person | `description_length` (characters; the text itself is never sent, because an agent's free text can quote a document or a name), `category` (`missing_operation`, `tool_description`, `input_schema`, `error_message`, `result_shape`, `other`: what the report is about; a fixed enum, so safe to send; events before October 2026 have none and were all missing operations), `door`, `mode`, `client_id`, `organization_id` | `lib/agent-api/discovery.ts`, the `report-missing-operation` tool. Counts how often an agent looked for something the catalog does not offer; the text stays in the agent's own transcript. Named `agent_capability_missing` (tool `report-missing-capability`) until October 2026: "capability" is the glossary's word for an infrastructure dependency, and the thing missing is an operation. An insight over both names needs both events |
| `budget_blocked` | the refused user | `blocked_scope` (`organization`, `member`, `project`), `unit` (`credit`, `token`), `organization_id` | `lib/budgets/budget-events.ts`, called by `app/api/auth/websocket-scope/route.ts`. Once per person and scope per hour |
| `budget_threshold_crossed` | personless | `scope`, `window` (`day`, `month`), `pct` (`80` or `100`), `unit`, `subject_id` (the project id for a project budget, else absent), `organization_id` | `lib/budgets/budget-events.ts`, called by `app/api/internal/usage/route.ts` after the ledger write. Once per scope, window and threshold; the dedupe key is in the shared cache and starts with the organization |
| `push_device_registered` | the person | `organization_id` | `lib/push/service.ts`, `registerDevice` (also on each refresh a browser makes) |
| `push_device_removed` | the person | `organization_id` | `lib/push/service.ts`, `removeDevice` |
| `push_notification_sent` | personless | `item_type`, `category`, `urgency`, `devices`, `items` (inbox rows the notification told about: more than 1 for a folded burst, `lib/push/fold.ts`), `delivered`, `gone`, `rejected`, `transient`, `organization_id` | `lib/push/inbox-push-job.ts`, once per job that reached the push services. `gone` devices were pruned |
| `annotation_created` | the person who set it, or for Piloti the person it acted for | `document_id`, `author_kind` (`person`, `piloti`), `kind` (the mark's kind), `status` (`open`, or `proposed` for Piloti's proposal), `organization_id` | `lib/annotations/service.ts`, `createAnnotation` and Piloti's `insertPilotiMarks`, once per mark. The service is the one door the review, the inbox, the chat's card and Piloti pass, so no surface counts twice or not at all |
| `annotation_closed` | who closed it, or for Piloti the person it acted for | `document_id`, `status` (`resolved`, `dismissed`), `by` (`person`, `piloti`), `author_kind` (whose mark: `person`, `piloti`), `was` (`open`, `proposed`), `organization_id` | `lib/annotations/service.ts`, `updateAnnotation`, when a status move closes the mark. A carry's closing of the replaced document's mark is not a close |
| `annotation_carried` | the carrier | `document_id` (where the mark was), `way` (`in_place`, `across`), `by`, `organization_id` | `lib/annotations/service.ts`, `carryToCurrent` (in place) and `carryAcross` (as a linked mark of the replacing document) |
| `llm_usage_hourly` | personless | `hour` (ISO start of the UTC hour, also the event's timestamp), `model`, `activity` (`chat`, `ingest`, `dictation`), `purpose` (`agent`, or the backend's usage role: `rerank`, `decision`, `ingest_vision`, …), `user_id`, `project_id`, `own_key`, `billed` (false for dictation), `unit` (`credit`, `token`: the organization's), `amount` (in `unit`), `calls`, `prompt_tokens`, `completion_tokens`, `cached_tokens`, `reasoning_tokens`, `total_tokens`, `credits`, `cost_usd`, `price_usd`, `audio_seconds`, `organization_id` | `lib/analytics/usage-export.ts`, once per closed hour and group, sent by the scheduler's ten-minute ask (`/api/internal/analytics/usage-export`). Never twice: a cursor in `analytics_export_cursors` moves only after PostHog took the hour ([`org-spend-in-posthog.md`](org-spend-in-posthog.md)) |
| `organization_budget_snapshot` | personless | `organization_name`, `unit`, `daily_limit`, `monthly_limit` (null: none), `limits_explicit` (false: the seeded allowance), `day_amount`, `month_amount`, `day_pct`, `month_pct`, `blocked`, `blocked_scope`, `member_limits`, `project_limits` (counts), `month_calls`, `month_tokens`, `month_credits`, `month_cost_usd`, `month_price_usd`, `organization_id` | `lib/analytics/usage-export.ts`, once per UTC hour per organization that spent in the last 35 days or set an organization limit. The organization's name is a business name, never a person's |
| `product_feedback_ticket_opened` | the reporter | `ticket_id` (the PostHog Support ticket), `report_id`, `kind`, `allow_contact`, `organization_id` | `lib/product-feedback/service.ts`, `openTicketFor`, once the ticket is open and tagged. Feeds the Slack alert (`deploy/posthog/support/slack-alert.hog`): PostHog's own ticket events cannot say which deployment a ticket came from, `app_host` can. The words stay on the ticket |
| `product_feedback_reply_sent` | the reporter | `ticket_id`, `report_id`, `kind`, `allow_contact`, `organization_id` | `lib/product-feedback/service.ts`, `replyToOwnProductFeedback`, after PostHog took the reply. Posts the reply into the alert's Slack thread |
| `annotation_due_reminders_sent` | personless | `checked`, `due_soon`, `overdue`, `already` (reminded of before for that date), `unreachable` (the Zuständige may no longer open the document), `failed`, `organization_id` | `lib/annotations/due-reminders.ts`, `runDueRemindersSlice`, once per organization's daily job when its last page is done |

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
| `product_feedback_submitted` | `kind` | `features/product-feedback/components/feedback-form.tsx` |
| `document_uploaded` | `count`, `types` (comma-joined extensions), `shelf` | `features/documents/hooks/use-file-upload.ts` |
| `chat_message_sent` | `has_attachments`, `effort`, `data_source_count` | `features/chat/hooks/use-websocket-chat.ts` |
| `similar_passages_searched` | `entry` (`citation` or `selection`), `origin` (`point` or `embedded`), `groups`, `documents`, `projects_searched` | `features/similar-passages/lib/use-similar-passages.ts`, when an answer arrives |
| `similar_passage_opened` | `group` (`current`, `project`, `office_shelf`), `rank` (the document's place in the answer) | `features/similar-passages/lib/use-similar-passages.ts`, `useSimilarPassagesViewer().open` |
| `report_exported` | `kind` (`answer`, `room_schedule`, `annotations`, `open_points`), `format`. The trigger of the CSAT survey | `features/chat/components/AnswerActions.tsx`, `features/bim/components/ifc-model-tables.tsx`, `features/grid-cards/components/IfcDataCards.tsx`, `features/documents/components/review/review-export-menu.tsx` (a document's Protokoll, `annotations`), `features/documents/components/open-points/project-protocol-menu.tsx` (the project's Offene Punkte, `open_points`); each once its file is handed to the browser. Filing a Protokoll in the project („Im Projekt ablegen“) sends nothing: it stays in the app, and the upload's audit event records it |
| `usage_notice_shown` | `level` (`forecast`, `warning`, `critical`, `exhausted`), `scope`, `window`, `unit`, `can_change` | `features/chat/components/ChatUsageNotice.tsx`, once per notice key per page view |
| `usage_notice_dismissed` | `level`, `scope`, `window` | `features/chat/components/ChatUsageNotice.tsx`, the notice's × |

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
| `annotation_answered_from_inbox` | The row's „Antworten“ posts the thread's own reply (`POST …/annotations/{id}/replies`) through the same typed client as the Prüfansicht, so the server cannot tell the two apart. The room's peer header is missing on a row's reply, but also on any reply while the room is down, so it would count wrong. It needs the client to say where it answered |
| `answer_completed`, `citation_opened`, `document_opened`, `ifc_model_opened` | Browser events the analytics review proposes; they belong to the browser client and get a row here when they land |
