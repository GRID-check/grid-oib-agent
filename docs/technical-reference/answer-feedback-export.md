# Answer-feedback export

The export behind **Plattform → Antwortqualität → Bewertungen → Exportieren**: every
vote users left on an answer, with the turn it rated, as an Excel workbook for
a person or a CSV for a script. The column list is defined once in
`frontends/ui/src/lib/feedback/export-columns.ts`; both formats and the
workbook's own data dictionary are rendered from it. The key tables below
must list the same keys in the same order. `export-columns.spec.ts` fails
when they disagree.

## Getting it

`GET /api/platform/answer-feedback/export`, platform owners only
(`platform:organizations:view`). Route reference: [`docs/api/bff-routes.md`](../api/bff-routes.md).

| Parameter | Values | Meaning |
|---|---|---|
| `days` | `7`, `30` (default), `90` | The window, in UTC calendar days ending today, the same days the page counts. A vote is in it by its first cast (`first_voted_at`). |
| `scope` | `all` (default), `selection` | `all`: every vote in the window, both verdicts. `selection`: the page's filters as well (`org`, `topic`, `verdict`, `reason`, `q`). |
| `format` | `csv` (default), `xlsx` | The page's menu links to `xlsx` for both scopes and to `csv` "for scripts". |
| `summary` | `weekly` | Instead of the votes: the weekly table below as CSV. `days` and `org` apply. |

File names: `piloti-bewertungen_<from>_<to>.xlsx`, with `_auswahl` for a
selection and `_erste-5000` when the row cap cut it; the CSV has the same stem.
At most 5,000 votes, newest first. A cut file also carries
`X-Grid-Export-Truncated: 5000`. The weekly table has its own cap of 5,000 rows,
newest week first, so a cut drops the oldest weeks.

## The workbook

1. **Bewertungen / Votes**: one row per vote, the columns below. Dates are
   Excel dates (UTC), counts and money are numbers, yes/no is `1`/`0` so a
   column sums or averages. The header is frozen and filterable, and long text
   wraps. The two link columns are hyperlinks.
2. **Wochen / Weeks**: per organization and ISO week, with the denominator a
   rate needs.
3. **Übersicht / Overview**: generation time, window, scope and filters,
   totals over the whole set (votes, verdicts, distinct voters, organizations,
   uncapped), whether either cap was hit, and the caveats a number from the file
   must be quoted with.
4. **Spalten / Columns**: this dictionary, in the reader's language.

Labels, descriptions and sheet names come from the `feedbackExport` dictionary
(`src/i18n/dictionaries/*/feedback-export.ts`) in the requester's locale. The
keys do not change with the locale.

## The CSV

RFC 4180: comma, CRLF, every cell quoted, UTF-8 with a BOM. The header is the
keys below, and the columns and their order are the workbook's first sheet.
Times are ISO 8601 UTC, days `YYYY-MM-DD`, yes/no `1`/`0`, lists `;`-joined,
decimals with a dot. A cell that would open as a spreadsheet formula (`=`, `+`,
`-`, `@`, tab, CR) is prefixed with an apostrophe (`lib/text/csv-cell.ts`).
Readers strip one leading apostrophe before those characters.

The keys are a contract. `scripts/feedback_to_cases.py` reads `verdict`,
`question`, `expected_answer`, `reason` and `voted_at` (falling back to the old
`created_at`). Add columns freely, and rename or remove one only together with
its readers.

## Vote columns

