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
echo "==> running the isolation, BIM query, memory consolidation, restricted memory, profile-binding, legal-hold, chat-erasure, restricted-use, run-reconciler, usage-ledger and download-log suites as grid_app_rw"
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
    src/lib/project-profile/profile-bindings.integration.spec.ts \
    src/lib/compliance/legal-hold.integration.spec.ts \
    src/lib/conversations/erasure-queue.integration.spec.ts \
    src/lib/conversations/restricted-use.integration.spec.ts \
    src/lib/download-log/download-log.integration.spec.ts \
    src/lib/runs/reconcile.integration.spec.ts \
    src/lib/budgets/service.integration.spec.ts

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
# Migration 0106: restricted project memory, and its DOWN migration.
#
# The down is lossy on purpose and in the safe direction: restricted notes are
# DELETED, because dropping the column alone would serve them to everyone.
# Checked on the fully migrated database, as the owner: an open and a
# restricted note with the same text (which only the 0106 index allows), the
# down, then 0106 again. 0109 replaced the column 0106 adds, so 0109 goes down
# first and comes back last; its own backfill is checked on grid_restricted.
# ---------------------------------------------------------------------------
echo "==> verifying the 0106 restricted memory down migration on grid_app"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0109_project_memory_restricted_folders.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0109 FAILED on grid_app — re-run without -q to see the error" >&2
  exit 1
}
$MIGRATE -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000106', 'org_0106', 'Memory 0106', 'user_1', 'proj_0106');
INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_collections) VALUES
  ('project', 'aaaaaaaa-0000-4000-8000-000000000106', 'org_0106', 'decision', 'Honorar pauschal', NULL),
  ('project', 'aaaaaaaa-0000-4000-8000-000000000106', 'org_0106', 'decision', 'Honorar pauschal', ARRAY['proj_0106_r0123456789ab']);
SQL
checkm() {
  local got
  got=$($MIGRATE -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "0106 ASSERTION FAILED: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    exit 1
  fi
}
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0106_project_memory_restricted.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0106 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkm "SELECT count(*) FROM project_memory WHERE organization_id = 'org_0106'" "1" "down deleted the restricted note and kept the open one"
checkm "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_collections'" "0" "down dropped the column"
checkm "SELECT to_regclass('public.uniq_project_memory_project_content_active') IS NOT NULL" "t" "down restored the dedup index"
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0106_project_memory_restricted.sql" >/dev/null || {
  echo "MIGRATION 0106 FAILED on re-apply — re-run without -q to see the error" >&2
  exit 1
}
checkm "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_collections'" "1" "0106 re-applies"
$MIGRATE -q -c "DELETE FROM project_memory WHERE organization_id = 'org_0106'; DELETE FROM projects WHERE organization_id = 'org_0106';" >/dev/null
$MIGRATE -v ON_ERROR_STOP=1 -q -f "drizzle/0109_project_memory_restricted_folders.sql" >/dev/null || {
  echo "MIGRATION 0109 FAILED on re-apply over grid_app — re-run without -q to see the error" >&2
  exit 1
}
checkm "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_folder_ids'" "1" "0109 re-applies on top"

echo "==> 0106 down migration verified"

# ---------------------------------------------------------------------------
# Migration 0107: the restricted-turn marks (0105) become per-folder rows,
# and its DOWN migration.
#
# A database migrated only as far as 0106, seeded in the 0105 shape, then
# handed 0107 and checked: a mark becomes a row for every folder of the
# conversation's project that was restricted then, a stored answer that read a
# restricted collection adds that collection's FOLDER (and nothing of another
# project), a mark with no conversation row is dropped, and the 0105 table is
# gone. The down gives every conversation with a row its mark back; 0107 then
# re-applies. 0108 and 0109 are checked on the same database afterwards.
# ---------------------------------------------------------------------------
echo "==> verifying the 0107 restricted-use backfill and its down migration on grid_restricted"
$PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_restricted OWNER grid_app_owner;"
MIGRATE_R="$PGBIN/psql -h $WORKDIR -p $PORT -U grid_app_owner -d grid_restricted"
node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
' | while read -r tag; do
  [ "$tag" = "0107_conversation_restricted_folders" ] && break
  $MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/$tag.sql" >/dev/null || {
    echo "0107 SETUP FAILED at $tag — re-run without -q to see the error" >&2
    exit 1
  }
