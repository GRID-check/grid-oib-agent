#!/usr/bin/env bash
# Stand up a throwaway Postgres, apply the full drizzle migration chain, and run
# the row-level-security isolation suite against it as `grid_app_rw` (ADR-0041).
#
# The suite has to run as the RESTRICTED role. Connecting as the owner would
# pass every assertion while proving nothing, because row-level security does
# not apply to a table's owner — so this script is the difference between the
# tests meaning something and merely appearing to.
#
# Everything lives under a temporary directory and is torn down on exit; no
# existing cluster is touched.
set -euo pipefail

UI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../frontends/ui" && pwd)"
PORT="${RLS_TEST_PORT:-55433}"
# `|| true` matters: under `set -e` a glob that matches nothing makes the
# substitution non-zero and kills the script here, so the friendly "install
# postgresql, or set PGBIN" message below would never be the thing an operator
# without server binaries actually sees.
PGBIN="${PGBIN:-$(find /usr/lib/postgresql -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -V | tail -1 || true)}"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/pgdata"
RUNTIME_PASSWORD="rls_test_pw"  # pragma: allowlist secret (throwaway cluster, destroyed on exit)

if [ -z "${PGBIN:-}" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "error: no PostgreSQL server binaries found. Install postgresql, or set PGBIN." >&2
  exit 1
fi

cleanup() {
  # Through run_pg, not directly: pg_ctl refuses to run as root, and on a root
  # host the direct call failed under `|| true` while the rm -rf below deleted
  # the data directory out from under a server that kept running. (CI is
  # unprivileged, which is why it never showed there.) run_pg is defined after
  # this trap is armed, so the early exits above it fall back to the direct call.
  if declare -F run_pg >/dev/null; then
    run_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true
  else
    "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# initdb refuses to run as root, which is normal in CI containers; fall back to
# the `postgres` system user when there is one.
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  if id postgres >/dev/null 2>&1; then
    RUNAS="postgres"
    # The unix socket is created in WORKDIR (-k), so that directory has to be
    # writable by the dropped-to user too, not just PGDATA.
    mkdir -p "$PGDATA"
    chown "$RUNAS" "$WORKDIR" "$PGDATA"
    chmod 755 "$WORKDIR"
  else
    echo "error: running as root and no 'postgres' user exists to drop to." >&2
    exit 1
  fi
fi
run_pg() { if [ -n "$RUNAS" ]; then su "$RUNAS" -c "$1"; else sh -c "$1"; fi; }

echo "==> initialising a throwaway cluster on port $PORT"
run_pg "'$PGBIN/initdb' -D '$PGDATA' -U postgres --auth=trust" >/dev/null
run_pg "'$PGBIN/pg_ctl' -D '$PGDATA' -o '-p $PORT -k $WORKDIR' -l '$PGDATA/server.log' -w start" >/dev/null

# NOTICEs from the idempotent DROP ... IF EXISTS guards are expected noise.
export PGOPTIONS="-c client_min_messages=warning"
PSQL="$PGBIN/psql -h $WORKDIR -p $PORT -U postgres"

# Reproduce the DEPLOYMENT topology, not a convenient one. Migrations run as a
# plain non-superuser database owner with no CREATEROLE and no BYPASSRLS —
# exactly what CloudNativePG hands the app. Running this chain as `postgres`
# instead is why an earlier version of the migration shipped a CREATE ROLE that
# could never have executed on Kubernetes.
echo "==> provisioning roles (a deployment concern, not a migration one)"
$PSQL -q -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE grid_app_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB;" \
  -c "CREATE ROLE grid_app_platform NOLOGIN BYPASSRLS;" \
  -c "CREATE ROLE grid_app_rw LOGIN NOINHERIT PASSWORD '$RUNTIME_PASSWORD';" \
  -c "GRANT grid_app_platform TO grid_app_rw;" \
  -c "CREATE DATABASE grid_app OWNER grid_app_owner;"

echo "==> applying the migration chain as grid_app_owner (no CREATEROLE, no BYPASSRLS)"
cd "$UI_DIR"
MIGRATE="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_app"
node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  $MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "MIGRATION FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done

# Every suite here needs the same cluster and the same restricted role. The BIM
# and memory ones are here rather than in the unit shards because every claim
# they make is a claim about SQL — jsonb property filters, grouped aggregates,
# the element-to-model tenancy join, "one fact, one live row" through a raw
# cosine query — and a mocked drizzle handle cannot disagree with the fixture
# that mocked it. (The memory suite is the one that found the semantic gate
# reading `.rows` off a postgres-js array, which every mock had agreed with.)
echo "==> running the isolation, BIM query, memory consolidation, restricted memory, upload batches and quarantine decisions, Papierkorb, profile-binding, legal-hold, chat-erasure, restricted-use, run-reconciler, usage-ledger, download-log, closed-project, Steckbrief and Ausmisten suites as grid_app_rw"
GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$RUNTIME_PASSWORD@127.0.0.1:$PORT/grid_app" \
  npx vitest run \
    src/lib/db/tenant-isolation.integration.spec.ts \
    src/lib/bim/query.integration.spec.ts \
    src/lib/bim/model-shelf.integration.spec.ts \
    src/lib/projects/memory-service.integration.spec.ts \
    src/lib/projects/memory-restricted.integration.spec.ts \
    src/lib/documents/document-versions.integration.spec.ts \
    src/lib/documents/list-page.integration.spec.ts \
    src/lib/upload-batches/upload-batches.integration.spec.ts \
    src/lib/authz/folder-access.integration.spec.ts \
    src/lib/projects/collection-placement.integration.spec.ts \
    src/lib/projects/folder-visibility.integration.spec.ts \
    src/lib/documents/shelf-folders.integration.spec.ts \
    src/lib/projects/folder-bin.integration.spec.ts \
    src/lib/documents/stuck-processing.integration.spec.ts \
    src/lib/project-profile/profile-bindings.integration.spec.ts \
    src/lib/compliance/legal-hold.integration.spec.ts \
    src/lib/conversations/erasure-queue.integration.spec.ts \
    src/lib/conversations/restricted-use.integration.spec.ts \
    src/lib/download-log/download-log.integration.spec.ts \
    src/lib/runs/reconcile.integration.spec.ts \
    src/lib/budgets/service.integration.spec.ts \
    src/lib/projects/project-status.integration.spec.ts \
    src/lib/projects/steckbrief.integration.spec.ts \
    src/lib/projects/cleanup.integration.spec.ts

# The job-queue suites claim from ONE table, whichever lane a job is in, so run
# in parallel they claim each other's seeded jobs. One file at a time.
echo "==> running the job-queue suites one file at a time as grid_app_rw"
GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$RUNTIME_PASSWORD@127.0.0.1:$PORT/grid_app" \
  npx vitest run --no-file-parallelism \
    src/lib/jobs-queue/queue.integration.spec.ts \
    src/lib/jobs-queue/repository.integration.spec.ts \
    workers/jobs/runner.integration.spec.mjs

# ---------------------------------------------------------------------------
# Migration 0086: the backfill, asserted per row shape, and its DOWN migration.
#
# A second database in the same cluster, migrated only as far as 0085, seeded
# with fixtures in the old tables, then handed 0086 and checked row by row.
# Doing it here rather than in a spec is the point: the spec suites run AFTER
# the whole chain, when the old shapes cannot be created any more.
# ---------------------------------------------------------------------------
echo "==> verifying the 0086 backfill and its down migration on grid_backfill"
$PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_backfill OWNER grid_app_owner;"
MIGRATE_B="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_backfill"

# Every migration BEFORE 0086, in journal order.
node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  [ "$tag" = "0086_task_definitions" ] && break
  $MIGRATE_B -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "BACKFILL SETUP FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done

# Four old shapes: a scheduled run with its task (and a rejection), a skipped
# fire with no task, an errored fire with no task, and a delegated task. Plus a
# legacy job-spawned task with no `job_run_id` (pre-0076 rows).
$MIGRATE_B -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'Backfill', 'user_1', 'proj_backfill');

-- The job_runs and tasks below name these two threads, and the composite
-- conversation FK (`(conversation_id, organization_id) -> conversations`)
-- rejects a dangling id — which would abort the seed before 0086 ever runs.
-- `job_id` stays NULL: these are ordinary person-started chats, and it is the
-- old model's column until 0086 repoints it at task_definitions.
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES
  ('s_conv_a', 'org_backfill', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('s_conv_d', 'org_backfill', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000001');

INSERT INTO jobs (id, project_id, organization_id, name, prompt, skill_name, skill_snapshot, output, data_sources, enabled, schedule_cron, schedule_timezone, next_run_at, last_run_at, created_by, created_by_email)
VALUES
  ('bbbbbbbb-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'A', 'Prüfe A', NULL, NULL, 'chat', '["knowledge_layer"]'::jsonb, true, '0 8 * * 1', 'Europe/Vienna', now() + interval '1 day', NULL, 'user_1', 'u@grid.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000b2', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'B', 'Prüfe B', NULL, NULL, 'chat', NULL, true, NULL, 'UTC', NULL, NULL, 'user_1', 'u@grid.test'),
  ('bbbbbbbb-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'C', 'Prüfe C', NULL, NULL, 'deep-research', NULL, true, '0 6 * * *', 'UTC', now() + interval '2 days', NULL, 'user_1', 'u@grid.test');

INSERT INTO job_runs (id, schedule_id, project_id, organization_id, job_id, trigger, status, detail, conversation_id, skill_snapshot, triggered_by)
VALUES
  ('dddddddd-0000-4000-8000-0000000000a1', 'bbbbbbbb-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', 'backend-a', 'schedule', 'submitted', NULL, 's_conv_a', '{}'::jsonb, 'scheduler'),
  ('dddddddd-0000-4000-8000-0000000000b2', 'bbbbbbbb-0000-4000-8000-0000000000b2', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', NULL, 'manual', 'skipped', 'org cap', NULL, '{}'::jsonb, 'user_1'),
  ('dddddddd-0000-4000-8000-0000000000c3', 'bbbbbbbb-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'org_backfill', NULL, 'schedule', 'error', 'backend unreachable', NULL, '{}'::jsonb, 'scheduler');

INSERT INTO tasks (id, organization_id, project_id, kind, title, plan, requester_user_id, requester_email, status, error, deadline_at, job_id, job_run_id, backend_job_id, conversation_id, review, review_reason, reviewed_by, reviewed_at, started_at)
VALUES
  ('eeeeeeee-0000-4000-8000-0000000000a1', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'chat', 'A', '{"prompt":"Prüfe A","skill":{},"dataSources":["knowledge_layer"]}'::jsonb, 'user_1', 'u@grid.test', 'running', NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000a1', 'dddddddd-0000-4000-8000-0000000000a1', 'backend-a', 's_conv_a', 'rejected', 'zu kurz', 'user_1', now(), now() - interval '1 hour'),
  ('eeeeeeee-0000-4000-8000-0000000000d4', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'document', 'Dokument: Aktenvermerk', '{"prompt":"Schreibe …","skill":{},"dataSources":null,"goal":"Schreib den Aktenvermerk"}'::jsonb, 'user_1', 'u@grid.test', 'running', NULL, now() + interval '1 day', NULL, NULL, 'backend-d', 's_conv_d', NULL, NULL, NULL, NULL, now() - interval '10 minutes'),
  ('eeeeeeee-0000-4000-8000-0000000000e5', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'chat', 'A', '{"prompt":"Prüfe A","skill":{},"dataSources":["knowledge_layer"]}'::jsonb, 'user_1', 'u@grid.test', 'succeeded', NULL, NULL, 'bbbbbbbb-0000-4000-8000-0000000000a1', NULL, 'backend-e', NULL, NULL, NULL, NULL, NULL, now() - interval '2 hours'),
  -- `tasks.conversation_id` carried NO foreign key before 0086, so a task can
  -- name a thread that is gone. The new run table's composite FK would reject
  -- the copy; the backfill must drop the provenance instead of aborting.
  ('eeeeeeee-0000-4000-8000-0000000000f6', 'org_backfill', 'aaaaaaaa-0000-4000-8000-000000000001', 'document', 'Dokument: ohne Thread', '{"prompt":"Schreibe …","skill":{},"dataSources":null,"goal":"Ohne Thread"}'::jsonb, 'user_1', 'u@grid.test', 'running', NULL, NULL, NULL, NULL, 'backend-f', 's_conv_missing', NULL, NULL, NULL, NULL, now() - interval '20 minutes');
SQL

$MIGRATE_B -v ON_ERROR_STOP=1 -q -f "drizzle/0086_task_definitions.sql" >/dev/null || {
  echo "MIGRATION 0086 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}

check() {
  local got
  got=$($MIGRATE_B -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "BACKFILL ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}

# Definitions: three jobs + the delegated once arms.
check "SELECT count(*) FROM task_definitions" "5" "one definition per job, plus one for each delegated task"
check "SELECT count(*) FROM task_definitions WHERE trigger = 'schedule'" "2" "jobs with a cron became schedules"
check "SELECT count(*) FROM task_definitions WHERE trigger = 'manual'" "1" "a job with no cron became manual"
check "SELECT count(*) FROM task_definitions WHERE trigger = 'once'" "2" "the delegated tasks became once definitions"
check "SELECT next_run_at > now() FROM task_definitions WHERE id = 'bbbbbbbb-0000-4000-8000-0000000000a1'" "t" "the schedule's next fire survived and is in the future"

# Runs: the merged job_run+task, two task-less fires, the delegated tasks, and
# the legacy task with no job_run link.
check "SELECT count(*) FROM task_runs" "6" "one run per attempt across all four shapes"
check "SELECT status FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000a1'" "running" "the merged run took the TASK's lifecycle"
check "SELECT review || ':' || review_reason FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000a1'" "rejected:zu kurz" "the rejection reached the next run's record"
check "SELECT status || ':' || error FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000b2'" "skipped:org cap" "a skipped fire is a visible run with its reason"
check "SELECT status || ':' || error FROM task_runs WHERE id = 'dddddddd-0000-4000-8000-0000000000c3'" "error:backend unreachable" "an errored fire is a visible run with its reason"
check "SELECT trigger FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000d4'" "delegated" "the delegated attempt names its trigger"
check "SELECT definition_id FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000d4'" "eeeeeeee-0000-4000-8000-0000000000d4" "the delegated definition is the task's own row"
check "SELECT definition_id FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000e5'" "bbbbbbbb-0000-4000-8000-0000000000a1" "the legacy task joined its job's definition"
check "SELECT coalesce(conversation_id, 'NULL') FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000f6'" "NULL" "a dangling task conversation was dropped, not carried into the FK"
check "SELECT conversation_id FROM task_runs WHERE id = 'eeeeeeee-0000-4000-8000-0000000000d4'" "s_conv_d" "a live conversation survives the guard"
check "SELECT to_regclass('public.uniq_task_runs_backend_job_id') IS NOT NULL" "t" "the backend-id lookup index exists"

# The DOWN migration: new tables gone, every old row intact.
$MIGRATE_B -v ON_ERROR_STOP=1 -q -f "drizzle/0086_task_definitions.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0086 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check "SELECT to_regclass('public.task_definitions') IS NULL" "t" "down dropped task_definitions"
check "SELECT to_regclass('public.task_runs') IS NULL" "t" "down dropped task_runs"
check "SELECT count(*) FROM jobs" "3" "down left the jobs table untouched"
check "SELECT count(*) FROM job_runs" "3" "down left the job_runs table untouched"
check "SELECT count(*) FROM tasks" "4" "down left the tasks table untouched"
check "SELECT confrelid::regclass::text FROM pg_constraint WHERE conname = 'conversations_job_id_fkey'" "jobs" "down repointed conversations.job_id at jobs"

echo "==> 0086 backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0092: existing duplicate version numbers are moved, not dropped,
# before the UNIQUE constraint lands — and its DOWN migration.
#
# The same arrangement as 0086 above: a database migrated only as far as 0091,
# seeded with the duplicates the pre-0092 race could write, then handed 0092.
# Without the renumbering the ADD CONSTRAINT fails the deploy on the first pair.
# ---------------------------------------------------------------------------
echo "==> verifying the 0092 renumbering and its down migration on grid_versions"
$PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_versions OWNER grid_app_owner;"
MIGRATE_V="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_versions"

node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  [ "$tag" = "0092_document_version_number_unique" ] && break
  $MIGRATE_V -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "0092 SETUP FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done

$MIGRATE_V -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000092', 'org_v', 'Versions', 'user_1', 'proj_versions');

INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES
  ('d0000000-0000-4000-8000-00000000000a', 'org_v', 'user_1', 'a.pdf', 'org/org_v/doc/a/a.pdf', 'proj_versions', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000092'),
  ('d0000000-0000-4000-8000-00000000000b', 'org_v', 'user_1', 'b.pdf', 'org/org_v/doc/b/b.pdf', 'proj_versions', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000092'),
  ('d0000000-0000-4000-8000-00000000000c', 'org_v', 'user_1', 'c.pdf', 'org/org_v/doc/c/c.pdf', 'proj_versions', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000092');

-- Each document's history by hand. Document a: one duplicated pair (v2).
-- Document c: a triple (v1). Document b: nothing ambiguous, and it must come
-- out untouched.
INSERT INTO document_versions (id, organization_id, document_id, project_id, version_number, state, storage_key, approved_by, approved_at, published_by, published_at, created_by, created_at)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/a/1', NULL, NULL, NULL, NULL, 'user_1', '2026-09-01T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000002', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 2, 'superseded', 'k/a/v2', NULL, NULL, NULL, NULL, 'user_1', '2026-09-02T10:00:00Z'),
  ('a1000000-0000-4000-8000-000000000003', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 2, 'superseded', 'k/a/v2', NULL, NULL, NULL, NULL, 'user_1', '2026-09-02T10:00:01Z'),
  ('a1000000-0000-4000-8000-000000000004', 'org_v', 'd0000000-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000092', 3, 'published', 'k/a/v3', 'user_1', now(), 'user_1', now(), 'user_1', '2026-09-03T10:00:00Z'),
  ('b1000000-0000-4000-8000-000000000001', 'org_v', 'd0000000-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'published', 'k/b/1', 'user_1', now(), 'user_1', now(), 'user_1', '2026-09-01T10:00:00Z'),
  ('c1000000-0000-4000-8000-000000000001', 'org_v', 'd0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/c/1', NULL, NULL, NULL, NULL, 'user_1', '2026-09-01T10:00:00Z'),
  ('c1000000-0000-4000-8000-000000000002', 'org_v', 'd0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/c/1', NULL, NULL, NULL, NULL, 'user_1', '2026-09-01T10:00:01Z'),
  ('c1000000-0000-4000-8000-000000000003', 'org_v', 'd0000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'published', 'k/c/1b', 'user_1', now(), 'user_1', now(), 'user_1', '2026-09-01T10:00:02Z');
SQL

$MIGRATE_V -v ON_ERROR_STOP=1 -q -f "drizzle/0092_document_version_number_unique.sql" >/dev/null || {
  echo "MIGRATION 0092 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}

checkv() {
  local got
  got=$($MIGRATE_V -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0092 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}

numbers() {
  echo "SELECT string_agg(version_number::text, ',' ORDER BY created_at, id) FROM document_versions WHERE document_id = '$1'"
}
checkv "$(numbers d0000000-0000-4000-8000-00000000000a)" "1,2,4,3" "the later of a duplicated pair moved past the document's highest number; nothing else moved"
checkv "$(numbers d0000000-0000-4000-8000-00000000000b)" "1" "a document with no duplicates was not touched"
checkv "$(numbers d0000000-0000-4000-8000-00000000000c)" "1,2,3" "a triple was moved in creation order"
checkv "SELECT storage_key || ':' || state FROM document_versions WHERE id = 'a1000000-0000-4000-8000-000000000003'" "k/a/v2:superseded" "a moved row kept its key and its state"
checkv "SELECT count(*) FROM pg_constraint WHERE conname = 'document_versions_document_id_version_number_key'" "1" "the unique constraint exists"
checkv "SELECT to_regclass('public.idx_document_versions_document') IS NULL" "t" "the redundant plain index is gone"

if $MIGRATE_V -q -c "INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by) VALUES ('org_v', 'd0000000-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-000000000092', 1, 'superseded', 'k/b/dup', 'user_1')" >/dev/null 2>&1; then
  echo "0092 ASSERTION FAILED: a second version 1 of document b was accepted" >&2
  exit 1
fi

$MIGRATE_V -v ON_ERROR_STOP=1 -q -f "drizzle/0092_document_version_number_unique.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0092 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkv "SELECT count(*) FROM pg_constraint WHERE conname = 'document_versions_document_id_version_number_key'" "0" "down dropped the constraint"
checkv "SELECT to_regclass('public.idx_document_versions_document') IS NOT NULL" "t" "down restored the plain index"
checkv "SELECT count(*) FROM document_versions" "8" "down left every version row in place"

echo "==> 0092 renumbering and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0097: stored Herleitung steps rewritten into the chat wire v2
# shape, and its DOWN migration.
#
# A database migrated only as far as 0096, because the pre-v2 rows cannot be
# written once the v2 build's sanitizer guards the column. The spec seeds a
# captured turn in the old shape, runs 0097 (twice), asserts the rows and that
# `sanitizeProvenance` accepts them unchanged, then runs the down and 0097
# again. It connects as the owner, which is what runs a migration.
# ---------------------------------------------------------------------------
echo "==> verifying the 0097 Herleitung step rewrite and its down migration on grid_steps"
$PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_steps OWNER grid_app_owner;"
MIGRATE_S="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_steps"

node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  [ "$tag" = "0097_herleitung_steps_v2" ] && break
  $MIGRATE_S -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "0097 SETUP FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done

GRID_TEST_MIGRATION_DATABASE_URL="postgres://grid_app_owner@127.0.0.1:$PORT/grid_steps" \
  npx vitest run src/lib/conversations/herleitung-steps-v2.migration.spec.ts

echo "==> 0097 step rewrite and down migration verified"

# ---------------------------------------------------------------------------
# Migrations 0110 to 0114, 0117 and 0118: each on a database of its own.
#
# `migrate_until <db> <tag>` creates <db> and applies the journal up to and
# including <tag>, so every section below starts from exactly the chain it
# follows and a later migration never changes what an earlier section sees.
# `check_in` and `refused_in` assert against that database as its owner, which
# is what runs a migration.
# ---------------------------------------------------------------------------
migrate_until() {
  local db="$1" last="$2"
  grep -q "\"tag\": \"$last\"" drizzle/meta/_journal.json || {
    echo "migrate_until: $last is not in the journal" >&2
    exit 1
  }
  $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db OWNER grid_app_owner;"
  node -e '
    const j = require("./drizzle/meta/_journal.json");
    console.log(j.entries.map((e) => e.tag).join("\n"));
  ' | while read -r tag; do
    $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$db" -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
      echo "SETUP OF $db FAILED at $tag — re-run without -q to see the error" >&2
      exit 1
    }
    if [ "$tag" = "$last" ]; then break; fi
  done
}
# Run a migration file (or its down) against <db>, failing loudly.
apply_in() {
  $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -v ON_ERROR_STOP=1 -q -f "drizzle/$2" >/dev/null || {
    echo "MIGRATION $2 FAILED on $1 — re-run without -q to see the error" >&2
    exit 1
  }
}
sql_in() { $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -v ON_ERROR_STOP=1 -q >/dev/null; }
check_in() {
  local got
  got=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -tAc "$2")
  if [ "$got" != "$3" ]; then
    echo "MIGRATION ASSERTION FAILED on $1: $4" >&2
    echo "  query: $2" >&2
    echo "  got:   $got" >&2
    echo "  want:  $3" >&2
    exit 1
  fi
}
# Run SQL that must be REFUSED on <db>, and check the refusal names the rule ($3).
refused_in() {
  local out
  if out=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d "$1" -v ON_ERROR_STOP=1 -q 2>&1 <<<"$2"); then
    echo "MIGRATION ASSERTION FAILED on $1: $4 (the statement was accepted)" >&2
    exit 1
  fi
  if ! grep -q -- "$3" <<<"$out"; then
    echo "MIGRATION ASSERTION FAILED on $1: $4 (refused for another reason)" >&2
    echo "  output: $out" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Migration 0110: read/write grants per folder (ADR-0087), and its DOWN.
#
# What the database itself holds: a custom list may not be emptied (the
# deferred trigger), may be REPLACED in one transaction, refuses a level or a
# slug it does not know, holds at most 20 entries; a folder cannot become
# custom without a grant; a tombstone keeps its list and frees its name. The
# down removes the tombstones, the grants table and the columns, and puts
# develop's non-partial name index back; 0109 then re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0110 grants, their constraints and the down migration on grid_grants"
migrate_until grid_grants 0110_project_folder_grants
sql_in grid_grants <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000106', 'org_0106', 'Grants 0109', 'user_1', 'proj_0106');
BEGIN;
INSERT INTO project_folders (id, organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at) VALUES
  ('a1a1a1a1-a1a1-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Verträge', 'Verträge', 'custom', 'user_1', now()),
  ('b2b2b2b2-b2b2-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Personal', 'Personal', 'custom', 'user_1', now());
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('c3c3c3c3-c3c3-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Pläne', 'Pläne');
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-gf', 'write'),
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'b2b2b2b2-b2b2-4000-8000-000000000106', 'org-gf', 'write');
COMMIT;
SQL
check_in grid_grants "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_folder_grants'" "t" "the grants table is inside the tenant boundary"
check_in grid_grants "SELECT string_agg(name || '=' || access_mode, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000106'" "Personal=custom,Pläne=inherit,Verträge=custom" "a folder inherits unless it has its own list"
refused_in grid_grants "DELETE FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000106';" "it needs 1 to 20" "a custom list may not be emptied"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-pl', 'admin');" "project_folder_grants_level_check" "a level is read or write"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', '*org', 'read');" "project_folder_grants_role_check" "a slug never starts with the reserved *"
refused_in grid_grants "UPDATE project_folders SET access_mode = 'custom', access_changed_by = 'user_1', access_changed_at = now() WHERE id = 'c3c3c3c3-c3c3-4000-8000-000000000106';" "it needs 1 to 20" "a folder cannot become custom without a grant"
refused_in grid_grants "UPDATE project_folders SET access_changed_by = NULL WHERE id = 'a1a1a1a1-a1a1-4000-8000-000000000106';" "project_folders_access_custom_check" "a custom folder says who set its list"
sql_in grid_grants <<'SQL'
BEGIN;
-- Replacing a list in one transaction: delete, then insert. Deferred, so allowed.
DELETE FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000106';
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', '*', 'read'),
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-gf', 'write');
-- A new folder with its own list: read for one role, write for another.
INSERT INTO project_folders (id, organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at) VALUES
  ('d4d4d4d4-d4d4-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Honorare', 'Honorare', 'custom', 'user_1', now());
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'd4d4d4d4-d4d4-4000-8000-000000000106', 'org-pl', 'read'),
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'd4d4d4d4-d4d4-4000-8000-000000000106', 'org-gf', 'write');
-- Deleting Personal leaves its tombstone with its list; the name is free again.
UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1' WHERE id = 'b2b2b2b2-b2b2-4000-8000-000000000106';
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('e5e5e5e5-e5e5-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Personal', 'Personal');
COMMIT;
SQL
check_in grid_grants "SELECT string_agg(role_slug || ':' || level, ',' ORDER BY role_slug) FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000106'" "*:read,org-gf:write" "a list was replaced in one transaction"
check_in grid_grants "SELECT count(*) FROM project_folder_grants WHERE folder_id = 'b2b2b2b2-b2b2-4000-8000-000000000106'" "1" "a tombstone keeps its list"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) SELECT 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'd4d4d4d4-d4d4-4000-8000-000000000106', 'org-extra-' || n, 'read' FROM generate_series(1, 19) AS n;" "it needs 1 to 20" "a list holds at most 20 entries"
refused_in grid_grants "INSERT INTO project_folders (organization_id, project_id, name, path) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Personal', 'Personal');" "uniq_project_folders_parent_name" "two living folders still cannot share a name"
apply_in grid_grants 0110_project_folder_grants.down.sql
check_in grid_grants "SELECT string_agg(name, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000106'" "Honorare,Personal,Pläne,Verträge" "down removed the tombstone and kept every living folder"
check_in grid_grants "SELECT to_regclass('public.project_folder_grants') IS NULL" "t" "down dropped the grants table"
check_in grid_grants "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('access_mode', 'access_changed_by', 'access_changed_at', 'deleted_at', 'deleted_by')" "0" "down dropped the new columns"
check_in grid_grants "SELECT indexdef LIKE '%WHERE%' FROM pg_indexes WHERE indexname = 'uniq_project_folders_parent_name'" "f" "down put develop's non-partial name index back"
apply_in grid_grants 0110_project_folder_grants.sql
check_in grid_grants "SELECT string_agg(name || '=' || access_mode, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000106'" "Honorare=inherit,Personal=inherit,Pläne=inherit,Verträge=inherit" "0109 re-applies, every folder inheriting"

echo "==> 0110 grants, constraints and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0111: the per-folder chat record, and its DOWN.
#
# One row per (conversation, source folder): inside the tenant boundary, and
# `last_at` never before `first_at`. The down drops the table; 0110 re-applies.
# The admission and read paths are proved against the real chain by
# restricted-use.integration.spec.ts above.
# ---------------------------------------------------------------------------
echo "==> verifying the 0111 chat record and its down migration on grid_chat_folders"
migrate_until grid_chat_folders 0111_conversation_restricted_folders
check_in grid_chat_folders "SELECT relrowsecurity FROM pg_class WHERE relname = 'conversation_restricted_folders'" "t" "the table is inside the tenant boundary"
refused_in grid_chat_folders "INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id, first_at, last_at) VALUES ('org_0107', 's_1', gen_random_uuid(), now(), now() - interval '1 minute');" "conversation_restricted_folders_order" "last_at never comes before first_at"
sql_in grid_chat_folders <<'SQL'
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id)
VALUES ('org_0107', 's_never_created', 'a1a1a1a1-a1a1-4000-8000-000000000107');
SQL
check_in grid_chat_folders "SELECT count(*) FROM conversation_restricted_folders" "1" "a row needs no conversation row yet and no folder row (no foreign keys)"
apply_in grid_chat_folders 0111_conversation_restricted_folders.down.sql
check_in grid_chat_folders "SELECT to_regclass('public.conversation_restricted_folders') IS NULL" "t" "down dropped the table"
apply_in grid_chat_folders 0111_conversation_restricted_folders.sql
check_in grid_chat_folders "SELECT count(*) FROM conversation_restricted_folders" "0" "0110 re-applies, empty"

echo "==> 0111 chat record and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0112: restricted memory by folder, and its DOWN.
#
# An open and a restricted note with the same text can both be live (the 0111
# index); an empty folder list and a restricted organization note are refused
# (the 0111 CHECK). The down is lossy on purpose and in the safe direction:
# restricted notes are DELETED, because dropping the column alone would serve
# them to everyone. It restores develop's dedup index; 0111 then re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0112 restricted memory and its down migration on grid_memory"
migrate_until grid_memory 0112_project_memory_restricted_folders
sql_in grid_memory <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'Memory 0111', 'user_1', 'proj_0108');
INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES
  ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal', NULL),
  ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal', ARRAY['d4d4d4d4-d4d4-4000-8000-000000000108'::uuid]);
SQL
check_in grid_memory "SELECT count(*) FROM project_memory WHERE organization_id = 'org_0108' AND status = 'active'" "2" "an open and a restricted note with the same text are both live"
refused_in grid_memory "INSERT INTO project_memory (scope, project_id, organization_id, kind, content) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal');" "uniq_project_memory_project_content_active" "a second open note with the same text is still one too many"
refused_in grid_memory "INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'leer', '{}');" "project_memory_restricted_folders_check" "an empty folder list is not a restriction"
refused_in grid_memory "INSERT INTO project_memory (scope, organization_id, kind, content, restricted_folder_ids) VALUES ('organization', 'org_0108', 'decision', 'Büroweit', ARRAY['d4d4d4d4-d4d4-4000-8000-000000000108'::uuid]);" "project_memory_restricted_folders_check" "organization memory is never restricted"
apply_in grid_memory 0112_project_memory_restricted_folders.down.sql
check_in grid_memory "SELECT count(*) FROM project_memory WHERE organization_id = 'org_0108'" "1" "down deleted the restricted note and kept the open one"
check_in grid_memory "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_folder_ids'" "0" "down dropped the column"
check_in grid_memory "SELECT indexdef LIKE '%coalesce%' FROM pg_indexes WHERE indexname = 'uniq_project_memory_project_content_active'" "f" "down restored develop's dedup index"
apply_in grid_memory 0112_project_memory_restricted_folders.sql
check_in grid_memory "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_folder_ids'" "1" "0111 re-applies"

echo "==> 0112 restricted memory and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0113: the download log, and its DOWN.
#
# The table is inside the tenant boundary, the database refuses an open outside
# an own list, a shelf that disagrees with its project and any UPDATE, and the
# down drops the table and its guard function; 0112 then re-applies. The
# platform role's delete and the retention sweep are proved against the real
# chain by download-log.integration.spec.ts above.
# ---------------------------------------------------------------------------
echo "==> verifying the 0113 download log, its constraints and its down migration on grid_download_log"
migrate_until grid_download_log 0113_document_access_log
check_in grid_download_log "SELECT relrowsecurity FROM pg_class WHERE relname = 'document_access_log'" "t" "the download log is inside the tenant boundary"
check_in grid_download_log "SELECT count(*) FROM pg_indexes WHERE tablename = 'document_access_log'" "5" "the primary key and the four indexes (time, person, document, purge)"
refused_in grid_download_log "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name, own_list) VALUES ('org_0109', 'u', 'preview', 'archiv', gen_random_uuid(), 'x', false);" "document_access_log_open_needs_own_list" "an open outside an own list is refused"
refused_in grid_download_log "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0109', 'u', 'download', 'project', gen_random_uuid(), 'x');" "document_access_log_scope_project" "a project shelf needs a project"
sql_in grid_download_log <<<"INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0109', 'u', 'download', 'archiv', gen_random_uuid(), 'Plan.pdf');"
refused_in grid_download_log "UPDATE document_access_log SET user_id = 'v';" "never changed" "a row is never changed, not even by its owner"
refused_in grid_download_log "DELETE FROM document_access_log;" "deleted only by the retention sweep" "only the platform role deletes"
apply_in grid_download_log 0113_document_access_log.down.sql
check_in grid_download_log "SELECT to_regclass('public.document_access_log') IS NULL" "t" "down dropped the download log"
check_in grid_download_log "SELECT to_regprocedure('grid_document_access_log_guard()') IS NULL" "t" "down dropped the guard function"
apply_in grid_download_log 0113_document_access_log.sql
check_in grid_download_log "SELECT count(*) FROM document_access_log" "0" "0112 re-applies, empty"

echo "==> 0113 download log and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0114: the Papierkorb, and its DOWN.
#
# Seeded before 0113 runs: a tombstone the old delete left behind is
# backfilled as PURGED (its contents had been moved out), a living folder is
# not; the trigger refuses a document filed into a deleted folder and a folder
# created under one, and lets an Archiv folder (no project, no bin lock) take a
# document; an Archiv folder cannot be deleted in place, since the Archiv has no
# Papierkorb; the hold predicate covers a folder through a document in it. The
# down refuses while a folder is in the bin, runs once the bin is empty
# (columns, triggers and functions gone, the 0093 predicate back, which does not
# know folders), and 0113 re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0114 Papierkorb backfill, triggers and down migration on grid_bin"
migrate_until grid_bin 0113_document_access_log
sql_in grid_bin <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000110', 'org_0110', 'Papierkorb 0113', 'user_1', 'proj_0110');
INSERT INTO project_folders (id, organization_id, project_id, name, path, deleted_at, deleted_by) VALUES
  ('e1e1e1e1-e1e1-4000-8000-000000000110', 'org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'Ablage 0113', 'Ablage 0113', '2026-10-01T08:00:00Z', 'user_1');
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'Plaene 0113', 'Plaene 0113');
INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES
  ('e3e3e3e3-e3e3-4000-8000-000000000110', 'org_0110', 'archiv', 'Normen 0113', 'Normen 0113');
SQL
apply_in grid_bin 0114_folder_bin.sql
check_in grid_bin "SELECT (purged_at = deleted_at)::text || ',' || coalesce(bin_root_id::text, 'none') FROM project_folders WHERE id = 'e1e1e1e1-e1e1-4000-8000-000000000110'" "true,none" "an older tombstone is backfilled as purged, with no bin entry"
check_in grid_bin "SELECT count(*) FROM project_folders WHERE id IN ('e2e2e2e2-e2e2-4000-8000-000000000110', 'e3e3e3e3-e3e3-4000-8000-000000000110') AND purged_at IS NULL AND deleted_at IS NULL" "2" "a living project folder and an Archiv folder are untouched"
refused_in grid_bin "INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES ('org_0110', 'user_1', 'spaet.pdf', 'k/spaet', 'proj_0110', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000110', 'e1e1e1e1-e1e1-4000-8000-000000000110');" "is deleted; nothing may be filed into it" "a document cannot be filed into a deleted folder"
refused_in grid_bin "INSERT INTO project_folders (organization_id, project_id, parent_id, name, path) VALUES ('org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'e1e1e1e1-e1e1-4000-8000-000000000110', 'Neu', 'Ablage 0113/Neu');" "is deleted; nothing may be filed into it" "a folder cannot be created under a deleted folder"
refused_in grid_bin "UPDATE project_folders SET purged_at = now() WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';" "project_folders_bin_state_check" "a living folder cannot be purged"
refused_in grid_bin "UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1' WHERE id = 'e3e3e3e3-e3e3-4000-8000-000000000110';" "project_folders_bin_state_check" "an Archiv folder has no Papierkorb and no tombstone"
sql_in grid_bin <<<"INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, folder_id) VALUES ('org_0110', 'user_1', 'norm.pdf', 'k/norm', 'archiv_org_0110', 'completed', 'archiv', 'e3e3e3e3-e3e3-4000-8000-000000000110');"
check_in grid_bin "SELECT count(*) FROM documents WHERE folder_id = 'e3e3e3e3-e3e3-4000-8000-000000000110'" "1" "an Archiv folder takes a document: the trigger takes no bin lock for it"
sql_in grid_bin <<'SQL'
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES
  ('d1d1d1d1-d1d1-4000-8000-000000000110', 'org_0110', 'user_1', 'Plan.pdf', 'k/plan', 'proj_0110', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000110', 'e2e2e2e2-e2e2-4000-8000-000000000110');
INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by) VALUES
  ('document', 'd1d1d1d1-d1d1-4000-8000-000000000110', 'org_0110', 'rls test', 'user_1');
SQL
check_in grid_bin "SELECT grid_legal_hold_blocks('folder', 'e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110')::text" "true" "a hold on a document in a folder covers the folder"
sql_in grid_bin <<<"UPDATE legal_holds SET released_at = now() WHERE organization_id = 'org_0110';"
sql_in grid_bin <<<"UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1', bin_root_id = id WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';"
refused_in grid_bin "$(cat drizzle/0114_folder_bin.down.sql)" "the Papierkorb is not empty" "the down refuses while a folder is in the bin"
check_in grid_bin "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('bin_root_id', 'purged_at')" "2" "the refused down changed nothing"
sql_in grid_bin <<<"UPDATE project_folders SET deleted_at = NULL, deleted_by = NULL, bin_root_id = NULL WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';"
apply_in grid_bin 0114_folder_bin.down.sql
check_in grid_bin "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('bin_root_id', 'purged_at')" "0" "down dropped the bin columns"
check_in grid_bin "SELECT count(*) FROM pg_trigger WHERE tgname IN ('documents_deleted_folder_guard', 'project_folders_deleted_parent_guard')" "0" "down dropped the triggers"
check_in grid_bin "SELECT count(*) FROM project_folders WHERE id = 'e1e1e1e1-e1e1-4000-8000-000000000110' AND deleted_at IS NOT NULL" "1" "the tombstone stays a tombstone"
sql_in grid_bin <<<"INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by) VALUES ('document', 'd1d1d1d1-d1d1-4000-8000-000000000110', 'org_0110', 'rls test 2', 'user_1');"
check_in grid_bin "SELECT grid_legal_hold_blocks('folder', 'e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110')::text" "false" "the 0093 predicate is back: it does not know folders"
apply_in grid_bin 0114_folder_bin.sql
check_in grid_bin "SELECT grid_legal_hold_blocks('folder', 'e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110')::text || ',' || (SELECT (purged_at IS NOT NULL)::text FROM project_folders WHERE id = 'e1e1e1e1-e1e1-4000-8000-000000000110')" "true,true" "0113 re-applies"

echo "==> 0114 backfill, triggers and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0117: a restricted note records the memory judge's verdict
# (ADR-0086), and its DOWN. Only a restricted note carries one, and only a
# verdict the judge gives; the down drops the column and its CHECK, and 0116
# re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0117 restriction judge column, its CHECK and the down migration on grid_judge"
migrate_until grid_judge 0117_project_memory_restriction_judge
check_in grid_judge "SELECT count(*) FROM pg_constraint WHERE conname = 'project_memory_restriction_judge_check'" "1" "the verdict is checked"
check_in grid_judge "SELECT pg_get_constraintdef(oid) LIKE '%restricted_folder_ids IS NOT NULL%' FROM pg_constraint WHERE conname = 'project_memory_restriction_judge_check'" "t" "only a restricted note carries a verdict"
apply_in grid_judge 0117_project_memory_restriction_judge.down.sql
check_in grid_judge "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restriction_judge'" "0" "down dropped the column"
apply_in grid_judge 0117_project_memory_restriction_judge.sql
check_in grid_judge "SELECT count(*) FROM pg_constraint WHERE conname = 'project_memory_restriction_judge_check'" "1" "0116 re-applies"

echo "==> 0117 restriction judge and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0117: the content gate's quarantine decisions, owed to the audit
# trail (ADR-0083), and its DOWN. The repository's claims (one decision per
# dispatch, owed until marked once, outliving the document, deleted once spent
# by the platform role alone) are proved through
# the runtime role by upload-batches.integration.spec.ts above; here, what the
# database itself refuses, and that the down and a re-apply run clean.
# ---------------------------------------------------------------------------
echo "==> verifying the 0118 quarantine decisions, their guard and the down migration on grid_quarantine"
migrate_until grid_quarantine 0118_document_quarantine_decisions
check_in grid_quarantine "SELECT relrowsecurity FROM pg_class WHERE relname = 'document_quarantine_decisions'" "t" "the decisions are inside the tenant boundary"
check_in grid_quarantine "SELECT count(*) FROM pg_indexes WHERE tablename = 'document_quarantine_decisions'" "3" "the primary key, the dispatch key and the partial index of what is owed"
sql_in grid_quarantine <<<"INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('f1f1f1f1-f1f1-4000-8000-000000000117', 'org_0117', 'f2f2f2f2-f2f2-4000-8000-000000000117', 'job-1', 'archiv', 'Lohn.pdf', 'u');"
refused_in grid_quarantine "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0117', 'f2f2f2f2-f2f2-4000-8000-000000000117', 'job-1', 'archiv', 'Lohn.pdf', 'u');" "document_quarantine_decisions_dispatch_key" "one dispatch is one decision"
refused_in grid_quarantine "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0117', gen_random_uuid(), 'job-1', 'project', 'x', 'u');" "document_quarantine_decisions_scope_project" "a project shelf needs a project"
refused_in grid_quarantine "UPDATE document_quarantine_decisions SET reasons = 'iban' WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';" "only marked audited once" "a decision is never rewritten"
sql_in grid_quarantine <<<"UPDATE document_quarantine_decisions SET audited_at = now() WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';"
refused_in grid_quarantine "UPDATE document_quarantine_decisions SET audited_at = now() WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';" "only marked audited once" "a decision is marked audited once"
refused_in grid_quarantine "DELETE FROM document_quarantine_decisions;" "deleted only by the platform role" "only the platform role deletes"
apply_in grid_quarantine 0118_document_quarantine_decisions.down.sql
check_in grid_quarantine "SELECT to_regclass('public.document_quarantine_decisions') IS NULL" "t" "down dropped the decisions"
check_in grid_quarantine "SELECT to_regprocedure('grid_document_quarantine_decisions_guard()') IS NULL" "t" "down dropped the guard function"
apply_in grid_quarantine 0118_document_quarantine_decisions.sql
check_in grid_quarantine "SELECT count(*) FROM document_quarantine_decisions" "0" "0117 re-applies, empty"

echo "==> 0118 quarantine decisions and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0102: project_folders become folders of a SHELF (project | archiv),
# and its DOWN migration.
#
# A database migrated only as far as 0101 and seeded with project folders and the
# documents filed in them, then handed 0102. Asserted here rather than in a spec
# because the backfill (`organization_id` from `projects`) can only be proved on
# rows that predate the column, and the spec suites run AFTER the whole chain.
# Connects as the owner, which is what runs a migration.
# ---------------------------------------------------------------------------
echo "==> verifying the 0102 folder backfill, its constraints and its down migration on grid_folders"
$PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_folders OWNER grid_app_owner;"
MIGRATE_F="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_folders"

node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  [ "$tag" = "0102_archiv_folders" ] && break
  $MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "0102 SETUP FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done

# Two tenants, a nested project folder in each, a document filed in the nested
# one, a root document and an Archiv document (which cannot be filed yet).
$MIGRATE_F -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'org_f_a', 'A', 'user_1', 'proj_f_a'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'org_f_b', 'B', 'user_1', 'proj_f_b');
INSERT INTO project_folders (id, project_id, parent_id, name, path) VALUES
  ('f0000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', NULL, 'Plaene', 'Plaene'),
  ('f0000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'EG', 'Plaene/EG'),
  ('f0000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000002', NULL, 'Plaene', 'Plaene');
INSERT INTO documents (id, organization_id, project_id, scope, folder_id, filename, storage_key, collection_name, created_by, status) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'org_f_a', 'aaaaaaaa-0000-4000-8000-000000000001', 'project', 'f0000000-0000-4000-8000-000000000002', 'a.pdf', 'k/a', 'proj_f_a', 'user_1', 'uploaded'),
  ('d0000000-0000-4000-8000-000000000002', 'org_f_a', 'aaaaaaaa-0000-4000-8000-000000000001', 'project', NULL, 'root.pdf', 'k/root', 'proj_f_a', 'user_1', 'uploaded'),
  ('d0000000-0000-4000-8000-000000000003', 'org_f_a', NULL, 'archiv', NULL, 'arch.pdf', 'k/arch', 'archiv_org_f_a', 'user_1', 'uploaded');
SQL

$MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/0102_archiv_folders.sql" >/dev/null || {
  echo "MIGRATION 0102 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}

checkf() {
  local got
  got=$($MIGRATE_F -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0102 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}

# Writes that must be REFUSED, each by the constraint named in the message.
refusedf() {
  local out
  if out=$($MIGRATE_F -v ON_ERROR_STOP=1 -q -c "$1" 2>&1); then
    echo "0102 ASSERTION FAILED: accepted — $3" >&2
    exit 1
  fi
  if ! grep -q "$2" <<<"$out"; then
    echo "0102 ASSERTION FAILED: refused, but not by $2 — $3" >&2
    echo "  $out" >&2
    exit 1
  fi
}

checkf "SELECT string_agg(organization_id || ':' || scope, ',' ORDER BY path, organization_id) FROM project_folders" \
  "org_f_a:project,org_f_b:project,org_f_a:project" "the backfill gave every folder its project's tenant and the project scope"
checkf "SELECT folder_id FROM documents WHERE id = 'd0000000-0000-4000-8000-000000000001'" \
  "f0000000-0000-4000-8000-000000000002" "a document kept its folder across the migration"
checkf "SELECT count(*) FROM pg_constraint WHERE conname IN ('project_folders_scope_check','project_folders_scope_owner_check','project_folders_id_organization_id_scope_key','project_folders_parent_id_organization_id_scope_fkey','documents_folder_id_organization_id_scope_fkey')" \
  "5" "the new constraints exist"
checkf "SELECT qual FROM pg_policies WHERE tablename = 'project_folders' AND policyname = 'grid_tenant_isolation'" \
  "(organization_id = grid_current_org())" "the policy reads the tenant column, not a join through projects"

$MIGRATE_F -v ON_ERROR_STOP=1 -q -c "INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES ('ac000000-0000-4000-8000-000000000001', 'org_f_a', 'archiv', 'Normen', 'Normen')"
refusedf "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_f_a', 'archiv', 'Normen', 'Normen')" \
  "uniq_project_folders_parent_name" "a second root Archiv folder of the same name"
refusedf "INSERT INTO project_folders (organization_id, scope, parent_id, name, path) VALUES ('org_f_b', 'archiv', 'ac000000-0000-4000-8000-000000000001', 'x', 'x')" \
  "project_folders_parent_id_organization_id_scope_fkey" "another tenant's folder as a parent"
refusedf "INSERT INTO project_folders (organization_id, scope, parent_id, name, path) VALUES ('org_f_a', 'archiv', 'f0000000-0000-4000-8000-000000000001', 'x', 'x')" \
  "project_folders_parent_id_organization_id_scope_fkey" "a project folder as the parent of an Archiv folder"
refusedf "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_f_a', 'session', 'x', 'x')" \
  "project_folders_scope_check" "a folder on the session shelf"
refusedf "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_f_a', 'project', 'x', 'x')" \
  "project_folders_scope_owner_check" "a project folder with no project"
refusedf "UPDATE documents SET folder_id = 'f0000000-0000-4000-8000-000000000001' WHERE id = 'd0000000-0000-4000-8000-000000000003'" \
  "documents_folder_id_organization_id_scope_fkey" "an Archiv document in a project folder"
refusedf "UPDATE documents SET folder_id = 'ac000000-0000-4000-8000-000000000001' WHERE id = 'd0000000-0000-4000-8000-000000000001'" \
  "documents_folder_id_project_id_fkey" "a project document in an Archiv folder"
$MIGRATE_F -v ON_ERROR_STOP=1 -q -c "UPDATE documents SET folder_id = 'ac000000-0000-4000-8000-000000000001' WHERE id = 'd0000000-0000-4000-8000-000000000003'"

# The down migration refuses while an Archiv folder exists, and says why.
refusedf "$(cat drizzle/0102_archiv_folders.down.sql)" "Cannot reverse migration 0102" "the down migration with an Archiv folder standing"
$MIGRATE_F -v ON_ERROR_STOP=1 -q -c "UPDATE documents SET folder_id = NULL WHERE scope = 'archiv'; DELETE FROM project_folders WHERE scope = 'archiv'"
$MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/0102_archiv_folders.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0102 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkf "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('organization_id','scope')" \
  "0" "down dropped the two columns"
checkf "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name = 'project_id'" \
  "NO" "down made project_id required again"
checkf "SELECT count(*) FROM project_folders" "3" "down left every project folder in place"
checkf "SELECT folder_id FROM documents WHERE id = 'd0000000-0000-4000-8000-000000000001'" \
  "f0000000-0000-4000-8000-000000000002" "down left a project document in its folder"
checkf "SELECT count(*) FROM pg_policies WHERE tablename = 'project_folders' AND qual LIKE '%projects%'" \
  "1" "down restored the projects-join policy"
# And it can be applied again on the restored shape.
$MIGRATE_F -v ON_ERROR_STOP=1 -q -f "drizzle/0102_archiv_folders.sql" >/dev/null || {
  echo "MIGRATION 0102 FAILED when re-applied after its down migration" >&2
  exit 1
}

echo "==> 0102 backfill, constraints and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0115: project status, its CHECKs, the closed-project insert guard,
# and its DOWN migration, on the fully migrated database as the owner. The down
# refuses while a project is closed (an older build would let every write in);
# once every project is active it goes, and 0114 applies again.
# ---------------------------------------------------------------------------
echo "==> verifying the 0115 project status and its down migration on grid_app"
# Down migrations run newest first: 0116's trigger uses 0115's function.
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_steckbrief.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0116 FAILED before the 0115 check — re-run without -q to see the error" >&2
  exit 1
}
check14() {
  local got
  got=$($MIGRATE -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0114 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}
$MIGRATE -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000114', 'org_0114', 'Status 0114', 'user_1', 'proj_0114');
SQL
check14 "SELECT status FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'" "active" "a new project is active"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "UPDATE projects SET status = 'closed', closed_at = now(), closed_by = 'user_1' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'"
if $MIGRATE -q -c "INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES ('org_0114', 'user_1', 'x.pdf', 'k/0114/x', 'proj_0114', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000114')" >/dev/null 2>&1; then
  echo "0114 ASSERTION FAILED: a document was inserted into a closed project" >&2
  exit 1
fi
if $MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0115_project_status.down.sql" >/dev/null 2>&1; then
  echo "0115 ASSERTION FAILED: the down migration ran with a closed project standing" >&2
  exit 1
fi
check14 "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%closed_project_guard'" "4" "the refused down migration changed nothing"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "UPDATE projects SET status = 'active', closed_at = NULL, closed_by = NULL WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0115_project_status.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0115 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check14 "SELECT count(*) FROM information_schema.columns WHERE table_name = 'projects' AND column_name IN ('status','closed_at','closed_by')" "0" "down dropped the three columns"
check14 "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%closed_project_guard'" "0" "down dropped the four triggers"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0115_project_status.sql" >/dev/null || {
  echo "MIGRATION 0115 FAILED when re-applied after its down migration" >&2
  exit 1
}
check14 "SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%closed_project_guard'" "4" "0114 applies again"
$MIGRATE -v ON_ERROR_STOP=1 -q -c "DELETE FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000114'"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_steckbrief.sql" >/dev/null || {
  echo "MIGRATION 0116 FAILED when re-applied after the 0115 check" >&2
  exit 1
}
echo "==> 0115 project status and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0116: the Steckbrief's period and people, and its DOWN migration
# (lossy on purpose: the people go with the table), then 0115 again.
# ---------------------------------------------------------------------------
echo "==> verifying the 0116 Steckbrief down migration on grid_app"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_steckbrief.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0115 FAILED — re-run without -q to see the error" >&2
  exit 1
}
check14 "SELECT to_regclass('public.project_people') IS NULL" "t" "down dropped project_people"
check14 "SELECT count(*) FROM information_schema.columns WHERE table_name = 'projects' AND column_name IN ('started_on','ended_on')" "0" "down dropped the period"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0116_project_steckbrief.sql" >/dev/null || {
  echo "MIGRATION 0115 FAILED when re-applied after its down migration" >&2
  exit 1
}
check14 "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_people'" "t" "0115 applies again, with row-level security"
echo "==> 0116 Steckbrief and down migration verified"