| Key | Meaning | Format | Source |
|---|---|---|---|
| `feedback_id` | Stable id of the vote | id | `answer_feedback.id` |
| `voted_at` | Latest cast; a re-vote moves it | datetime | `answer_feedback.updated_at` |
| `first_voted_at` | First cast; the window, page and weeks count by it | datetime | `answer_feedback.created_at` |
| `vote_changed` | Changed more than a second after the first cast | 1/0 | `updated_at > created_at + 1 s` |
| `vote_date` | UTC day of the first cast | date | `created_at` |
| `iso_week` | ISO week of the first cast, matches the weekly table | week | `created_at` |
| `verdict` | `up` or `down` | text | `answer_feedback.verdict` |
| `helpful` | 1 on `up`; its mean is the helpful rate | 1/0 | `verdict = 'up'` |
| `reason` | Reason key on a down-vote, `other` when none was chosen; empty on `up` | text | `answer_feedback.reason` |
| `reason_label` | The reason as the voter saw it | text | dictionary |
| `organization_name` | Display name, empty when unresolved | text | WorkOS / `organizations` |
| `organization_id` | WorkOS organization id | id | `answer_feedback.organization_id` |
| `project_name` | Project of the conversation | text | `projects.name` |
| `project_id` | Project id | id | `answer_feedback.project_id`, else `conversations.project_id` |
| `bundesland` | Federal state key from the project profile | text | `projects.profile.facts.bundesland.value` |
| `conversation_title` | Title, empty when deleted or never saved | text | `conversations.title` |
| `conversation_id` | Conversation of the rated answer | id | `messages.conversation_id`, else the vote's |
| `message_id` | Id of the rated answer | id | `answer_feedback.message_id` |
| `voter_key` | Pseudonym, see below | id | `sha256(organization_id:user_id)`, 12 hex |
| `topics` | OIB topic tags | list | `conversations.tags` |
| `topic_brandschutz` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_schallschutz` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_barrierefreiheit` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_energie` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_statik` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_hygiene` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_nutzungssicherheit` | 1 when tagged | 1/0 | `conversations.tags` |
| `topic_allgemein` | 1 when tagged | 1/0 | `conversations.tags` |
| `question` | The user message the answer replied to | text | `messages.content` |
| `answer` | The rated answer; cut at 32,767 characters in Excel | text | `messages.content` |
| `comment` | The voter's words on a down-vote | text | `answer_feedback.comment` |
| `expected_answer` | What a good answer would have contained, per the voter | text | `answer_feedback.expected_answer` |
| `answer_chars` | Length of the stored answer | integer | `length(messages.content)` |
| `answer_mode` | `shallow`, `deep`, `meta`, `error`, or `report` for a research run | text | `provenance.routingDecision` |
| `answer_confidence` | `low`, `medium`, `high` | text | `provenance.answerConfidence` |
| `confidence_capped_reason` | Why the shown confidence was lowered | text | `provenance.answerConfidenceCappedReason` |
| `sources_cited` | Cited sources | integer | `metadata.citations.sources` |
| `citations_removed` | Citations removed as unverifiable | integer | `provenance.citationsRemoved.count` |
| `research_truncated` | Research stopped early | 1/0 | `provenance.researchTruncated` |
| `skills` | Skills that shaped the answer | list | `provenance.skillsActivated` |
| `answered_at` | When the answer was stored | datetime | `messages.created_at` |
| `client_duration_s` | Question to finished answer, measured in the asker's browser | seconds | `provenance.answerDurationMs / 1000` |
| `llm_calls` | Model calls billed to the answer | integer | `llm_usage_events` |
| `models` | Distinct models of those calls | list | `llm_usage_events.model` |
| `tokens_total` | Tokens, input and output | integer | `llm_usage_events.total_tokens` |
| `cost_usd` | Provider cost in USD, before customer pricing | USD | `llm_usage_events.cost_usd` |
| `lesson_id` | Platform lesson distilled from the vote | id | `platform_lesson_reports.lesson_id` |
| `lesson_status` | `candidate`, `active`, `retired`, or `skipped` | text | `platform_lessons.status`, `platform_lesson_reports.outcome` |
| `lessons_holdout` | Lessons experiment arm; empty when none ran | 1/0 | `answer_feedback.lessons_holdout` |
| `app_url` | The answer in its conversation in Piloti | link | app origin + conversation deep link |
| `langfuse_trace_url` | The answer's trace in Langfuse | link | `LANGFUSE_PUBLIC_URL`, `LANGFUSE_PROJECT_ID` |
| `trace_id` | Langfuse/OTel trace id | id | `messages.metadata.trace_id` |

`provenance` is the answer row's normalized `messages.metadata.provenance`
(`lib/conversations/agent-answer-metadata.ts`). Cost follows `sumAnswerUsage`:
a chat turn's calls are the ledger rows with its organization, conversation and
answer id, and a research run's are those with its backend job id. All
enrichment is joined in one bounded statement (`lib/feedback/export-repository.ts`).

## Weekly columns

| Key | Meaning | Format | Source |
|---|---|---|---|
| `organization_name` | Display name | text | WorkOS / `organizations` |
| `organization_id` | WorkOS organization id | id | `organization_id` |
| `iso_week` | ISO week, UTC | week | |
| `week_start` | Monday of the week, UTC | date | |
| `answers` | Answers produced in the week, united with answers rated in it | integer | `messages` ∪ `answer_feedback.message_id` |
| `rated_answers` | Answers with at least one vote in the week | integer | `answer_feedback` |
| `up` | Helpful votes first cast in the week | integer | `answer_feedback` |
| `down` | Not-helpful votes first cast in the week | integer | `answer_feedback` |
| `helpful_rate` | `up / (up + down)`, empty under 5 votes | percent | |
| `coverage` | `rated_answers / answers` | percent | |

`answers` is the page's coverage denominator per week. A turn that was never
stored counts only once it is rated, so the figure can still under-count.

## Reading it honestly

- **Voting is voluntary.** The votes describe the people who chose to vote, not
  every answer. Quote the helpful rate next to the coverage.
- **`voter_key`** is the first 12 hex digits of `sha256(organization_id + ':' +
  user_id)`. It is stable per person and organization, so votes group by person,
  and it is the same construction as `platform_lesson_reports.org_hash`. It is
  pseudonymous, not anonymous: anyone holding the user id can recompute it. The
  export carries no user id, name or e-mail.
- **Deleted conversations.** Erasing a conversation deletes its messages, so
  `question` and `answer` are empty. The vote row stays, `comment` and
  `expected_answer` included. Votes are not part of the conversation erasure.
- **`app_url`** opens for members of that organization only, and is empty when
  the conversation has no row or no app origin is configured
  (`WORKOS_REDIRECT_URI`).