done
$MIGRATE_R -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000107', 'org_0107', 'Restricted 0107', 'user_1', 'proj_0107');
INSERT INTO project_folders (id, project_id, name, path, restricted_roles, restricted_by, restricted_at) VALUES
  ('a1a1a1a1-a1a1-4000-8000-000000000107', 'aaaaaaaa-0000-4000-8000-000000000107', 'Verträge', 'Verträge', ARRAY['org-gf'], 'user_1', now()),
  ('b2b2b2b2-b2b2-4000-8000-000000000107', 'aaaaaaaa-0000-4000-8000-000000000107', 'Personal', 'Personal', ARRAY['org-gf'], 'user_1', now()),
  ('c3c3c3c3-c3c3-4000-8000-000000000107', 'aaaaaaaa-0000-4000-8000-000000000107', 'Pläne', 'Pläne', NULL, NULL, NULL);
INSERT INTO conversations (id, organization_id, created_by, project_id) VALUES
  ('s_marked', 'org_0107', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000107'),
  ('s_answered', 'org_0107', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000107'),
  ('s_open', 'org_0107', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000107');
INSERT INTO conversation_restricted_turns (organization_id, conversation_id) VALUES
  ('org_0107', 's_marked'),
  ('org_0107', 's_never_created');
INSERT INTO messages (conversation_id, organization_id, role, content, metadata) VALUES
  ('s_answered', 'org_0107', 'assistant', 'x',
   '{"readSources": {"sources": [{"collection": "proj_0107_ra1a1a1a1a1a1"}, {"collection": "proj_other_r0123456789ab"}]}}'::jsonb),
  ('s_open', 'org_0107', 'assistant', 'x', '{"citations": {"sources": [{"collection": "proj_0107"}]}}'::jsonb);
SQL
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0107_conversation_restricted_folders.sql" >/dev/null || {
  echo "MIGRATION 0107 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}
checkr() {
  local got
  got=$($MIGRATE_R -tAc "$1")
  if [ "$got" != "$2" ]; then
    echo "MIGRATION ASSERTION FAILED on grid_restricted: $3" >&2
    echo "  query: $1" >&2
    echo "  got:   $got" >&2
    echo "  want:  $2" >&2
    exit 1
  fi
}
# Run SQL that must be REFUSED, and check the refusal names the rule ($2).
refusedr() {
  local out
  if out=$($MIGRATE_R -v ON_ERROR_STOP=1 -q 2>&1 <<<"$1"); then
    echo "MIGRATION ASSERTION FAILED on grid_restricted: $3 (the statement was accepted)" >&2
    exit 1
  fi
  if ! grep -q -- "$2" <<<"$out"; then
    echo "MIGRATION ASSERTION FAILED on grid_restricted: $3 (refused for another reason)" >&2
    echo "  output: $out" >&2
    exit 1
  fi
}
checkr "SELECT string_agg(folder_id::text, ',' ORDER BY folder_id) FROM conversation_restricted_folders WHERE conversation_id = 's_marked'" "a1a1a1a1-a1a1-4000-8000-000000000107,b2b2b2b2-b2b2-4000-8000-000000000107" "a mark became every restricted folder of its project"
checkr "SELECT string_agg(folder_id::text, ',' ORDER BY folder_id) FROM conversation_restricted_folders WHERE conversation_id = 's_answered'" "a1a1a1a1-a1a1-4000-8000-000000000107" "a stored answer added the folder of the restricted collection it read, and no other project's"
checkr "SELECT count(*) FROM conversation_restricted_folders WHERE conversation_id IN ('s_open', 's_never_created')" "0" "an open answer and a mark without a conversation recorded nothing"
checkr "SELECT to_regclass('public.conversation_restricted_turns') IS NULL" "t" "0107 dropped the 0105 table"
checkr "SELECT relrowsecurity FROM pg_class WHERE relname = 'conversation_restricted_folders'" "t" "the new table is inside the tenant boundary"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0107_conversation_restricted_folders.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0107 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(conversation_id, ',' ORDER BY conversation_id) FROM conversation_restricted_turns" "s_answered,s_marked" "down gave every conversation with a row its mark back"
checkr "SELECT to_regclass('public.conversation_restricted_folders') IS NULL" "t" "down dropped the new table"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0107_conversation_restricted_folders.sql" >/dev/null || {
  echo "MIGRATION 0107 FAILED on re-apply — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT count(*) FROM conversation_restricted_folders WHERE organization_id = 'org_0107'" "4" "0107 re-applies, from the marks and the answers"

echo "==> 0107 backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0108: read/write grants per folder (ADR-0079), and its DOWN.
#
# On grid_restricted, still holding the 0104 shape: each restricted role
# becomes a WRITE grant and the folder `custom`; an open folder inherits. Then
# what the database itself holds: a custom list may not be emptied (the
# deferred trigger), may be REPLACED in one transaction, refuses a level or a
# slug it does not know; a tombstone frees its name. The down maps every grant
# back to a role (read-vs-write is lost) and a `*` list to open, and drops the
# tombstones; 0108 then re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0108 grant backfill, its constraints and its down migration on grid_restricted"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0108_project_folder_grants.sql" >/dev/null || {
  echo "MIGRATION 0108 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(name || '=' || access_mode, ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000107'" "Personal=custom,Pläne=inherit,Verträge=custom" "a restricted folder became custom, an open one inherits"
checkr "SELECT string_agg(f.name || ':' || g.role_slug || ':' || g.level, ',' ORDER BY f.name) FROM project_folder_grants g JOIN project_folders f ON f.id = g.folder_id" "Personal:org-gf:write,Verträge:org-gf:write" "each restricted role became a write grant"
checkr "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name = 'restricted_roles'" "0" "0108 dropped restricted_roles"
checkr "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_folder_grants'" "t" "the grants table is inside the tenant boundary"
refusedr "DELETE FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000107';" "it needs 1 to 20" "a custom list may not be emptied"
refusedr "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'a1a1a1a1-a1a1-4000-8000-000000000107', 'org-pl', 'admin');" "project_folder_grants_level_check" "a level is read or write"
refusedr "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'a1a1a1a1-a1a1-4000-8000-000000000107', '*org', 'read');" "project_folder_grants_role_check" "a slug never starts with the reserved *"
refusedr "UPDATE project_folders SET access_mode = 'custom', access_changed_by = 'user_1', access_changed_at = now() WHERE id = 'c3c3c3c3-c3c3-4000-8000-000000000107';" "it needs 1 to 20" "a folder cannot become custom without a grant"
$MIGRATE_R -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
-- Replacing a list in one transaction: delete, then insert. Deferred, so allowed.
DELETE FROM project_folder_grants WHERE folder_id = 'a1a1a1a1-a1a1-4000-8000-000000000107';
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'a1a1a1a1-a1a1-4000-8000-000000000107', '*', 'read'),
  ('org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'a1a1a1a1-a1a1-4000-8000-000000000107', 'org-gf', 'write');
-- A new folder with its own list: read for one role, write for another.
INSERT INTO project_folders (id, project_id, name, path, access_mode, access_changed_by, access_changed_at) VALUES
  ('d4d4d4d4-d4d4-4000-8000-000000000107', 'aaaaaaaa-0000-4000-8000-000000000107', 'Honorare', 'Honorare', 'custom', 'user_1', now());
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'd4d4d4d4-d4d4-4000-8000-000000000107', 'org-pl', 'read'),
  ('org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'd4d4d4d4-d4d4-4000-8000-000000000107', 'org-gf', 'write');
-- Deleting Personal leaves its tombstone with its list; the name is free again.
UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1' WHERE id = 'b2b2b2b2-b2b2-4000-8000-000000000107';
INSERT INTO project_folders (id, project_id, name, path) VALUES
  ('e5e5e5e5-e5e5-4000-8000-000000000107', 'aaaaaaaa-0000-4000-8000-000000000107', 'Personal', 'Personal');
COMMIT;
SQL
checkr "SELECT count(*) FROM project_folder_grants WHERE folder_id = 'b2b2b2b2-b2b2-4000-8000-000000000107'" "1" "a tombstone keeps its list"
refusedr "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) SELECT 'org_0107', 'aaaaaaaa-0000-4000-8000-000000000107', 'd4d4d4d4-d4d4-4000-8000-000000000107', 'org-extra-' || n, 'read' FROM generate_series(1, 19) AS n;" "it needs 1 to 20" "a list holds at most 20 entries"
refusedr "INSERT INTO project_folders (project_id, name, path) VALUES ('aaaaaaaa-0000-4000-8000-000000000107', 'Personal', 'Personal');" "uniq_project_folders_parent_name" "two living folders still cannot share a name"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0108_project_folder_grants.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0108 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(name || '=' || coalesce(array_to_string(restricted_roles, '|'), 'open'), ',' ORDER BY name) FROM project_folders WHERE project_id = 'aaaaaaaa-0000-4000-8000-000000000107'" "Honorare=org-gf|org-pl,Personal=open,Pläne=open,Verträge=open" "down: every role at either level restricts, a * list is open, the tombstone is gone"
checkr "SELECT count(*) FROM project_folders WHERE id = 'b2b2b2b2-b2b2-4000-8000-000000000107'" "0" "down removed the tombstone"
checkr "SELECT to_regclass('public.project_folder_grants') IS NULL" "t" "down dropped the grants table"
checkr "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name IN ('access_mode', 'deleted_at', 'deleted_by')" "0" "down dropped the new columns"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0108_project_folder_grants.sql" >/dev/null || {
  echo "MIGRATION 0108 FAILED on re-apply — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(f.name || ':' || g.role_slug || ':' || g.level, ',' ORDER BY f.name, g.role_slug) FROM project_folder_grants g JOIN project_folders f ON f.id = g.folder_id" "Honorare:org-gf:write,Honorare:org-pl:write" "0108 re-applies (the read grant came back as write: the documented loss)"

echo "==> 0108 backfill, constraints and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0109: restricted memory names its source folders, and its DOWN.
#
# Notes in the 0106 shape: one naming Honorare's collection becomes Honorare's
# id; one naming a collection no folder answers to becomes the nil UUID (shown
# to nobody, as before); a second such note with the same text collides with
# the first under the new index and is superseded; an open note stays open.
# The down maps ids back to collection names, and 0109 re-applies.
# ---------------------------------------------------------------------------
echo "==> verifying the 0109 restricted memory backfill and its down migration on grid_restricted"
$MIGRATE_R -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO project_memory (id, scope, project_id, organization_id, kind, content, restricted_collections, created_at) VALUES
  ('f0000000-0000-4000-8000-0000000001a1', 'project', 'aaaaaaaa-0000-4000-8000-000000000107', 'org_0107', 'decision', 'Honorar pauschal', ARRAY['proj_0107_rd4d4d4d4d4d4'], now() - interval '3 minutes'),
  ('f0000000-0000-4000-8000-0000000001b2', 'project', 'aaaaaaaa-0000-4000-8000-000000000107', 'org_0107', 'decision', 'Gehälter vertraulich', ARRAY['proj_0107_rffffffffffff'], now() - interval '2 minutes'),
  ('f0000000-0000-4000-8000-0000000001c3', 'project', 'aaaaaaaa-0000-4000-8000-000000000107', 'org_0107', 'decision', 'Gehälter vertraulich', ARRAY['proj_0107_reeeeeeeeeeee'], now() - interval '1 minute'),
  ('f0000000-0000-4000-8000-0000000001d4', 'project', 'aaaaaaaa-0000-4000-8000-000000000107', 'org_0107', 'decision', 'Plan im Maßstab 1:100', NULL, now());
SQL
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0109_project_memory_restricted_folders.sql" >/dev/null || {
  echo "MIGRATION 0109 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(right(id::text, 2) || '=' || coalesce(array_to_string(restricted_folder_ids, '|'), 'open') || ':' || status, ',' ORDER BY id) FROM project_memory WHERE organization_id = 'org_0107'" "a1=d4d4d4d4-d4d4-4000-8000-000000000107:active,b2=00000000-0000-0000-0000-000000000000:active,c3=00000000-0000-0000-0000-000000000000:superseded,d4=open:active" "a collection became its folder, an unknown one the nil UUID, the later twin superseded"
checkr "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_collections'" "0" "0109 dropped restricted_collections"
refusedr "INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000107', 'org_0107', 'decision', 'leer', '{}');" "project_memory_restricted_folders_check" "an empty folder list is not a restriction"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0109_project_memory_restricted_folders.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0109 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(right(id::text, 2) || '=' || coalesce(array_to_string(restricted_collections, '|'), 'open'), ',' ORDER BY id) FROM project_memory WHERE organization_id = 'org_0107' AND status = 'active'" "a1=proj_0107_rd4d4d4d4d4d4,b2=proj_0107_r000000000000,d4=open" "down named each folder's collection again"
checkr "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_memory' AND column_name = 'restricted_folder_ids'" "0" "down dropped restricted_folder_ids"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0109_project_memory_restricted_folders.sql" >/dev/null || {
  echo "MIGRATION 0109 FAILED on re-apply — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT string_agg(right(id::text, 2) || '=' || coalesce(array_to_string(restricted_folder_ids, '|'), 'open'), ',' ORDER BY id) FROM project_memory WHERE organization_id = 'org_0107' AND status = 'active'" "a1=d4d4d4d4-d4d4-4000-8000-000000000107,b2=00000000-0000-0000-0000-000000000000,d4=open" "0109 re-applies"

echo "==> 0109 backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0110: the download log, and its DOWN.
#
# On grid_restricted, after 0109: the table is inside the tenant boundary, the
# database refuses an open outside an own list, a shelf that disagrees with its
# project and any UPDATE, and the down drops the table and its guard function;
# 0110 then re-applies. The platform role's delete and the retention sweep are
# proved against the real chain by download-log.integration.spec.ts above.
# ---------------------------------------------------------------------------
echo "==> verifying the 0110 download log, its constraints and its down migration on grid_restricted"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0110_document_access_log.sql" >/dev/null || {
  echo "MIGRATION 0110 FAILED on the seeded database — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT relrowsecurity FROM pg_class WHERE relname = 'document_access_log'" "t" "the download log is inside the tenant boundary"
checkr "SELECT count(*) FROM pg_indexes WHERE tablename = 'document_access_log'" "5" "the primary key and the four indexes (time, person, document, purge)"
refusedr "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name, own_list) VALUES ('org_0110', 'u', 'preview', 'archiv', gen_random_uuid(), 'x', false);" "document_access_log_open_needs_own_list" "an open outside an own list is refused"
refusedr "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0110', 'u', 'download', 'project', gen_random_uuid(), 'x');" "document_access_log_scope_project" "a project shelf needs a project"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -c "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0110', 'u', 'download', 'archiv', gen_random_uuid(), 'Plan.pdf');" >/dev/null
refusedr "UPDATE document_access_log SET user_id = 'v';" "never changed" "a row is never changed, not even by its owner"
refusedr "DELETE FROM document_access_log;" "deleted only by the retention sweep" "only the platform role deletes"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0110_document_access_log.down.sql" >/dev/null || {
  echo "DOWN MIGRATION 0110 FAILED — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT to_regclass('public.document_access_log') IS NULL" "t" "down dropped the download log"
checkr "SELECT to_regprocedure('grid_document_access_log_guard()') IS NULL" "t" "down dropped the guard function"
$MIGRATE_R -v ON_ERROR_STOP=1 -q -f "drizzle/0110_document_access_log.sql" >/dev/null || {
  echo "MIGRATION 0110 FAILED on re-apply — re-run without -q to see the error" >&2
  exit 1
}
checkr "SELECT count(*) FROM document_access_log" "0" "0110 re-applies, empty"

echo "==> 0110 download log and down migration verified"
