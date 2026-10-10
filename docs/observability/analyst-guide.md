# Reading Grid in Langfuse: a guide for analysts and the Fachbereich

Langfuse is where we look at how Piloti actually behaves: what people ask,
what the answers cost and how long they took, and how good they were, both by
the checks the system runs on every answer and by the people who use it. We
improve the product from these numbers, so they are meant to be read by
business analysts and domain experts, not only by engineers.

**Langfuse is internal.** It holds customers' questions and the answers they
got. Never share a screenshot, an export or a link with a customer, and keep
exports inside the company.

## Getting access

1. Ask a platform administrator for the **Observability Analyst** role in
   WorkOS. It carries `platform:observability:view` and nothing else, so it
   opens Langfuse without opening the platform administration.
2. Open the Langfuse address (`https://langfuse.<your domain>`) and sign in
   with the usual company login. The first sign-in makes you a **Viewer** of
   the Grid project: you can read everything and change nothing.
3. To review answers in the queue, an owner promotes you to **Member** inside
   Langfuse (Settings → Members). Members can add scores and annotations.

## The words you will see

| Langfuse word | In Grid |
|---|---|
| **Trace** | One unit of work. A `chat-turn` trace is one question and its answer. A `research-job` is a long research run. `conversation-title`, `project-summary`, `feedback-digest` and the like are small background model calls |
| **Session** | One chat. All turns of a conversation share it |
| **Observation** | A step inside a trace: the agent itself, each model call (a *generation*), each tool, each knowledge search (a *retriever*) |
| **Score** | A number or a label attached to a trace. Some come from users (the thumbs), some from the system's own checks, some from reviewers and some from AI judges. The full list is in [`langfuse.md`](langfuse.md#scores) |
| **Tag** | A label for fast filtering, like `route:deep` or `confidence:low` |
| **Metadata** | Facts about the trace, like how many sources the answer had |
| **Environment / release** | Which deployment, and which version of the software, produced the trace |
| **Prompt version** | Which version of Piloti's instructions produced a model call |

## Questions you can answer, and where

| Question | Where to look |
|---|---|
| How many questions per day, and how many failed? | Tracing → filter trace name `chat-turn`; tag `outcome:error` for failures |
| How helpful are the answers, and why are bad ones bad? | Scores: `user-feedback` (mean = helpful rate), `user-feedback-reason` broken down by value |
| Which answers did users dislike, and what was wrong with them? | Annotation queue `answer-review`; filter traces with `user-feedback` = 0 |
| Do quick answers and deep research differ in quality? | Group `user-feedback` or `citation-health` by tag `route:shallow` / `route:deep` |
| How often does the system have to correct itself? | Scores `citation-health`, `citations-removed`, `quotes-patched`, `dialect-repairs`, `card-validity` |
| How often are answers shown with low confidence, and why? | Score `answer-confidence`; `confidence-capped` says which guard lowered it |
| Does the answer use what retrieval found? | Score `retrieval-precision` |
| What does an answer cost, and which model? | Trace metadata `usage_cost_usd`; observations of type generation, grouped by model |
| How long do answers take? | Trace latency, filtered by trace name and route tag |
| Did the release on Tuesday make things better or worse? | Any score above, grouped by **release** |
| Did the new prompt version make things better or worse? | Generations grouped by **prompt version**, joined with the trace's scores |
| What did one customer's team experience? | Filter by tag `org:<id>` (only where identity attributes are on) |

## Dashboards worth building

Langfuse dashboards are built in the UI (Dashboards → New dashboard). These
widgets cover most questions above; build them once in a shared dashboard
called **Antwortqualität**:

1. **Helpful rate over time**: score `user-feedback`, average, by day.
2. **Down-vote reasons**: score `user-feedback-reason`, count, by value.
3. **Citation health over time**: score `citation-health`, average, by day.
4. **Corrections per answer**: `citations-removed`, `quotes-patched`,
   `dialect-repairs`, average, by day.
5. **Confidence mix**: score `answer-confidence`, count, by value, by week.
6. **Quality by route**: `user-feedback` and `citation-health`, average, by tag
   `route:*`.
7. **Cost per answer**: traces named `chat-turn`, total cost, average and p95,
   by day.
8. **Latency per answer**: traces named `chat-turn`, latency p50 and p95, by day.
9. **Quality by release**: `citation-health` and `user-feedback`, average, by
   release.
10. **Background calls**: traces with tag `surface:auxiliary`, count and cost,
    by trace name.

## Reviewing answers (Fachbereich)

Every answer a user marked as not helpful lands in the **`answer-review`**
queue, with the user's reason. For each item:

1. Read the question (the trace's input) and the answer (its output).
2. Open the observations to see which sources the knowledge search returned
   and which the answer cited.
3. Record **`review-correctness`** (`correct`, `partly_correct`, `incorrect`)
   and **`review-sources`** (`right_sources`, `missing_sources`,
   `wrong_sources`). Add a comment saying what the right answer or source would
   have been. That comment is what engineering turns into a test case.
4. Mark the item done.

Your verdicts are scores like every other, so they show up in dashboards next
to the users' votes and the system's own checks. Where you and the system
disagree is exactly where we learn the most.

## AI judges

Three AI judges can grade a sample of answers automatically:
`judge-answers-question`, `judge-uncited-claims` and `judge-clarity`. They are
set up but **switched off** until the platform team enables them, because they
send answers to an evaluation model and cost money per answer. Treat their
scores as a second opinion. Their value is in trends and in agreement with
human reviewers, not in any single verdict.

## Comparing versions with the golden questions

The dataset **`golden-questions`** holds the questions our answer test suite
asks, with what a right answer must contain (the OIB-Richtlinie, the Punkt, the
kind of answer). Engineering runs experiments against it when a prompt or a
model changes, and the results appear under Datasets → `golden-questions` →
Runs, side by side. You can add questions from real traces (a trace → Add to
dataset) when you find one the suite should always get right.

## Exporting

Any trace list or score view can be exported as CSV or JSON from its menu.
The platform page **Antwortqualität** in Grid also exports votes as an Excel
workbook ([`answer-feedback-export.md`](../technical-reference/answer-feedback-export.md)).
Exports stay internal.

## Limits to know

* **Traces are kept for 30 days**, then deleted, and a chat a user deletes is
  erased from Langfuse with it. Dashboards therefore show at most the last 30
  days. Longer trends are an open item ([audit](langfuse-audit-2026-10.md)).
* **Scores start on the day this went live.** Older traces have no system
  check scores.
* **Who asked** is visible only where identity attributes are on, and only as
  ids. Langfuse never shows names or e-mail addresses.
* **Background calls** (titles, summaries and the like) are not part of any
  chat session yet.
