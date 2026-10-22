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
# A port nobody holds, unless the caller names one. Parallel runs in one
# container (two agents, two worktrees) each get their own: a fixed default made
# the second die at `pg_ctl: could not start server` before any migration ran.
# TCP on 127.0.0.1 rather than the unix socket alone, because the vitest suites
# below connect to 127.0.0.1:$PORT. The OS picks an ephemeral port and the
# probe releases it; the window before `pg_ctl` binds it again is milliseconds.
PORT="${RLS_TEST_PORT:-$(node -e '
  const server = require("net").createServer();
  server.listen(0, "127.0.0.1", () => { console.log(server.address().port); server.close(); });
')}"
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

# `--exec <command…>`: the same throwaway cluster, without the migration chain or
# the suites below, for the Python suites whose Postgres branch would otherwise
# skip (`task be:test:postgres`). They create and drop their own tables, so they
# get an empty scratch database as the superuser, in AIQ_TEST_POSTGRES_URL.
if [ "${1:-}" = "--exec" ]; then
  shift
  $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE aiq_queues;"
  echo "==> running: $*"
  AIQ_TEST_POSTGRES_URL="postgresql://postgres@127.0.0.1:$PORT/aiq_queues" "$@"
  exit 0
fi

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
# The inbound mail and mail thread suites (ADR-0134) are named here before
# their files exist, one per package that writes one: the repository (D7, D8),
# the sweeps (D12), the review-first ratchet (D9), append (D9), follow (D10)
# and the archive (D11). A name vitest finds no file for filters nothing, and
# `integration-suite-coverage.spec.ts` fails a spec that lands under any other
# name, so a suite cannot arrive here unrun.
echo "==> running the isolation, BIM query, memory consolidation, profile-binding, legal-hold, chat-erasure, restricted-use, cross-project use, similar passages, project intake, run-reconciler, usage-ledger, answer-feedback, restricted memory, download-log, Papierkorb, closed-project, Steckbrief, Ausmisten, upload batches, quarantine decisions, Piloti's proposed operations and solo reads, restricted-feedback, revision-subject, the hold on a document, permit-record, push subscription, inbox paging, Anmerkungen, Offene Punkte, folder cards, mail-import paging and inbound mail and mail thread suites as grid_app_rw"
GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$RUNTIME_PASSWORD@127.0.0.1:$PORT/grid_app" \
  npx vitest run \
    src/lib/db/tenant-isolation.integration.spec.ts \
    src/lib/bim/query.integration.spec.ts \
    src/lib/bim/model-shelf.integration.spec.ts \
    src/lib/projects/memory-service.integration.spec.ts \
    src/lib/projects/memory-restricted.integration.spec.ts \
    src/lib/documents/document-versions.integration.spec.ts \
    src/lib/documents/list-page.integration.spec.ts \
    src/lib/documents/quarantine-listing.integration.spec.ts \
    src/lib/documents/visibility.integration.spec.ts \
    src/lib/upload-batches/upload-batches.integration.spec.ts \
    src/lib/authz/folder-access.integration.spec.ts \
    src/lib/projects/collection-placement.integration.spec.ts \
    src/lib/projects/folder-visibility.integration.spec.ts \
    src/lib/documents/shelf-folders.integration.spec.ts \
    src/lib/projects/folder-bin.integration.spec.ts \
    src/lib/documents/stuck-processing.integration.spec.ts \
    src/lib/documents/retry-policy.integration.spec.ts \
    src/lib/project-profile/profile-bindings.integration.spec.ts \
    src/lib/compliance/legal-hold.integration.spec.ts \
    src/lib/conversations/erasure-queue.integration.spec.ts \
    src/lib/conversations/restricted-use.integration.spec.ts \
    src/lib/feedback/restricted-feedback.integration.spec.ts \
    src/lib/tasks/subject-access.integration.spec.ts \
    src/lib/tasks/active-runs.integration.spec.ts \
    src/lib/conversations/cross-project-use.integration.spec.ts \
    src/lib/cross-project/decisions-repository.integration.spec.ts \
    src/lib/similar-passages/service.integration.spec.ts \
    src/lib/permits/repository.integration.spec.ts \
    src/lib/annotations/repository.integration.spec.ts \
    src/lib/annotations/project-repository.integration.spec.ts \
    src/lib/proposals/repository.integration.spec.ts \
    src/lib/agent-api/operation-proposals.integration.spec.ts \
    src/lib/agent-api/read-gate.integration.spec.ts \
    src/lib/project-intake/repository.integration.spec.ts \
    src/lib/changes/repository.integration.spec.ts \
    src/lib/push/repository.integration.spec.ts \
    src/lib/piloti-asks/repository.integration.spec.ts \
    src/lib/inbox/repository.integration.spec.ts \
    src/lib/project-experience/readable-files.integration.spec.ts \
    src/lib/projects/memory-evidence.integration.spec.ts \
    src/lib/download-log/download-log.integration.spec.ts \
    src/lib/runs/reconcile.integration.spec.ts \
    src/lib/budgets/service.integration.spec.ts \
    src/lib/analytics/usage-export-repository.integration.spec.ts \
    src/lib/feedback/repository.integration.spec.ts \
    src/lib/citations/repository.integration.spec.ts \
    src/lib/profiler/repository.integration.spec.ts \
    src/lib/projects/project-status.integration.spec.ts \
    src/lib/projects/project-record.integration.spec.ts \
    src/lib/projects/cleanup.integration.spec.ts \
    src/lib/feedback/repository.integration.spec.ts \
    src/lib/filing/root-sort-run-repository.integration.spec.ts \
    src/lib/folder-cards/repository.integration.spec.ts \
    src/lib/mail-import/repository.integration.spec.ts \
    src/lib/inbound-mail/repository.integration.spec.ts \
    src/lib/inbound-mail/sweep.integration.spec.ts \
    src/lib/inbound-mail/review-first.e2e.spec.ts \
    src/lib/mail-thread/append.integration.spec.ts \
    src/lib/mail-thread/follow.integration.spec.ts \
    src/lib/mail-thread/archive.integration.spec.ts

# The tenant suites above may leave queued jobs behind: Ausmisten bins a
# subfolder, and a Papierkorb delete queues its purge takeover and a refused
# one its restore. The job-queue suites claim from the whole table and expect
# only their own seeds, so they start from an empty one.
$MIGRATE -v ON_ERROR_STOP=1 -q -c "DELETE FROM bff_job_queue" >/dev/null

# The job-queue suites claim from ONE table, whichever lane a job is in, so run
# in parallel they claim each other's seeded jobs. One file at a time. The
# scheduler's due-scan is the same shape over task_definitions, every tenant's.
echo "==> running the job-queue and scheduler-claim suites one file at a time as grid_app_rw"
GRID_TEST_DATABASE_URL="postgres://grid_app_rw:$RUNTIME_PASSWORD@127.0.0.1:$PORT/grid_app" \
  npx vitest run --no-file-parallelism \
    src/lib/jobs-queue/queue.integration.spec.ts \
    src/lib/jobs-queue/repository.integration.spec.ts \
    workers/jobs/runner.integration.spec.mjs \
    scheduler/db.integration.spec.mjs

# Everything below re-proves one migration of the chain at a time: a database
# migrated to just before it, seeded with the old shapes, checked row by row,
# then taken down. Those claims read nothing but frontends/ui/drizzle/ and this
# script, and they are ~60% of this script's time. CI's Plan sets
# GRID_RLS_MIGRATION_CHECKS=0 when neither changed (the `migrations` tier in
# .github/filters.yml); unset, as locally, they run.
if [ "${GRID_RLS_MIGRATION_CHECKS:-1}" = "0" ]; then
  echo "==> per-migration backfill and down checks skipped: no migration and not this script changed"
  exit 0
fi

# ---------------------------------------------------------------------------
# The migration sections below each check one migration on a database of its
# own, migrated to exactly the point that migration follows.
#
# Replaying the journal into every one of them cost each section the whole
# chain again: about 90 of the run's 150 seconds, and growing with every
# migration twice over, once for the longer chain and once for its own section.
# Instead the chain is applied ONCE, into `grid_chain`, a template that only
# moves forward, and each section clones it (`CREATE DATABASE ... TEMPLATE`),
# which copies the files rather than re-running the SQL. A clone is the same
# database the replay produced: the migrations set nothing at database level,
# the one thing a template does not carry. A section that asks for an earlier
# point than the template holds gets a template rebuilt from scratch.
#
# `migrate_until <db> <tag>` gives <db> the journal up to and including <tag>,
# `migrate_before <db> <tag>` up to the migration before it.
# ---------------------------------------------------------------------------
JOURNAL=()
while read -r tag; do JOURNAL+=("$tag"); done < <(node -e '
  const j = require("./drizzle/meta/_journal.json");
  console.log(j.entries.map((e) => e.tag).join("\n"));
')
CHAIN_AT=-1  # index in JOURNAL of the last migration grid_chain holds; -1 = no grid_chain

journal_index() {
  local i
  for i in "${!JOURNAL[@]}"; do
    if [ "${JOURNAL[$i]}" = "$1" ]; then echo "$i"; return; fi
  done
  echo "$1 is not in the journal" >&2
  exit 1
}
# Clone grid_chain, advanced to JOURNAL[<index>], as <db>.
clone_chain_at() {
  local db="$1" target="$2" i
  if [ "$target" -lt "$CHAIN_AT" ]; then
    $PSQL -q -v ON_ERROR_STOP=1 -c "DROP DATABASE grid_chain;"
    CHAIN_AT=-1
  fi
  if [ "$CHAIN_AT" -lt 0 ]; then
    $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE grid_chain OWNER grid_app_owner;"
  fi
  for ((i = CHAIN_AT + 1; i <= target; i++)); do
    $PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_chain -v ON_ERROR_STOP=1 -q \
      -f "drizzle/${JOURNAL[$i]}.sql" >/dev/null || {
      echo "SETUP OF $db FAILED at ${JOURNAL[$i]} — re-run without -q to see the error" >&2
      exit 1
    }
    CHAIN_AT=$i
  done
  $PSQL -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db TEMPLATE grid_chain OWNER grid_app_owner;"
}
migrate_until() {
  local at
  at=$(journal_index "$2")
  clone_chain_at "$1" "$at"
}
migrate_before() {
  local at
  at=$(journal_index "$2")
  clone_chain_at "$1" "$((at - 1))"
}

# ---------------------------------------------------------------------------
# Migrations up to 0132 have run in production for more than a week, so their
# backfills and down migrations are history: their sections are gone, and the
# git log keeps them. What stays below 0133 is what those migrations put into
# the database that it still refuses today and that no suite above covers: a
# CHECK, a unique index or a guard trigger, each on a clone of the chain taken
# at the migration that created it.
#
# `check_in` and `refused_in` assert against that database as its owner, which
# is what runs a migration.
# ---------------------------------------------------------------------------
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
# Migration 0111: a folder's own list (ADR-0088). The list's people moved to
# WorkOS in 0128; the CHECKs on a grant and on a custom folder stayed.
# ---------------------------------------------------------------------------
echo "==> verifying the 0111 grant and folder constraints on grid_grants"
migrate_until grid_grants 0111_project_folder_grants
sql_in grid_grants <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000106', 'org_0106', 'Grants 0110', 'user_1', 'proj_0106');
BEGIN;
INSERT INTO project_folders (id, organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at) VALUES
  ('a1a1a1a1-a1a1-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Verträge', 'Verträge', 'custom', 'user_1', now());
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('c3c3c3c3-c3c3-4000-8000-000000000106', 'org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Pläne', 'Pläne');
INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES
  ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-gf', 'write');
COMMIT;
SQL
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', 'org-pl', 'admin');" "project_folder_grants_level_check" "a level is read or write"
refused_in grid_grants "INSERT INTO project_folder_grants (organization_id, project_id, folder_id, role_slug, level) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'a1a1a1a1-a1a1-4000-8000-000000000106', '*org', 'read');" "project_folder_grants_role_check" "a slug never starts with the reserved *"
refused_in grid_grants "UPDATE project_folders SET access_changed_by = NULL WHERE id = 'a1a1a1a1-a1a1-4000-8000-000000000106';" "project_folders_access_custom_check" "a custom folder says who set its list"
refused_in grid_grants "INSERT INTO project_folders (organization_id, project_id, name, path) VALUES ('org_0106', 'aaaaaaaa-0000-4000-8000-000000000106', 'Pläne', 'Pläne');" "uniq_project_folders_parent_name" "two living folders cannot share a name"
echo "==> 0111 grant and folder constraints verified"

# ---------------------------------------------------------------------------
# Migration 0112: the per-folder chat record. `last_at` never before
# `first_at`, and no foreign keys: a row may precede its conversation. The
# admission and read paths are proved against the real chain by
# restricted-use.integration.spec.ts above.
# ---------------------------------------------------------------------------
echo "==> verifying the 0112 chat record on grid_chat_folders"
migrate_until grid_chat_folders 0112_conversation_restricted_folders
refused_in grid_chat_folders "INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id, first_at, last_at) VALUES ('org_0107', 's_1', gen_random_uuid(), now(), now() - interval '1 minute');" "conversation_restricted_folders_order" "last_at never comes before first_at"
sql_in grid_chat_folders <<'SQL'
INSERT INTO conversation_restricted_folders (organization_id, conversation_id, folder_id)
VALUES ('org_0107', 's_never_created', 'a1a1a1a1-a1a1-4000-8000-000000000107');
SQL
check_in grid_chat_folders "SELECT count(*) FROM conversation_restricted_folders" "1" "a row needs no conversation row yet and no folder row (no foreign keys)"
echo "==> 0112 chat record verified"

# ---------------------------------------------------------------------------
# Migration 0113: restricted memory by folder. An open and a restricted note
# with the same text can both be live (the dedup index); an empty folder list
# and a restricted organization note are refused (the CHECK).
# ---------------------------------------------------------------------------
echo "==> verifying the 0113 restricted memory on grid_memory"
migrate_until grid_memory 0113_project_memory_restricted_folders
sql_in grid_memory <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'Memory 0112', 'user_1', 'proj_0108');
INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES
  ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal', NULL),
  ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal', ARRAY['d4d4d4d4-d4d4-4000-8000-000000000108'::uuid]);
SQL
check_in grid_memory "SELECT count(*) FROM project_memory WHERE organization_id = 'org_0108' AND status = 'active'" "2" "an open and a restricted note with the same text are both live"
refused_in grid_memory "INSERT INTO project_memory (scope, project_id, organization_id, kind, content) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'Honorar pauschal');" "uniq_project_memory_project_content_active" "a second open note with the same text is still one too many"
refused_in grid_memory "INSERT INTO project_memory (scope, project_id, organization_id, kind, content, restricted_folder_ids) VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000108', 'org_0108', 'decision', 'leer', '{}');" "project_memory_restricted_folders_check" "an empty folder list is not a restriction"
refused_in grid_memory "INSERT INTO project_memory (scope, organization_id, kind, content, restricted_folder_ids) VALUES ('organization', 'org_0108', 'decision', 'Büroweit', ARRAY['d4d4d4d4-d4d4-4000-8000-000000000108'::uuid]);" "project_memory_restricted_folders_check" "organization memory is never restricted"
echo "==> 0113 restricted memory verified"

# ---------------------------------------------------------------------------
# Migration 0115: the Papierkorb's triggers and CHECK. Nothing is filed into a
# deleted folder, a document or a subfolder; an Archiv folder (no project, no
# bin lock) takes a document; a living folder cannot be purged and an Archiv
# folder cannot be deleted in place, since the Archiv has no Papierkorb. The
# folder is deleted before 0115 runs, the only way to seed one with no bin entry.
# ---------------------------------------------------------------------------
echo "==> verifying the 0115 Papierkorb triggers and CHECK on grid_bin"
migrate_until grid_bin 0114_document_access_log
sql_in grid_bin <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000110', 'org_0110', 'Papierkorb 0114', 'user_1', 'proj_0110');
INSERT INTO project_folders (id, organization_id, project_id, name, path, deleted_at, deleted_by) VALUES
  ('e1e1e1e1-e1e1-4000-8000-000000000110', 'org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'Ablage 0114', 'Ablage 0114', '2026-10-01T08:00:00Z', 'user_1');
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('e2e2e2e2-e2e2-4000-8000-000000000110', 'org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'Plaene 0114', 'Plaene 0114');
INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES
  ('e3e3e3e3-e3e3-4000-8000-000000000110', 'org_0110', 'archiv', 'Normen 0114', 'Normen 0114');
SQL
apply_in grid_bin 0115_folder_bin.sql
refused_in grid_bin "INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES ('org_0110', 'user_1', 'spaet.pdf', 'k/spaet', 'proj_0110', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000110', 'e1e1e1e1-e1e1-4000-8000-000000000110');" "is deleted; nothing may be filed into it" "a document cannot be filed into a deleted folder"
refused_in grid_bin "INSERT INTO project_folders (organization_id, project_id, parent_id, name, path) VALUES ('org_0110', 'aaaaaaaa-0000-4000-8000-000000000110', 'e1e1e1e1-e1e1-4000-8000-000000000110', 'Neu', 'Ablage 0114/Neu');" "is deleted; nothing may be filed into it" "a folder cannot be created under a deleted folder"
refused_in grid_bin "UPDATE project_folders SET purged_at = now() WHERE id = 'e2e2e2e2-e2e2-4000-8000-000000000110';" "project_folders_bin_state_check" "a living folder cannot be purged"
refused_in grid_bin "UPDATE project_folders SET deleted_at = now(), deleted_by = 'user_1' WHERE id = 'e3e3e3e3-e3e3-4000-8000-000000000110';" "project_folders_bin_state_check" "an Archiv folder has no Papierkorb and no tombstone"
sql_in grid_bin <<<"INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, folder_id) VALUES ('org_0110', 'user_1', 'norm.pdf', 'k/norm', 'archiv_org_0110', 'completed', 'archiv', 'e3e3e3e3-e3e3-4000-8000-000000000110');"
check_in grid_bin "SELECT count(*) FROM documents WHERE folder_id = 'e3e3e3e3-e3e3-4000-8000-000000000110'" "1" "an Archiv folder takes a document: the trigger takes no bin lock for it"
echo "==> 0115 Papierkorb triggers and CHECK verified"

# ---------------------------------------------------------------------------
# Migration 0119: the content gate's quarantine decisions, owed to the audit
# trail (ADR-0086). The repository's claims (one decision per dispatch, owed
# until marked once, outliving the document, deleted once spent by the platform
# role alone) are proved through the runtime role by
# upload-batches.integration.spec.ts above; here, what the database itself
# refuses.
# ---------------------------------------------------------------------------
echo "==> verifying the 0119 quarantine decisions and their guard on grid_quarantine"
migrate_until grid_quarantine 0119_document_quarantine_decisions
sql_in grid_quarantine <<<"INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('f1f1f1f1-f1f1-4000-8000-000000000117', 'org_0117', 'f2f2f2f2-f2f2-4000-8000-000000000117', 'job-1', 'archiv', 'Lohn.pdf', 'u');"
refused_in grid_quarantine "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0117', 'f2f2f2f2-f2f2-4000-8000-000000000117', 'job-1', 'archiv', 'Lohn.pdf', 'u');" "document_quarantine_decisions_dispatch_key" "one dispatch is one decision"
refused_in grid_quarantine "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0117', gen_random_uuid(), 'job-1', 'project', 'x', 'u');" "document_quarantine_decisions_scope_project" "a project shelf needs a project"
refused_in grid_quarantine "UPDATE document_quarantine_decisions SET reasons = 'iban' WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';" "only marked audited once" "a decision is never rewritten"
sql_in grid_quarantine <<<"UPDATE document_quarantine_decisions SET audited_at = now() WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';"
refused_in grid_quarantine "UPDATE document_quarantine_decisions SET audited_at = now() WHERE id = 'f1f1f1f1-f1f1-4000-8000-000000000117';" "only marked audited once" "a decision is marked audited once"
refused_in grid_quarantine "DELETE FROM document_quarantine_decisions;" "deleted only by the platform role" "only the platform role deletes"
echo "==> 0119 quarantine decisions verified"

# ---------------------------------------------------------------------------
# Migrations 0125 and 0127: a cross-project record cannot end before it began,
# and the evidence a drafted decision was read from (ADR-0096) is an array when
# it is set.
# ---------------------------------------------------------------------------
echo "==> verifying the 0125 cross-project record and the 0127 memory evidence CHECKs on grid_cross_project"
migrate_until grid_cross_project 0127_project_memory_evidence
sql_in grid_cross_project <<'SQL'
INSERT INTO conversation_source_projects (organization_id, conversation_id, project_id)
VALUES ('org_0125', 's_xp_0125', 'aaaaaaaa-0000-4000-8000-000000000125');
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000127', 'org_0127', 'Evidenz', 'user_1', 'proj_0127');
INSERT INTO project_memory (scope, project_id, organization_id, kind, content, provenance_type, verification, evidence)
VALUES ('project', 'aaaaaaaa-0000-4000-8000-000000000127', 'org_0127', 'decision', 'Fassade hinterlüftet 0127', 'distillation', 'source_grounded',
        '[{"fileName": "Baubeschreibung.pdf", "page": "4"}]');
SQL
refused_in grid_cross_project "UPDATE conversation_source_projects SET last_at = first_at - interval '1 day' WHERE conversation_id = 's_xp_0125';" "conversation_source_projects_order" "a record cannot end before it began"
refused_in grid_cross_project "UPDATE project_memory SET evidence = '{\"fileName\": \"a.pdf\"}' WHERE organization_id = 'org_0127';" "project_memory_evidence_check" "evidence is an array when it is set"
echo "==> 0125 and 0127 CHECKs verified"

# ---------------------------------------------------------------------------
# Migration 0129: the lifecycle state machine (ADR-0098), on the fully migrated
# database as the owner. A closed project keeps its Abschluss and a known
# outcome, a reopen keeps both for the next close, and a paused project still
# takes an insert; only a closed one refuses. project-status.integration.spec.ts
# above covers the rest of the CHECKs and the closed-project guard.
# ---------------------------------------------------------------------------
echo "==> verifying the 0129 project lifecycle on grid_app"
P129="id = 'aaaaaaaa-0000-4000-8000-000000000129'"
sql_in grid_app <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name, started_on)
VALUES ('aaaaaaaa-0000-4000-8000-000000000129', 'org_0129', 'Lifecycle 0129', 'user_1', 'proj_0129', '2031-03-01');
UPDATE projects SET status = 'closed', closed_at = '2031-06-15T10:00:00Z', closed_by = 'user_1', closed_outcome = 'completed', ended_on = '2031-06-01'
  WHERE id = 'aaaaaaaa-0000-4000-8000-000000000129';
SQL
refused_in grid_app "UPDATE projects SET ended_on = NULL WHERE $P129;" "projects_closed_outcome_check" "a closed project keeps its Abschluss"
refused_in grid_app "UPDATE projects SET closed_outcome = 'abandoned' WHERE $P129;" "projects_closed_outcome_check" "an outcome is completed or cancelled"
sql_in grid_app <<<"UPDATE projects SET status = 'active', closed_at = NULL, closed_by = NULL WHERE $P129;"
check_in grid_app "SELECT ended_on || ' ' || closed_outcome FROM projects WHERE $P129" "2031-06-01 completed" "a reopen keeps the Abschluss and the outcome for the next close"
refused_in grid_app "UPDATE projects SET status = 'paused' WHERE $P129;" "projects_paused_state_check" "a paused project carries its date"
sql_in grid_app <<<"UPDATE projects SET status = 'paused', paused_at = now() WHERE $P129;"
sql_in grid_app <<<"INSERT INTO project_folders (organization_id, project_id, name, path) VALUES ('org_0129', 'aaaaaaaa-0000-4000-8000-000000000129', 'Plaene', 'Plaene');"
sql_in grid_app <<<"DELETE FROM projects WHERE $P129;"
echo "==> 0129 project lifecycle verified"

# ---------------------------------------------------------------------------
# Migration 0133: a project's profile always has its four parts, and its DOWN.
#
# On a database of its own, migrated to 0132, where a project that never saved
# its intake still stores `{}` (the old default) and the close dialog's debrief
# crashed on `profile.facts`. The backfill gives every row the shape and keeps
# what is well-formed; the default is the empty profile; a hand-written `{}`
# or a part of the wrong type is refused. The down leaves the data.
# ---------------------------------------------------------------------------
echo "==> verifying the 0133 project profile shape and its down migration on grid_pshape"
migrate_until grid_pshape 0132_documents_folder_level_listing_idx
sql_in grid_pshape <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000133', 'org_0133', 'Nie erfasst', 'user_1', 'proj_0133a');
INSERT INTO projects (id, organization_id, name, created_by, collection_name, profile, profile_version) VALUES
  ('bbbbbbbb-0000-4000-8000-000000000133', 'org_0133', 'Teilweise', 'user_1', 'proj_0133b',
   '{"facts":{"bundesland":{"value":"tirol"}},"unknowns":"kaputt","extra":1}', 4),
  ('cccccccc-0000-4000-8000-000000000133', 'org_0133', 'Kein Objekt', 'user_1', 'proj_0133c', '[]', 2);
SQL
check_in grid_pshape "SELECT profile::text FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000133'" "{}" \
  "before 0133 a project that never saved its intake stores {}"
apply_in grid_pshape 0133_project_profile_shape.sql
P133="SELECT profile::text || ' v' || profile_version FROM projects WHERE id ="
check_in grid_pshape "$P133 'aaaaaaaa-0000-4000-8000-000000000133'" \
  '{"facts": {}, "goals": {}, "unknowns": [], "assumptions": {}} v1' "the backfill gives a {} row the empty profile, version unchanged"
check_in grid_pshape "$P133 'bbbbbbbb-0000-4000-8000-000000000133'" \
  '{"extra": 1, "facts": {"bundesland": {"value": "tirol"}}, "goals": {}, "unknowns": [], "assumptions": {}} v4' \
  "the backfill keeps a well-formed part and another key, and replaces a part of the wrong type"
check_in grid_pshape "$P133 'cccccccc-0000-4000-8000-000000000133'" \
  '{"facts": {}, "goals": {}, "unknowns": [], "assumptions": {}} v2' "the backfill turns a non-object into the empty profile"
sql_in grid_pshape <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('dddddddd-0000-4000-8000-000000000133', 'org_0133', 'Neu', 'user_1', 'proj_0133d');
SQL
check_in grid_pshape "$P133 'dddddddd-0000-4000-8000-000000000133'" \
  '{"facts": {}, "goals": {}, "unknowns": [], "assumptions": {}} v1' "a new project gets the empty profile by default"
refused_in grid_pshape "UPDATE projects SET profile = '{}' WHERE id = 'dddddddd-0000-4000-8000-000000000133'" \
  "projects_profile_shape_check" "a hand-written {} was accepted"
refused_in grid_pshape "UPDATE projects SET profile = profile || '{\"unknowns\": {}}' WHERE id = 'dddddddd-0000-4000-8000-000000000133'" \
  "projects_profile_shape_check" "unknowns as an object was accepted"
refused_in grid_pshape "UPDATE projects SET profile = profile - 'goals' WHERE id = 'dddddddd-0000-4000-8000-000000000133'" \
  "projects_profile_shape_check" "a profile without goals was accepted"
apply_in grid_pshape 0133_project_profile_shape.down.sql
check_in grid_pshape "SELECT count(*) FROM pg_constraint WHERE conname = 'projects_profile_shape_check'" "0" "down dropped the check"
check_in grid_pshape "SELECT column_default FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'profile'" \
  "'{}'::jsonb" "down restored the old default"
check_in grid_pshape "$P133 'bbbbbbbb-0000-4000-8000-000000000133'" \
  '{"extra": 1, "facts": {"bundesland": {"value": "tirol"}}, "goals": {}, "unknowns": [], "assumptions": {}} v4' "down left the data"
sql_in grid_pshape <<<"UPDATE projects SET profile = '{}' WHERE id = 'dddddddd-0000-4000-8000-000000000133'"
apply_in grid_pshape 0133_project_profile_shape.sql
apply_in grid_pshape 0133_project_profile_shape.sql
check_in grid_pshape "SELECT count(*) FROM projects WHERE organization_id = 'org_0133' AND profile ? 'facts'" "4" \
  "0133 re-applies, twice, and backfills a {} written while it was down"
echo "==> 0133 project profile shape and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0137: a version knows how it began, and an upload carries no
# approval nobody gave (ADR-0104 rules 5 and 6), and its DOWN.
#
# On a database of its own, migrated to 0136. A version never submitted that is
# or was the published one is an upload and loses its stand-in approver; one
# that went through review keeps the reviewer's. Afterwards a published draft
# without an approver and an unknown origin are refused, and an upload is
# published with none. The down restores the stand-in approvals.
# ---------------------------------------------------------------------------
echo "==> verifying the 0137 version origin backfill and its down migration on grid_vorigin"
migrate_until grid_vorigin 0136_document_version_reviews
sql_in grid_vorigin <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000137', 'org_0137', 'Herkunft 0137', 'user_1', 'proj_0137');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000137', 'org_0137', 'user_1', 'a.pdf', 'k/0137/a2', 'proj_0137', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000137'),
  ('d2d2d2d2-0000-4000-8000-000000000137', 'org_0137', 'user_1', 'piloti/b.md', 'k/0137/b1', 'proj_0137', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000137'),
  ('d3d3d3d3-0000-4000-8000-000000000137', 'org_0137', 'user_1', 'piloti/c.md', 'k/0137/c1', 'proj_0137', 'stored', 'project', 'aaaaaaaa-0000-4000-8000-000000000137');
INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by,
                               submitted_by, submitted_at, approved_by, approved_at) VALUES
  -- a re-uploaded file: both versions carry the uploader as stand-in approver
  ('org_0137', 'd1d1d1d1-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 1, 'superseded', 'k/0137/a1', 'user_1', NULL, NULL, 'user_1', now()),
  ('org_0137', 'd1d1d1d1-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 2, 'published',  'k/0137/a2', 'user_1', NULL, NULL, 'user_1', now()),
  -- a Piloti document a reviewer approved
  ('org_0137', 'd2d2d2d2-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 1, 'published',  'k/0137/b1', 'user_1', 'user_1', now(), 'user_2', now()),
  -- a draft
  ('org_0137', 'd3d3d3d3-0000-4000-8000-000000000137', 'aaaaaaaa-0000-4000-8000-000000000137', 1, 'draft',      'k/0137/c1', 'user_1', NULL, NULL, NULL, NULL);
SQL
V137="SELECT string_agg(d.filename || ':' || v.version_number || '=' || v.origin || '/' || coalesce(v.approved_by, '-'), ',' ORDER BY d.filename, v.version_number) FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.organization_id = 'org_0137'"
apply_in grid_vorigin 0137_document_version_origin.sql
check_in grid_vorigin "$V137" "a.pdf:1=upload/-,a.pdf:2=upload/-,piloti/b.md:1=draft/user_2,piloti/c.md:1=draft/-" \
  "the backfill calls a never-submitted published version an upload and drops its stand-in approver, and keeps a reviewer's"
refused_in grid_vorigin "UPDATE document_versions SET state = 'published' WHERE document_id = 'd3d3d3d3-0000-4000-8000-000000000137'" \
  "document_versions_published_is_approved" "a draft was published without an approver"
refused_in grid_vorigin "UPDATE document_versions SET origin = 'import' WHERE document_id = 'd3d3d3d3-0000-4000-8000-000000000137'" \
  "document_versions_origin_known" "an unknown origin was accepted"
check_in grid_vorigin "SELECT column_default FROM information_schema.columns WHERE table_name = 'document_versions' AND column_name = 'origin'" \
  "'draft'::text" "a writer that names no origin gets the one that demands an approver"
apply_in grid_vorigin 0137_document_version_origin.down.sql
check_in grid_vorigin "SELECT count(*) FROM information_schema.columns WHERE table_name = 'document_versions' AND column_name = 'origin'" "0" "down dropped the column"
check_in grid_vorigin "SELECT count(*) FROM document_versions WHERE organization_id = 'org_0137' AND approved_by = created_by AND submitted_by IS NULL" "2" \
  "down restored the stand-in approvals the old CHECK demands"
apply_in grid_vorigin 0137_document_version_origin.sql
apply_in grid_vorigin 0137_document_version_origin.sql
check_in grid_vorigin "$V137" "a.pdf:1=upload/-,a.pdf:2=upload/-,piloti/b.md:1=draft/user_2,piloti/c.md:1=draft/-" "0137 re-applies, twice, to the same origins"
echo "==> 0137 version origin backfill and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0138: document_annotations and their replies, the CHECKs, and the
# DOWN.
#
# On a database of its own, migrated to 0137. A point is a share of the page
# and a region stays on it; only Piloti proposes, and only a person takes a
# proposal over; a closing is by somebody at some time; a number is unique per
# document; a discarded version leaves the mark standing; a thread goes with
# its mark.
# ---------------------------------------------------------------------------
echo "==> verifying the 0138 Anmerkungen tables and their down migration on grid_annot"
migrate_until grid_annot 0137_document_version_origin
apply_in grid_annot 0138_document_annotations.sql
check_in grid_annot "SELECT string_agg(relrowsecurity::text, ',' ORDER BY relname) FROM pg_class WHERE relname IN ('document_annotations', 'document_annotation_replies')" "true,true" "0138 brings both tables up under row-level security"
sql_in grid_annot <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000135', 'org_0135', 'Anmerkungen 0138', 'user_1', 'proj_0135');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000135', 'org_0135', 'user_1', 'a.pdf', 'k/0138/a', 'proj_0135', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000135');
INSERT INTO document_versions (id, organization_id, document_id, project_id, version_number, state, storage_key, content_hash, created_by, approved_by, approved_at)
VALUES ('e1e1e1e1-0000-4000-8000-000000000135', 'org_0135', 'd1d1d1d1-0000-4000-8000-000000000135', 'aaaaaaaa-0000-4000-8000-000000000135', 1, 'superseded', 'k/0138/a1', 'sha256:a1', 'user_1', 'user_1', now());
INSERT INTO document_annotations (id, organization_id, document_id, version_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000135', 'org_0135', 'd1d1d1d1-0000-4000-8000-000000000135', 'e1e1e1e1-0000-4000-8000-000000000135', 1, 2, 'point', 0.25, 0.75, 'defect', 'Brandschutztür fehlt', 'person', 'open', 'user_1');
INSERT INTO document_annotations (organization_id, document_id, number, page, shape, x, y, w, h, kind, body, basis, author_kind, status, created_by)
VALUES ('org_0135', 'd1d1d1d1-0000-4000-8000-000000000135', 2, 1, 'region', 0.1, 0.1, 0.5, 0.5, 'question', 'Laufbreite?', 'OIB-RL 4, Pkt. 2.2', 'piloti', 'proposed', 'user_1');
INSERT INTO document_annotation_replies (organization_id, annotation_id, author_kind, body, created_by)
VALUES ('org_0135', 'f1f1f1f1-0000-4000-8000-000000000135', 'person', 'Erledige ich', 'user_2');
SQL
A135="INSERT INTO document_annotations (organization_id, document_id, number, page, shape, x, y, w, h, kind, body, author_kind, status, created_by) VALUES ('org_0135', 'd1d1d1d1-0000-4000-8000-000000000135'"
refused_in grid_annot "$A135, 3, 1, 'point', 1.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_point_on_page" "a point off the page was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, 0.1, 0.1, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_region_on_page" "a point with a size was accepted"
refused_in grid_annot "$A135, 3, 1, 'region', 0.8, 0.5, 0.3, 0.1, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_region_on_page" "a region off its page was accepted"
refused_in grid_annot "$A135, 3, 0, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'open', 'user_1')" "document_annotations_page_positive" "page 0 was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'todo', 'x', 'person', 'open', 'user_1')" "document_annotations_kind_known" "an unknown kind was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', '   ', 'person', 'open', 'user_1')" "document_annotations_body_length" "a blank body was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'proposed', 'user_1')" "document_annotations_only_piloti_proposes" "a person's proposal was accepted"
refused_in grid_annot "$A135, 3, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'piloti', 'open', 'user_1')" "document_annotations_piloti_needs_a_person" "Piloti's mark was born open"
refused_in grid_annot "$A135, 1, 1, 'point', 0.5, 0.5, NULL, NULL, 'hint', 'x', 'person', 'open', 'user_1')" "uniq_document_annotations_number" "a second number 1 was accepted"
refused_in grid_annot "UPDATE document_annotations SET status = 'resolved' WHERE number = 1" "document_annotations_closing_complete" "a closing by nobody was accepted"
refused_in grid_annot "UPDATE document_annotations SET status = 'open' WHERE number = 2" "document_annotations_piloti_needs_a_person" "a proposal was opened without a person taking it over"
sql_in grid_annot <<<"UPDATE document_annotations SET status = 'open', accepted_by = 'user_2', accepted_at = now() WHERE number = 2"
sql_in grid_annot <<<"UPDATE document_annotations SET status = 'resolved', closed_by = 'user_1', closed_at = now() WHERE number = 1"
sql_in grid_annot <<<"DELETE FROM document_versions WHERE id = 'e1e1e1e1-0000-4000-8000-000000000135'"
check_in grid_annot "SELECT string_agg(number || ':' || coalesce(version_id::text, 'null') || ':' || status, ',' ORDER BY number) FROM document_annotations" "1:null:resolved,2:null:open" "a discarded version leaves the mark standing, and a taken-over proposal is open"
sql_in grid_annot <<<"DELETE FROM document_annotations WHERE number = 1"
check_in grid_annot "SELECT count(*) FROM document_annotation_replies" "0" "a thread goes with its mark"
apply_in grid_annot 0138_document_annotations.down.sql
check_in grid_annot "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('document_annotations', 'document_annotation_replies')" "0" "down dropped both tables"
apply_in grid_annot 0138_document_annotations.sql
apply_in grid_annot 0138_document_annotations.sql
check_in grid_annot "SELECT count(*) FROM document_annotations" "0" "0138 re-applies, twice, empty"
echo "==> 0138 Anmerkungen tables and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0139: what wakes Piloti on an Anmerkung, the delegation to Piloti,
# the record of each wake, and the DOWN.
#
# On a database of its own, migrated to 0138. A reply says whether it
# addressed Piloti (false for every older reply); a delegation is both columns
# or neither, and only on an open mark; a wake record says why it started no
# turn exactly when it did not, and is settled exactly when it left `queued`;
# a wake goes with its mark.
# ---------------------------------------------------------------------------
echo "==> verifying the 0139 wake record, the delegation and their down migration on grid_wake"
migrate_until grid_wake 0138_document_annotations
sql_in grid_wake <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000136', 'org_0136', 'Wecken 0139', 'user_1', 'proj_0136');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000136', 'org_0136', 'user_1', 'a.pdf', 'k/0139/a', 'proj_0136', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000136');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000136', 'org_0136', 'd1d1d1d1-0000-4000-8000-000000000136', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f2f2f2f2-0000-4000-8000-000000000136', 'org_0136', 'd1d1d1d1-0000-4000-8000-000000000136', 2, 1, 'point', 0.2, 0.2, 'question', 'Laufbreite?', 'piloti', 'proposed', 'user_1');
INSERT INTO document_annotation_replies (organization_id, annotation_id, author_kind, body, created_by)
VALUES ('org_0136', 'f1f1f1f1-0000-4000-8000-000000000136', 'person', 'Vor 0139 geschrieben', 'user_2');
SQL
apply_in grid_wake 0139_piloti_wakes.sql
check_in grid_wake "SELECT relrowsecurity FROM pg_class WHERE relname = 'piloti_wakes'" "t" "0139 brings the wake record up under row-level security"
check_in grid_wake "SELECT string_agg(addresses_agent::text, ',') FROM document_annotation_replies" "false" "a reply written before 0139 addressed nobody but people"
refused_in grid_wake "UPDATE document_annotations SET delegated_by = 'user_1' WHERE number = 1" "document_annotations_delegation_complete" "a delegation without its time was accepted"
refused_in grid_wake "UPDATE document_annotations SET delegated_at = now() WHERE number = 1" "document_annotations_delegation_complete" "a delegation without its person was accepted"
refused_in grid_wake "UPDATE document_annotations SET delegated_by = 'user_1', delegated_at = now() WHERE number = 2" "document_annotations_delegated_while_open" "a proposal was delegated to Piloti"
sql_in grid_wake <<<"UPDATE document_annotations SET delegated_by = 'user_1', delegated_at = now() WHERE number = 1"
refused_in grid_wake "UPDATE document_annotations SET status = 'resolved', closed_by = 'user_1', closed_at = now() WHERE number = 1" "document_annotations_delegated_while_open" "a mark closed with Piloti still working it"
sql_in grid_wake <<<"UPDATE document_annotations SET status = 'resolved', closed_by = 'user_1', closed_at = now(), delegated_by = NULL, delegated_at = NULL WHERE number = 1"
W136="INSERT INTO piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, reason, settled_at) VALUES (gen_random_uuid(), 'org_0136', 'd1d1d1d1-0000-4000-8000-000000000136', 'f2f2f2f2-0000-4000-8000-000000000136'"
refused_in grid_wake "$W136, 'shouted', 'e1', 'user_1', 'queued', NULL, NULL)" "piloti_wakes_trigger_known" "an unknown trigger was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'snoozed', NULL, now())" "piloti_wakes_status_known" "an unknown status was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'refused', NULL, now())" "piloti_wakes_reason_when_not_started" "a refused wake without its reason was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'started', 'weil', now())" "piloti_wakes_reason_when_not_started" "a started wake with a reason was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'started', NULL, NULL)" "piloti_wakes_settled_when_not_queued" "a started wake without its settling time was accepted"
refused_in grid_wake "$W136, 'thread_reply', 'e1', 'user_1', 'queued', NULL, now())" "piloti_wakes_settled_when_not_queued" "a queued wake with a settling time was accepted"
sql_in grid_wake <<<"$W136, 'thread_reply', 'e1', 'user_1', 'queued', NULL, NULL)"
sql_in grid_wake <<<"$W136, 'assigned', 'e2', 'user_1', 'suppressed', 'cap:mark-hour', now())"
check_in grid_wake "SELECT count(*) FROM piloti_wakes" "2" "a queued wake and a suppressed one with its reason are kept"
sql_in grid_wake <<<"DELETE FROM document_annotations WHERE number = 2"
check_in grid_wake "SELECT count(*) FROM piloti_wakes" "0" "a wake goes with its mark"
apply_in grid_wake 0139_piloti_wakes.down.sql
check_in grid_wake "SELECT count(*) FROM information_schema.tables WHERE table_name = 'piloti_wakes'" "0" "down dropped the wake record"
check_in grid_wake "SELECT count(*) FROM information_schema.columns WHERE (table_name, column_name) IN (('document_annotations', 'delegated_by'), ('document_annotations', 'delegated_at'), ('document_annotation_replies', 'addresses_agent'))" "0" "down dropped the three columns"
check_in grid_wake "SELECT count(*) FROM document_annotation_replies" "1" "down left the threads"
apply_in grid_wake 0139_piloti_wakes.sql
apply_in grid_wake 0139_piloti_wakes.sql
check_in grid_wake "SELECT count(*) FROM piloti_wakes" "0" "0139 re-applies, twice, empty"
echo "==> 0139 wake record, delegation and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0140: proposed_changes, the CHECKs, and the DOWN.
#
# On a database of its own, migrated to 0139. A proposal is decided by
# somebody at some time exactly when it left `proposed`; it carries results
# exactly when it was applied, as an array; the apply claim is both columns or
# neither, and only while it is still `proposed`; the project and the
# conversation are this organization's; it goes with either.
# ---------------------------------------------------------------------------
echo "==> verifying the 0140 proposed changes and their down migration on grid_prop"
migrate_until grid_prop 0139_piloti_wakes
apply_in grid_prop 0140_proposed_changes.sql
check_in grid_prop "SELECT relrowsecurity FROM pg_class WHERE relname = 'proposed_changes'" "t" "0140 brings proposed_changes up under row-level security"
sql_in grid_prop <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000137', 'org_0137', 'Vorschläge 0140', 'user_1', 'proj_0137'),
       ('bbbbbbbb-0000-4000-8000-000000000137', 'org_other', 'Fremd 0140', 'user_9', 'proj_other_0137');
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES ('conv_0137', 'org_0137', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000137'),
       ('conv_other_0137', 'org_other', 'user_9', 'bbbbbbbb-0000-4000-8000-000000000137');
INSERT INTO proposed_changes (id, organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id)
VALUES ('c1c1c1c1-0000-4000-8000-000000000137', 'org_0137', 'aaaaaaaa-0000-4000-8000-000000000137', 'file_operation',
        '{"operation":"move","operations":[{"document":"a.pdf","target_folder":"Einreichung"}]}', 'piloti', 'user_1', 'conv_0137'),
       ('c2c2c2c2-0000-4000-8000-000000000137', 'org_0137', 'aaaaaaaa-0000-4000-8000-000000000137', 'file_operation',
        '{"operation":"create_folder","operations":[{"folder_name":"Statik"}]}', 'piloti', 'user_1', NULL);
SQL
check_in grid_prop "SELECT string_agg(status, ',') FROM proposed_changes" "proposed,proposed" "a proposal is born proposed"
P137="INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id, status, decided_by, decided_at, results, applying_by, applying_since) VALUES ('org_0137', 'aaaaaaaa-0000-4000-8000-000000000137'"
refused_in grid_prop "$P137, 'delete_all', '{}', 'piloti', 'user_1', NULL, 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_kind_known" "an unknown kind was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'withdrawn', 'user_1', now(), NULL, NULL, NULL)" "proposed_changes_status_known" "an unknown status was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'robot', 'user_1', NULL, 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_proposer_known" "an unknown proposer was accepted"
refused_in grid_prop "$P137, 'file_operation', '[]', 'piloti', 'user_1', NULL, 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_payload_object" "a payload that is not an object was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_decision_complete" "a decision by nobody was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', 'user_1', NULL, NULL, NULL, NULL)" "proposed_changes_decision_complete" "a decision at no time was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'proposed', 'user_1', now(), NULL, NULL, NULL)" "proposed_changes_decision_complete" "an undecided proposal with a decider was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'applied', 'user_1', now(), NULL, NULL, NULL)" "proposed_changes_results_when_applied" "an applied proposal without results was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', 'user_1', now(), '[]', NULL, NULL)" "proposed_changes_results_when_applied" "a dismissed proposal with results was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'failed', 'user_1', now(), '{}', NULL, NULL)" "proposed_changes_results_array" "results that are not a list were accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'proposed', NULL, NULL, NULL, 'user_1', NULL)" "proposed_changes_claim_complete" "a claim at no time was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', NULL, 'dismissed', 'user_1', now(), NULL, 'user_1', now())" "proposed_changes_claim_while_proposed" "a claim on a decided proposal was accepted"
refused_in grid_prop "$P137, 'file_operation', '{}', 'piloti', 'user_1', 'conv_other_0137', 'proposed', NULL, NULL, NULL, NULL, NULL)" "proposed_changes_conversation_fkey" "another organization's conversation was accepted"
refused_in grid_prop "INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0137', 'bbbbbbbb-0000-4000-8000-000000000137', 'file_operation', '{}', 'piloti', 'user_1')" "proposed_changes_project_fkey" "another organization's project was accepted"
sql_in grid_prop <<<"UPDATE proposed_changes SET applying_by = 'user_2', applying_since = now() WHERE id = 'c1c1c1c1-0000-4000-8000-000000000137'"
refused_in grid_prop "UPDATE proposed_changes SET status = 'partially_applied', decided_by = 'user_2', decided_at = now(), results = '[{\"label\":\"a.pdf\",\"ok\":true}]' WHERE id = 'c1c1c1c1-0000-4000-8000-000000000137'" "proposed_changes_claim_while_proposed" "a settle that kept its claim was accepted"
sql_in grid_prop <<<"UPDATE proposed_changes SET status = 'partially_applied', decided_by = 'user_2', decided_at = now(), results = '[{\"label\":\"a.pdf\",\"ok\":true}]', applying_by = NULL, applying_since = NULL WHERE id = 'c1c1c1c1-0000-4000-8000-000000000137'"
sql_in grid_prop <<<"DELETE FROM conversations WHERE id = 'conv_0137'"
check_in grid_prop "SELECT count(*) FROM proposed_changes" "1" "a proposal goes with its conversation"
sql_in grid_prop <<<"DELETE FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000137'"
check_in grid_prop "SELECT count(*) FROM proposed_changes" "0" "a proposal goes with its project"
apply_in grid_prop 0140_proposed_changes.down.sql
check_in grid_prop "SELECT count(*) FROM information_schema.tables WHERE table_name = 'proposed_changes'" "0" "down dropped proposed_changes"
check_in grid_prop "SELECT count(*) FROM conversations" "1" "down left the conversations"
apply_in grid_prop 0140_proposed_changes.sql
apply_in grid_prop 0140_proposed_changes.sql
check_in grid_prop "SELECT count(*) FROM proposed_changes" "0" "0140 re-applies, twice, empty"
echo "==> 0140 proposed changes and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0141: a wake's END, and the DOWN.
#
# On a database of its own, migrated to 0140. A wake has an end exactly when it
# has its final word (not `queued`, not `started`); the rows 0139 settled
# already ended when they settled; `answered` and `stopped` carry no reason,
# `failed` does.
# ---------------------------------------------------------------------------
echo "==> verifying the 0141 wake ends and their down migration on grid_wend"
migrate_until grid_wend 0140_proposed_changes
sql_in grid_wend <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000138', 'org_0138', 'Enden 0141', 'user_1', 'proj_0138');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000138', 'org_0138', 'user_1', 'a.pdf', 'k/0141/a', 'proj_0138', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000138');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, reason, settled_at)
VALUES ('a1a1a1a1-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'thread_mention', 'e1', 'user_1', 'queued', NULL, NULL),
       ('a2a2a2a2-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'thread_mention', 'e2', 'user_1', 'started', NULL, now()),
       ('a3a3a3a3-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'assigned', 'e3', 'user_1', 'suppressed', 'cap:mark-hour', now());
SQL
apply_in grid_wend 0141_wake_ends.sql
check_in grid_wend "SELECT string_agg(status || ':' || (ended_at IS NOT NULL)::text, ',' ORDER BY event_id) FROM piloti_wakes" "queued:false,started:false,suppressed:true" "a wake 0139 settled without a turn ended when it settled; the others have not ended"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'answered' WHERE event_id = 'e2'" "piloti_wakes_ended_when_final" "an answered wake without its end was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET ended_at = now() WHERE event_id = 'e2'" "piloti_wakes_ended_when_final" "a running wake with an end was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'snoozed', ended_at = now() WHERE event_id = 'e2'" "piloti_wakes_status_known" "an unknown end was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'answered', ended_at = now(), reason = 'weil' WHERE event_id = 'e2'" "piloti_wakes_reason_when_not_started" "an answered wake with a reason was accepted"
refused_in grid_wend "UPDATE piloti_wakes SET status = 'failed', ended_at = now() WHERE event_id = 'e2'" "piloti_wakes_reason_when_not_started" "a failed turn without its reason was accepted"
sql_in grid_wend <<<"UPDATE piloti_wakes SET status = 'failed', reason = 'turn error', ended_at = settled_at + interval '1 minute' WHERE event_id = 'e2'"
sql_in grid_wend <<'SQL'
INSERT INTO piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, reason, settled_at, ended_at)
VALUES ('a4a4a4a4-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'thread_mention', 'e4', 'user_1', 'answered', NULL, now(), now() + interval '1 minute'),
       ('a5a5a5a5-0000-4000-8000-000000000138', 'org_0138', 'd1d1d1d1-0000-4000-8000-000000000138', 'f1f1f1f1-0000-4000-8000-000000000138', 'assigned', 'e5', 'user_1', 'stopped', NULL, now(), now() + interval '1 minute');
SQL
check_in grid_wend "SELECT count(*) FROM piloti_wakes WHERE ended_at IS NOT NULL" "4" "an answered, a stopped and a failed turn keep their ends"
apply_in grid_wend 0141_wake_ends.down.sql
check_in grid_wend "SELECT string_agg(status, ',' ORDER BY event_id) FROM piloti_wakes" "queued,started,suppressed,started,started" "down folds every end of a turn that ran back into started"
check_in grid_wend "SELECT count(*) FROM information_schema.columns WHERE table_name = 'piloti_wakes' AND column_name = 'ended_at'" "0" "down dropped ended_at"
apply_in grid_wend 0141_wake_ends.sql
apply_in grid_wend 0141_wake_ends.sql
check_in grid_wend "SELECT count(*) FROM piloti_wakes WHERE ended_at IS NOT NULL" "1" "0141 re-applies, twice: only the suppressed wake has ended"
echo "==> 0141 wake ends and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0142: piloti_changes, the CHECKs, and the DOWN.
#
# On a database of its own, migrated to 0141. A change names a known object
# and op; a create has no before, a delete no after, an update both; a reply
# is only ever created; a mark's change names the mark as its object; states
# are objects; an undo is by somebody at some time; the document and the
# conversation are this organization's; it goes with either, and outlives the
# mark it deleted.
# ---------------------------------------------------------------------------
echo "==> verifying the 0142 change record and its down migration on grid_chg"
migrate_until grid_chg 0141_wake_ends
apply_in grid_chg 0142_piloti_changes.sql
check_in grid_chg "SELECT relrowsecurity FROM pg_class WHERE relname = 'piloti_changes'" "t" "0142 brings piloti_changes up under row-level security"
sql_in grid_chg <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000139', 'org_0139', 'Änderungen 0142', 'user_1', 'proj_0139'),
       ('bbbbbbbb-0000-4000-8000-000000000139', 'org_other', 'Fremd 0142', 'user_9', 'proj_other_0139');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000139', 'org_0139', 'user_1', 'a.pdf', 'k/0142/a', 'proj_0139', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000139'),
       ('d2d2d2d2-0000-4000-8000-000000000139', 'org_0139', 'user_1', 'b.pdf', 'k/0142/b', 'proj_0139', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000139');
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES ('conv_0139', 'org_0139', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000139'),
       ('conv_other_0139', 'org_other', 'user_9', 'bbbbbbbb-0000-4000-8000-000000000139');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000139', 'org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO piloti_changes (organization_id, document_id, annotation_id, object_kind, object_id, op, before, after, origin_conversation_id, origin_message_id, on_behalf_of)
VALUES ('org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139', 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{"status":"open"}', '{"status":"resolved"}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1'),
       ('org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139', 'annotation_reply', 'e1e1e1e1-0000-4000-8000-000000000139', 'create', NULL, '{"body":"Ja."}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1'),
       ('org_0139', 'd2d2d2d2-0000-4000-8000-000000000139', 'f2f2f2f2-0000-4000-8000-000000000139', 'annotation', 'f2f2f2f2-0000-4000-8000-000000000139', 'delete', '{"status":"open","body":"weg"}', NULL, 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1');
SQL
check_in grid_chg "SELECT count(*) FROM piloti_changes WHERE undone_at IS NULL AND undone_by IS NULL" "3" "an update, a reply and a delete of a mark that no longer exists are recorded, undone by nobody"
C139="INSERT INTO piloti_changes (organization_id, document_id, annotation_id, object_kind, object_id, op, before, after, origin_conversation_id, origin_message_id, on_behalf_of) VALUES ('org_0139', 'd1d1d1d1-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139'"
refused_in grid_chg "$C139, 'document', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_object_known" "an unknown object was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'move', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_op_known" "an unknown op was accepted"
refused_in grid_chg "$C139, 'annotation_reply', 'e1e1e1e1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_reply_is_created" "a reply changed by Piloti was accepted"
refused_in grid_chg "$C139, 'annotation', 'e1e1e1e1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_annotation_is_object" "a mark's change naming another object was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'create', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_by_op" "a create with a before was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', NULL, '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_by_op" "an update without a before was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'delete', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_by_op" "a delete with an after was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '[]', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_states_are_objects" "a state that is not an object was accepted"
refused_in grid_chg "$C139, 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_other_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_conversation_fkey" "another organization's conversation was accepted"
refused_in grid_chg "INSERT INTO piloti_changes (organization_id, document_id, annotation_id, object_kind, object_id, op, before, after, origin_conversation_id, origin_message_id, on_behalf_of) VALUES ('org_0139', '00000000-0000-4000-8000-000000000139', 'f1f1f1f1-0000-4000-8000-000000000139', 'annotation', 'f1f1f1f1-0000-4000-8000-000000000139', 'update', '{}', '{}', 'conv_0139', 'c1c1c1c1-0000-4000-8000-000000000139', 'user_1')" "piloti_changes_document_fkey" "a change on no document was accepted"
refused_in grid_chg "UPDATE piloti_changes SET undone_at = now() WHERE op = 'update'" "piloti_changes_undo_complete" "an undo by nobody was accepted"
refused_in grid_chg "UPDATE piloti_changes SET undone_by = 'user_2' WHERE op = 'update'" "piloti_changes_undo_complete" "an undo at no time was accepted"
sql_in grid_chg <<<"UPDATE piloti_changes SET undone_at = now(), undone_by = 'user_2' WHERE op = 'update'"
sql_in grid_chg <<<"DELETE FROM document_annotations WHERE id = 'f1f1f1f1-0000-4000-8000-000000000139'"
check_in grid_chg "SELECT count(*) FROM piloti_changes" "3" "the record outlives the mark (no foreign key on the mark)"
sql_in grid_chg <<<"DELETE FROM documents WHERE id = 'd2d2d2d2-0000-4000-8000-000000000139'"
check_in grid_chg "SELECT count(*) FROM piloti_changes" "2" "a change goes with its document"
sql_in grid_chg <<<"DELETE FROM conversations WHERE id = 'conv_0139'"
check_in grid_chg "SELECT count(*) FROM piloti_changes" "0" "a change goes with the conversation of its turn"
apply_in grid_chg 0142_piloti_changes.down.sql
check_in grid_chg "SELECT count(*) FROM information_schema.tables WHERE table_name = 'piloti_changes'" "0" "down dropped piloti_changes"
check_in grid_chg "SELECT count(*) FROM documents" "1" "down left the documents"
apply_in grid_chg 0142_piloti_changes.sql
apply_in grid_chg 0142_piloti_changes.sql
check_in grid_chg "SELECT count(*) FROM piloti_changes" "0" "0142 re-applies, twice, empty"
echo "==> 0142 change record and down migration verified"


# ---------------------------------------------------------------------------
# Migration 0143: two more proposal kinds, the card index, and the DOWN.
#
# On a database of its own, migrated to 0142. A memory note and a profile
# change are stored, an unknown kind is not; a card index is never negative and
# names a card of an answer, so it needs the answer; one card of one answer is
# one proposal per organization, while another card, another answer, another
# organization or no card at all is its own. The down deletes the new kinds,
# forgets the card index, and the up re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0143 proposal kinds and their down migration on grid_kinds"
migrate_until grid_kinds 0142_piloti_changes
apply_in grid_kinds 0143_proposal_kinds.sql
sql_in grid_kinds <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000140', 'org_0140', 'Vorschläge 0143', 'user_1', 'proj_0140'),
       ('bbbbbbbb-0000-4000-8000-000000000140', 'org_other', 'Fremd 0143', 'user_9', 'proj_other_0140');
INSERT INTO proposed_changes (id, organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_message_id, origin_card_index)
VALUES ('c1c1c1c1-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'file_operation',
        '{"operation":"create_folder","operations":[{"folder_name":"Statik"}]}', 'piloti', 'user_1', NULL, NULL),
       ('c2c2c2c2-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"project","kind":"decision","content":"Flachdach","confidence":"high"}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', 0),
       ('c3c3c3c3-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'project_profile',
        '{"title":"Bundesland","patch":[{"op":"replace","path":"/facts/bundesland/value","value":"tirol"}]}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', 1),
       ('c4c4c4c4-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"organization","kind":"preference","content":"1:100","confidence":"medium"}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', NULL),
       ('c5c5c5c5-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"organization","kind":"preference","content":"1:50","confidence":"medium"}', 'piloti', 'user_1',
        'dddddddd-0000-4000-8000-000000000140', NULL),
       ('c6c6c6c6-0000-4000-8000-000000000140', 'org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory',
        '{"scope":"project","kind":"decision","content":"Holzbau","confidence":"high"}', 'piloti', 'user_1',
        'eeeeeeee-0000-4000-8000-000000000140', 0),
       ('c7c7c7c7-0000-4000-8000-000000000140', 'org_other', 'bbbbbbbb-0000-4000-8000-000000000140', 'memory',
        '{"scope":"project","kind":"decision","content":"Fremd","confidence":"low"}', 'piloti', 'user_9',
        'dddddddd-0000-4000-8000-000000000140', 0);
SQL
check_in grid_kinds "SELECT string_agg(kind, ',' ORDER BY id) FROM proposed_changes" "file_operation,memory,project_profile,memory,memory,memory,memory" "0143 stores both new kinds, a card on another answer, two without a card, and the same card in another organization"
P140="INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of, origin_message_id, origin_card_index) VALUES ('org_0140', 'aaaaaaaa-0000-4000-8000-000000000140'"
refused_in grid_kinds "$P140, 'steckbrief', '{}', 'piloti', 'user_1', NULL, NULL)" "proposed_changes_kind_known" "an unknown kind was accepted"
refused_in grid_kinds "$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', -1)" "proposed_changes_card_index_nonnegative" "a negative card index was accepted"
refused_in grid_kinds "$P140, 'memory', '{}', 'piloti', 'user_1', NULL, 2)" "proposed_changes_card_index_needs_message" "a card index without its answer was accepted"
refused_in grid_kinds "$P140, 'project_profile', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0)" "uniq_proposed_changes_origin_card" "the same card of the same answer was accepted twice"
refused_in grid_kinds "UPDATE proposed_changes SET origin_card_index = 1 WHERE id = 'c2c2c2c2-0000-4000-8000-000000000140'" "uniq_proposed_changes_origin_card" "a proposal was moved onto another proposal's card"
# The service's idempotent insert: the same card is no row, and the first one reads back.
sql_in grid_kinds <<<"$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0) ON CONFLICT (organization_id, origin_message_id, origin_card_index) WHERE origin_card_index IS NOT NULL DO NOTHING"
check_in grid_kinds "SELECT count(*) FROM proposed_changes WHERE organization_id = 'org_0140'" "6" "an insert of a card already proposed added a row"
apply_in grid_kinds 0143_proposal_kinds.down.sql
check_in grid_kinds "SELECT string_agg(kind, ',') FROM proposed_changes" "file_operation" "down deleted the proposals of the new kinds, and only those"
check_in grid_kinds "SELECT count(*) FROM information_schema.columns WHERE table_name = 'proposed_changes' AND column_name = 'origin_card_index'" "0" "down dropped the card index"
check_in grid_kinds "SELECT count(*) FROM pg_indexes WHERE indexname = 'uniq_proposed_changes_origin_card'" "0" "down dropped the card's unique index"
refused_in grid_kinds "INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0140', 'aaaaaaaa-0000-4000-8000-000000000140', 'memory', '{}', 'piloti', 'user_1')" "proposed_changes_kind_known" "down left the new kinds allowed"
apply_in grid_kinds 0143_proposal_kinds.sql
apply_in grid_kinds 0143_proposal_kinds.sql
check_in grid_kinds "SELECT count(*) FROM proposed_changes" "1" "0143 re-applies, twice, keeping the file operation"
sql_in grid_kinds <<<"$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0)"
refused_in grid_kinds "$P140, 'memory', '{}', 'piloti', 'user_1', 'dddddddd-0000-4000-8000-000000000140', 0)" "uniq_proposed_changes_origin_card" "the re-applied 0143 lost the card's unique index"
echo "==> 0143 proposal kinds and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0144: project_intakes, the CHECKs, and the DOWN.
#
# On a database of its own, migrated to 0143. One intake per project, of this
# organization's project, gone with it. A closing intent exactly in `closing`
# mode, and an object; a reading always names its job, and one job is one
# intake's; the completion is by somebody at some time exactly when
# `completed`; the read list and the dismissed values are arrays, born empty;
# the description is at most 500 characters.
# ---------------------------------------------------------------------------
echo "==> verifying the 0144 project intakes and their down migration on grid_intake"
migrate_until grid_intake 0143_proposal_kinds
apply_in grid_intake 0144_project_intakes.sql
check_in grid_intake "SELECT relrowsecurity FROM pg_class WHERE relname = 'project_intakes'" "t" "0144 brings project_intakes up under row-level security"
sql_in grid_intake <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000144', 'org_0144', 'Erfassung 0144', 'user_1', 'proj_0144'),
       ('cccccccc-0000-4000-8000-000000000144', 'org_0144', 'Abgeschlossen 0144', 'user_1', 'proj_closed_0144'),
       ('dddddddd-0000-4000-8000-000000000144', 'org_0144', 'Frei 0144', 'user_1', 'proj_free_0144'),
       ('bbbbbbbb-0000-4000-8000-000000000144', 'org_other', 'Fremd 0144', 'user_9', 'proj_other_0144');
INSERT INTO project_intakes (organization_id, project_id, created_by)
VALUES ('org_0144', 'aaaaaaaa-0000-4000-8000-000000000144', 'user_1');
INSERT INTO project_intakes (organization_id, project_id, created_by, mode, closing, status, job_id, requested_by)
VALUES ('org_0144', 'cccccccc-0000-4000-8000-000000000144', 'user_1', 'closing',
        '{"outcome":"completed","endedOn":"2024-06"}', 'reading', 'job_0144', 'user_1');
SQL
check_in grid_intake "SELECT string_agg(mode || ':' || status || ':' || documents_read::text || ':' || dismissed::text || ':' || rerun_requested::text, ',' ORDER BY mode) FROM project_intakes" "active:waiting:[]:[]:false,closing:reading:[]:[]:false" "an intake is born waiting and active, with nothing read or dismissed"
I144="INSERT INTO project_intakes (organization_id, project_id, created_by, mode, closing, status, job_id, completed_at, completed_by) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1'"
refused_in grid_intake "$I144, 'active', NULL, 'paused', NULL, NULL, NULL)" "project_intakes_status_known" "an unknown status was accepted"
refused_in grid_intake "$I144, 'archive', NULL, 'waiting', NULL, NULL, NULL)" "project_intakes_mode_known" "an unknown mode was accepted"
refused_in grid_intake "$I144, 'closing', NULL, 'waiting', NULL, NULL, NULL)" "project_intakes_closing_when_closing" "a closing intake without its intent was accepted"
refused_in grid_intake "$I144, 'active', '{\"outcome\":\"completed\",\"endedOn\":\"2024-06\"}', 'waiting', NULL, NULL, NULL)" "project_intakes_closing_when_closing" "an active intake with a closing intent was accepted"
refused_in grid_intake "$I144, 'closing', '[]', 'waiting', NULL, NULL, NULL)" "project_intakes_closing_object" "a closing intent that is not an object was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'reading', NULL, NULL, NULL)" "project_intakes_job_when_reading" "a reading without its job was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'completed', NULL, NULL, NULL)" "project_intakes_completion_complete" "a completion by nobody at no time was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'completed', NULL, now(), NULL)" "project_intakes_completion_complete" "a completion by nobody was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'ready', NULL, now(), 'user_1')" "project_intakes_completion_complete" "a completion on an intake still under review was accepted"
refused_in grid_intake "$I144, 'active', NULL, 'reading', 'job_0144', NULL, NULL)" "uniq_project_intakes_job" "one job reading for two intakes was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by) VALUES ('org_0144', 'aaaaaaaa-0000-4000-8000-000000000144', 'user_1')" "uniq_project_intakes_project" "a second intake for one project was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by) VALUES ('org_0144', 'bbbbbbbb-0000-4000-8000-000000000144', 'user_1')" "project_intakes_project_fkey" "another organization's project was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, documents_read) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', '{}')" "project_intakes_documents_read_array" "a read list that is not a list was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, dismissed) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', 'null')" "project_intakes_dismissed_array" "dismissed values that are not a list were accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, location) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', '\"Wien\"')" "project_intakes_location_object" "a location that is not an object was accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, counts) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', '[]')" "project_intakes_counts_object" "counts that are not an object were accepted"
refused_in grid_intake "INSERT INTO project_intakes (organization_id, project_id, created_by, description) VALUES ('org_0144', 'dddddddd-0000-4000-8000-000000000144', 'user_1', repeat('x', 501))" "project_intakes_description_length" "a description over 500 characters was accepted"
# A finished review: a reading that ends and is completed by somebody at some time.
sql_in grid_intake <<<"UPDATE project_intakes SET status = 'completed', completed_at = now(), completed_by = 'user_1' WHERE project_id = 'cccccccc-0000-4000-8000-000000000144'"
check_in grid_intake "SELECT status FROM project_intakes WHERE project_id = 'cccccccc-0000-4000-8000-000000000144'" "completed" "a review completes, keeping its last job"
sql_in grid_intake <<<"DELETE FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000144'"
check_in grid_intake "SELECT count(*) FROM project_intakes" "1" "an intake goes with its project"
apply_in grid_intake 0144_project_intakes.down.sql
check_in grid_intake "SELECT count(*) FROM information_schema.tables WHERE table_name = 'project_intakes'" "0" "down dropped project_intakes"
check_in grid_intake "SELECT count(*) FROM projects WHERE organization_id = 'org_0144'" "2" "down left the projects"
apply_in grid_intake 0144_project_intakes.sql
apply_in grid_intake 0144_project_intakes.sql
check_in grid_intake "SELECT count(*) FROM project_intakes" "0" "0144 re-applies, twice, empty"
echo "==> 0144 project intakes and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0145: a folder's description, and the DOWN.
#
# On a database of its own, migrated to 0144. A folder on either shelf may say
# what belongs in it; a description is never blank and at most 500 characters.
# ---------------------------------------------------------------------------
echo "==> verifying the 0145 folder descriptions and their down migration on grid_fdesc"
migrate_until grid_fdesc 0144_project_intakes
sql_in grid_fdesc <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000145', 'org_0145', 'Ablage 0145', 'user_1', 'proj_0145');
INSERT INTO project_folders (id, organization_id, project_id, scope, name, path)
VALUES ('f1f1f1f1-0000-4000-8000-000000000145', 'org_0145', 'aaaaaaaa-0000-4000-8000-000000000145', 'project', 'Bescheide', 'Bescheide'),
       ('f2f2f2f2-0000-4000-8000-000000000145', 'org_0145', NULL, 'archiv', 'Normen', 'Normen');
SQL
apply_in grid_fdesc 0145_folder_descriptions.sql
check_in grid_fdesc "SELECT count(*) FROM project_folders WHERE description IS NULL" "2" "0145 leaves every folder undescribed"
sql_in grid_fdesc <<<"UPDATE project_folders SET description = 'Bescheide und Stellungnahmen der Behörden' WHERE name = 'Bescheide'"
sql_in grid_fdesc <<<"UPDATE project_folders SET description = 'ÖNORMEN, die das Büro gekauft hat' WHERE name = 'Normen'"
check_in grid_fdesc "SELECT count(*) FROM project_folders WHERE description IS NOT NULL" "2" "a project folder and a Büroablage folder each take a description"
refused_in grid_fdesc "UPDATE project_folders SET description = '   ' WHERE name = 'Bescheide'" "project_folders_description_length" "a blank description was accepted"
refused_in grid_fdesc "UPDATE project_folders SET description = '' WHERE name = 'Bescheide'" "project_folders_description_length" "an empty description was accepted"
refused_in grid_fdesc "UPDATE project_folders SET description = repeat('x', 501) WHERE name = 'Bescheide'" "project_folders_description_length" "a description over 500 characters was accepted"
apply_in grid_fdesc 0145_folder_descriptions.down.sql
check_in grid_fdesc "SELECT count(*) FROM information_schema.columns WHERE table_name = 'project_folders' AND column_name = 'description'" "0" "down dropped the description"
check_in grid_fdesc "SELECT count(*) FROM project_folders" "2" "down kept the folders"
apply_in grid_fdesc 0145_folder_descriptions.sql
apply_in grid_fdesc 0145_folder_descriptions.sql
check_in grid_fdesc "SELECT count(*) FROM project_folders WHERE description IS NULL" "2" "0145 re-applies, twice"
echo "==> 0145 folder descriptions and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0146: proposals on the Büroablage, the trace, the CHECKs, the
# re-secured policy, and the DOWN.
#
# On a database of its own, migrated to 0145. A proposal is on a project
# exactly when it has one; a Büroablage proposal only moves Büroablage
# documents; the runtime role sees its own organization's Büroablage proposals
# and no other's.
# ---------------------------------------------------------------------------
echo "==> verifying the 0146 proposal shelves and their down migration on grid_pshelf"
migrate_until grid_pshelf 0145_folder_descriptions
sql_in grid_pshelf <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000146', 'org_0146', 'Ablage 0146', 'user_1', 'proj_0146');
INSERT INTO proposed_changes (id, organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of)
VALUES ('c1c1c1c1-0000-4000-8000-000000000146', 'org_0146', 'aaaaaaaa-0000-4000-8000-000000000146', 'file_operation',
        '{"operation":"move","operations":[{"document":"a.pdf","target_folder":"Bescheide"}]}', 'piloti', 'user_1');
SQL
apply_in grid_pshelf 0146_proposal_shelves.sql
check_in grid_pshelf "SELECT scope || ':' || (origin_trace_id IS NULL)::text FROM proposed_changes" "project:true" "0146 puts every existing proposal on its project's shelf"
sql_in grid_pshelf <<'SQL'
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of, origin_trace_id)
VALUES ('c2c2c2c2-0000-4000-8000-000000000146', 'org_0146', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"Norm.pdf","source":"buero","target_folder":"Normen"}],"basis":"name"}', 'piloti', 'user_1', 'abcdef0123456789abcdef0123456789'),
       ('c3c3c3c3-0000-4000-8000-000000000146', 'org_other', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"Fremd.pdf","source":"buero","target_folder":"Fremd"}]}', 'piloti', 'user_9', NULL);
SQL
check_in grid_pshelf "SELECT count(*) FROM proposed_changes WHERE scope = 'archiv'" "2" "a Büroablage move is stored without a project"
P146="INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0146'"
refused_in grid_pshelf "$P146, NULL, 'regal', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"buero\"}]}', 'piloti', 'user_1')" "proposed_changes_scope_known" "an unknown shelf was accepted"
refused_in grid_pshelf "$P146, NULL, 'project', 'file_operation', '{\"operation\":\"move\",\"operations\":[]}', 'piloti', 'user_1')" "proposed_changes_scope_owner" "a project proposal without its project was accepted"
refused_in grid_pshelf "$P146, 'aaaaaaaa-0000-4000-8000-000000000146', 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"buero\"}]}', 'piloti', 'user_1')" "proposed_changes_scope_owner" "a Büroablage proposal naming a project was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'memory', '{}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage proposal of another kind was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"create_folder\",\"operations\":[{\"folder_name\":\"X\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage proposal that is not a move was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"projekt\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move of a project document was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move of an item without its shelf was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"buero\"},{\"document\":\"b.pdf\",\"source\":\"projekt\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move with one project item was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\"}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move without items was accepted"
refused_in grid_pshelf "$P146, NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "a Büroablage move of no items was accepted"
check_in grid_pshelf "SELECT pg_get_expr(polqual, polrelid) LIKE '%project_id IS NULL%' FROM pg_policy WHERE polname = 'grid_tenant_isolation' AND polrelid = 'proposed_changes'::regclass" "t" "0146 re-secures proposed_changes with the Büroablage arm"
check_in grid_pshelf "SELECT count(*) FROM pg_policy WHERE polrelid = 'proposed_changes'::regclass" "1" "proposed_changes keeps exactly one policy"
# The runtime role, inside one tenant: its own Büroablage proposal, not the other organization's.
RW146=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_pshelf -qtA \
  -c "SET grid.organization_id = 'org_0146'" \
  -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM proposed_changes WHERE scope = 'archiv'")
if [ "$RW146" != "c2c2c2c2-0000-4000-8000-000000000146" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_pshelf: the runtime role saw another organization's Büroablage proposal, or not its own (got: $RW146)" >&2
  exit 1
fi
apply_in grid_pshelf 0146_proposal_shelves.down.sql
check_in grid_pshelf "SELECT string_agg(id::text, ',') FROM proposed_changes" "c1c1c1c1-0000-4000-8000-000000000146" "down deleted the Büroablage proposals, and only those"
check_in grid_pshelf "SELECT count(*) FROM information_schema.columns WHERE table_name = 'proposed_changes' AND column_name IN ('scope', 'origin_trace_id')" "0" "down dropped the shelf and the trace"
refused_in grid_pshelf "INSERT INTO proposed_changes (organization_id, project_id, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0146', NULL, 'file_operation', '{}', 'piloti', 'user_1')" "null value" "down left the project optional"
apply_in grid_pshelf 0146_proposal_shelves.sql
apply_in grid_pshelf 0146_proposal_shelves.sql
check_in grid_pshelf "SELECT count(*) FROM proposed_changes" "1" "0146 re-applies, twice"
echo "==> 0146 proposal shelves and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0148: a held document's reason as a typed verdict (ADR-0113), and
# its DOWN. The backfill converts each quarantined row's `quarantined:` message
# row by row and leaves a row whose message does not parse NULL without
# stopping; the CHECKs hold the column to an object with a `reasons` array and
# to quarantined rows, so the release that ends a quarantine must clear it; a
# decision records how many reasons the job left out.
# ---------------------------------------------------------------------------
echo "==> verifying the 0148 quarantine verdict, its backfill and the down migration on grid_qverdict"
migrate_until grid_qverdict 0147_push_subscriptions
sql_in grid_qverdict <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000148', 'org_0148', 'Verdict 0148', 'user_1', 'proj_0148');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, content_hash, screening_outcome, error_message) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'lohn.pdf', 'k/0148/lohn', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:lohn', 'quarantined',
   'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":2,"pages":[1,3]},{"kind":"iban","count":1,"pages":[2],"sample":"AT61 •••• •••• •••• 3201"}],"checked":"full","omitted":3}'),
  ('d2d2d2d2-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'kaputt.pdf', 'k/0148/kaputt', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:kaputt', 'quarantined',
   'quarantined:{not json'),
  ('d3d3d3d3-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'form.pdf', 'k/0148/form', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:form', 'quarantined',
   'quarantined:{"reasons":"none"}'),
  ('d4d4d4d4-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'plan.pdf', 'k/0148/plan', 'proj_0148', 'failed', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:plan', NULL,
   'quarantined:{"reasons":[],"checked":"full"}'),
  ('d5d5d5d5-0000-4000-8000-000000000148', 'org_0148', 'user_1', 'brief.pdf', 'k/0148/brief', 'proj_0148', 'quarantined', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'sha256:brief', 'quarantined',
   NULL);
INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, project_id, filename, reasons, uploaded_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000148', 'org_0148', 'd1d1d1d1-0000-4000-8000-000000000148', 'job-0148', 'project', 'aaaaaaaa-0000-4000-8000-000000000148', 'lohn.pdf', 'term:Lohnzettel,iban', 'user_1');
SQL
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
check_in grid_qverdict "SELECT quarantine->'reasons'->0->>'term' || ',' || (quarantine->>'omitted') || ',' || (quarantine->'reasons'->1->>'sample') FROM documents WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148'" "Lohnzettel,3,AT61 •••• •••• •••• 3201" "the backfill stores a quarantined row's verdict as data"
check_in grid_qverdict "SELECT string_agg(filename, ',' ORDER BY filename) FROM documents WHERE organization_id = 'org_0148' AND quarantine IS NULL" "brief.pdf,form.pdf,kaputt.pdf,plan.pdf" "a message that is not JSON, a verdict of the wrong shape, a row that is not held and one with no message stay NULL"
check_in grid_qverdict "SELECT count(*) FROM documents WHERE organization_id = 'org_0148' AND error_message LIKE 'quarantined:%'" "4" "the backfill leaves every message for the builds that still read it"
check_in grid_qverdict "SELECT reasons_omitted FROM document_quarantine_decisions WHERE id = 'f1f1f1f1-0000-4000-8000-000000000148'" "0" "an existing decision left nothing out that it knew of"
refused_in grid_qverdict "UPDATE documents SET quarantine = '[]'::jsonb WHERE id = 'd5d5d5d5-0000-4000-8000-000000000148';" "documents_quarantine_shape_check" "a verdict that is not an object was accepted"
refused_in grid_qverdict "UPDATE documents SET quarantine = '{\"checked\":\"full\"}'::jsonb WHERE id = 'd5d5d5d5-0000-4000-8000-000000000148';" "documents_quarantine_shape_check" "a verdict without reasons was accepted"
refused_in grid_qverdict "UPDATE documents SET quarantine = '{\"reasons\":[]}'::jsonb WHERE id = 'd4d4d4d4-0000-4000-8000-000000000148';" "documents_quarantine_held_check" "a verdict on a row that is not quarantined was accepted"
refused_in grid_qverdict "UPDATE documents SET status = 'uploaded', screening_outcome = 'released', screening_released_hash = 'sha256:lohn', screening_released_by = 'user_2', screening_released_at = now() WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148';" "documents_quarantine_held_check" "a release that keeps the verdict was accepted"
sql_in grid_qverdict <<<"UPDATE documents SET status = 'uploaded', error_message = NULL, quarantine = NULL, screening_outcome = 'released', screening_released_hash = 'sha256:lohn', screening_released_by = 'user_2', screening_released_at = now() WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148';"
check_in grid_qverdict "SELECT status FROM documents WHERE id = 'd1d1d1d1-0000-4000-8000-000000000148'" "uploaded" "the release that clears the verdict passes the hold"
refused_in grid_qverdict "INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by, reasons_omitted) VALUES ('org_0148', gen_random_uuid(), 'job-x', 'archiv', 'x.pdf', 'u', -1);" "document_quarantine_decisions_reasons_omitted_check" "a negative count of left-out reasons was accepted"
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
check_in grid_qverdict "SELECT count(*) FROM documents WHERE organization_id = 'org_0148' AND quarantine IS NOT NULL" "0" "0148 re-applies and backfills no released row"
apply_in grid_qverdict 0148_document_quarantine_verdict.down.sql
check_in grid_qverdict "SELECT count(*) FROM information_schema.columns WHERE (table_name = 'documents' AND column_name = 'quarantine') OR (table_name = 'document_quarantine_decisions' AND column_name = 'reasons_omitted')" "0" "down dropped both columns"
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
apply_in grid_qverdict 0148_document_quarantine_verdict.sql
check_in grid_qverdict "SELECT count(*) FROM pg_constraint WHERE conname IN ('documents_quarantine_shape_check', 'documents_quarantine_held_check', 'document_quarantine_decisions_reasons_omitted_check')" "3" "0148 re-applies, twice"
echo "==> 0148 quarantine verdict and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0150: whom an Anmerkung or a reply mentions, the CHECKs, and the
# DOWN.
#
# On a database of its own, migrated to 0149. Every mark and reply written
# before mentions nobody; a mention list is an array of at most ten, on both
# tables; the down drops both columns and leaves the marks and their threads.
# ---------------------------------------------------------------------------
echo "==> verifying the 0150 mentions on marks and replies and their down migration on grid_mention"
migrate_until grid_mention 0149_piloti_wakes_document_idx
sql_in grid_mention <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000150', 'org_0150', 'Erwähnen 0150', 'user_1', 'proj_0150');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000150', 'org_0150', 'user_1', 'a.pdf', 'k/0150/a', 'proj_0150', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000150');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000150', 'org_0150', 'd1d1d1d1-0000-4000-8000-000000000150', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO document_annotation_replies (organization_id, annotation_id, author_kind, body, created_by)
VALUES ('org_0150', 'f1f1f1f1-0000-4000-8000-000000000150', 'person', 'Vor 0150 geschrieben', 'user_2');
SQL
apply_in grid_mention 0150_annotation_mentions.sql
check_in grid_mention "SELECT (SELECT string_agg(mentions::text, ',') FROM document_annotations) || '|' || (SELECT string_agg(mentions::text, ',') FROM document_annotation_replies)" "[]|[]" "a mark and a reply written before 0150 mention nobody"
sql_in grid_mention <<<"UPDATE document_annotations SET mentions = '[{\"targetId\":\"user_2\",\"display\":\"Anna Berger\"}]' WHERE number = 1"
sql_in grid_mention <<<"UPDATE document_annotation_replies SET mentions = '[{\"targetId\":\"agent:piloti\",\"display\":\"Piloti\"}]'"
check_in grid_mention "SELECT mentions->0->>'display' FROM document_annotations WHERE number = 1" "Anna Berger" "a mark keeps whom it mentions"
refused_in grid_mention "UPDATE document_annotations SET mentions = '{\"targetId\":\"user_2\"}' WHERE number = 1" "document_annotations_mentions_bounded" "a mark's mentions that are not an array were accepted"
refused_in grid_mention "UPDATE document_annotations SET mentions = (SELECT jsonb_agg(jsonb_build_object('targetId', 'user_' || n, 'display', 'P' || n)) FROM generate_series(1, 11) AS n) WHERE number = 1" "document_annotations_mentions_bounded" "a mark mentioning eleven people was accepted"
refused_in grid_mention "UPDATE document_annotation_replies SET mentions = '\"user_2\"'" "document_annotation_replies_mentions_bounded" "a reply's mentions that are not an array were accepted"
refused_in grid_mention "UPDATE document_annotation_replies SET mentions = (SELECT jsonb_agg(jsonb_build_object('targetId', 'user_' || n, 'display', 'P' || n)) FROM generate_series(1, 11) AS n)" "document_annotation_replies_mentions_bounded" "a reply mentioning eleven people was accepted"
refused_in grid_mention "UPDATE document_annotation_replies SET mentions = NULL" "null value" "a reply without a mention list was accepted"
apply_in grid_mention 0150_annotation_mentions.down.sql
check_in grid_mention "SELECT count(*) FROM information_schema.columns WHERE column_name = 'mentions' AND table_name IN ('document_annotations', 'document_annotation_replies')" "0" "down dropped both columns"
check_in grid_mention "SELECT (SELECT count(*) FROM document_annotations) || ':' || (SELECT count(*) FROM document_annotation_replies)" "1:1" "down left the marks and their threads"
apply_in grid_mention 0150_annotation_mentions.sql
apply_in grid_mention 0150_annotation_mentions.sql
check_in grid_mention "SELECT string_agg(mentions::text, ',') FROM document_annotation_replies" "[]" "0150 re-applies, twice"
echo "==> 0150 mentions and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0151: a mark carried on to the document that replaced its own, the
# index the daily due reminder reads by, and the DOWN.
#
# On a database of its own, migrated to 0150. A mark written before carries
# from nothing; a carried mark points back at its source, never at itself;
# one source is carried once, whatever raced; deleting the source leaves the
# carried mark standing without its link; the down drops the column and the
# indexes and leaves both marks.
# ---------------------------------------------------------------------------
echo "==> verifying the 0151 carried marks and their down migration on grid_carry"
migrate_until grid_carry 0150_annotation_mentions
sql_in grid_carry <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000151', 'org_0151', 'Weitertragen 0151', 'user_1', 'proj_0151');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000151', 'org_0151', 'user_1', 'Index B.pdf', 'k/0151/b', 'proj_0151', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000151'),
       ('d2d2d2d2-0000-4000-8000-000000000151', 'org_0151', 'user_1', 'Index C.pdf', 'k/0151/c', 'proj_0151', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000151');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by, assignee_user_id, due_on)
VALUES ('f1f1f1f1-0000-4000-8000-000000000151', 'org_0151', 'd1d1d1d1-0000-4000-8000-000000000151', 4, 1, 'point', 0.5, 0.5, 'defect', 'Brüstung', 'person', 'open', 'user_1', 'user_2', '2026-10-24');
SQL
apply_in grid_carry 0151_annotation_carry_and_due.sql
check_in grid_carry "SELECT coalesce(carried_from_id::text, 'null') FROM document_annotations" "null" "a mark written before 0151 carries from nothing"
sql_in grid_carry <<'SQL'
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by, carried_from_id)
VALUES ('f2f2f2f2-0000-4000-8000-000000000151', 'org_0151', 'd2d2d2d2-0000-4000-8000-000000000151', 1, 1, 'point', 0.5, 0.5, 'defect', 'Brüstung', 'person', 'open', 'user_1', 'f1f1f1f1-0000-4000-8000-000000000151');
SQL
C150="INSERT INTO document_annotations (organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by, carried_from_id) VALUES ('org_0151', 'd2d2d2d2-0000-4000-8000-000000000151'"
refused_in grid_carry "$C150, 2, 1, 'point', 0.5, 0.5, 'defect', 'x', 'person', 'open', 'user_1', 'f1f1f1f1-0000-4000-8000-000000000151')" "uniq_document_annotations_carried_from" "a mark was carried twice"
refused_in grid_carry "UPDATE document_annotations SET carried_from_id = id WHERE number = 1" "document_annotations_carried_from_other" "a mark was carried from itself"
refused_in grid_carry "$C150, 3, 1, 'point', 0.5, 0.5, 'defect', 'x', 'person', 'open', 'user_1', 'f9f9f9f9-0000-4000-8000-000000000151')" "document_annotations_carried_from_fkey" "a mark was carried from a mark that does not exist"
check_in grid_carry "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_document_annotations_due'" "1" "0151 builds the due index"
sql_in grid_carry <<<"DELETE FROM document_annotations WHERE id = 'f1f1f1f1-0000-4000-8000-000000000151'"
check_in grid_carry "SELECT number || ':' || coalesce(carried_from_id::text, 'null') FROM document_annotations" "1:null" "deleting the source leaves the carried mark without its link"
apply_in grid_carry 0151_annotation_carry_and_due.down.sql
check_in grid_carry "SELECT count(*) FROM information_schema.columns WHERE column_name = 'carried_from_id' AND table_name = 'document_annotations'" "0" "down dropped the column"
check_in grid_carry "SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_document_annotations_due', 'uniq_document_annotations_carried_from')" "0" "down dropped both indexes"
check_in grid_carry "SELECT count(*) FROM document_annotations" "1" "down left the marks"
apply_in grid_carry 0151_annotation_carry_and_due.sql
apply_in grid_carry 0151_annotation_carry_and_due.sql
check_in grid_carry "SELECT coalesce(carried_from_id::text, 'null') FROM document_annotations" "null" "0151 re-applies, twice"
echo "==> 0151 carried marks and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0152: when a reply was last changed by its author, its CHECK, and
# the DOWN.
#
# On a database of its own, migrated to 0151. A reply written before was never
# edited; an edit stamped by the database's clock passes; an edit before the
# reply was written is refused; the down drops the column and leaves the
# reply with its words.
# ---------------------------------------------------------------------------
echo "==> verifying the 0152 reply edits and their down migration on grid_reply_edit"
migrate_until grid_reply_edit 0151_annotation_carry_and_due
sql_in grid_reply_edit <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000152', 'org_0152', 'Bearbeiten 0152', 'user_1', 'proj_0152');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000152', 'org_0152', 'user_1', 'a.pdf', 'k/0152/a', 'proj_0152', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000152');
INSERT INTO document_annotations (id, organization_id, document_id, number, page, shape, x, y, kind, body, author_kind, status, created_by)
VALUES ('f1f1f1f1-0000-4000-8000-000000000152', 'org_0152', 'd1d1d1d1-0000-4000-8000-000000000152', 1, 1, 'point', 0.5, 0.5, 'defect', 'Türbreite', 'person', 'open', 'user_1');
INSERT INTO document_annotation_replies (id, organization_id, annotation_id, author_kind, body, created_by)
VALUES ('e1e1e1e1-0000-4000-8000-000000000152', 'org_0152', 'f1f1f1f1-0000-4000-8000-000000000152', 'person', 'Vor 0152 geschrieben', 'user_2');
SQL
apply_in grid_reply_edit 0152_annotation_reply_edits.sql
check_in grid_reply_edit "SELECT coalesce(edited_at::text, 'null') FROM document_annotation_replies" "null" "a reply written before 0152 was never edited"
sql_in grid_reply_edit <<<"UPDATE document_annotation_replies SET body = 'Nachher', edited_at = now()"
check_in grid_reply_edit "SELECT body || ':' || (edited_at IS NOT NULL)::text FROM document_annotation_replies" "Nachher:true" "an edit stamped by the database's clock passes"
refused_in grid_reply_edit "UPDATE document_annotation_replies SET edited_at = created_at - interval '1 second'" "document_annotation_replies_edited_after_created" "an edit before the reply was written was accepted"
apply_in grid_reply_edit 0152_annotation_reply_edits.down.sql
check_in grid_reply_edit "SELECT count(*) FROM information_schema.columns WHERE column_name = 'edited_at' AND table_name = 'document_annotation_replies'" "0" "down dropped the column"
check_in grid_reply_edit "SELECT body FROM document_annotation_replies" "Nachher" "down left the reply with its words"
apply_in grid_reply_edit 0152_annotation_reply_edits.sql
apply_in grid_reply_edit 0152_annotation_reply_edits.sql
check_in grid_reply_edit "SELECT coalesce(edited_at::text, 'null') FROM document_annotation_replies" "null" "0152 re-applies, twice"
echo "==> 0152 reply edits and down migration verified"

# ---------------------------------------------------------------------------
# On a database of its own, migrated to 0156. An intake written before 0157
# has opened nothing; a reading's files are an array and nothing else; the
# down drops the column and leaves the intake; the up re-applies, twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0157 reading files and their down migration on grid_rfiles"
migrate_until grid_rfiles 0156_organization_default_locale_unset
sql_in grid_rfiles <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000156', 'org_0156', 'Erfassung 0156', 'user_1', 'proj_0156');
INSERT INTO project_intakes (organization_id, project_id, created_by, status, job_id, requested_by)
VALUES ('org_0156', 'aaaaaaaa-0000-4000-8000-000000000156', 'user_1', 'reading', 'job_0156', 'user_1');
SQL
apply_in grid_rfiles 0157_intake_reading_files.sql
check_in grid_rfiles "SELECT reading_files::text FROM project_intakes" "[]" "an intake written before 0156 has opened nothing"
sql_in grid_rfiles <<<"UPDATE project_intakes SET reading_files = '[\"Einreichplan.pdf\"]'::jsonb"
check_in grid_rfiles "SELECT reading_files->>0 FROM project_intakes" "Einreichplan.pdf" "a reading's opened files are stored"
refused_in grid_rfiles "UPDATE project_intakes SET reading_files = '{\"a\":1}'::jsonb" "project_intakes_reading_files_array" "reading files that are not an array were accepted"
apply_in grid_rfiles 0157_intake_reading_files.down.sql
check_in grid_rfiles "SELECT count(*) FROM information_schema.columns WHERE column_name = 'reading_files' AND table_name = 'project_intakes'" "0" "down dropped the column"
check_in grid_rfiles "SELECT status FROM project_intakes" "reading" "down left the intake"
apply_in grid_rfiles 0157_intake_reading_files.sql
apply_in grid_rfiles 0157_intake_reading_files.sql
check_in grid_rfiles "SELECT reading_files::text FROM project_intakes" "[]" "0156 re-applies, twice"
echo "==> 0157 reading files and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0163: the names stored in a message's metadata become English, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0163, seeded with one
# assistant message that holds every family the migration rewrites in its OLD
# spelling (findings, a callout, the run ledger, citations, the Herleitung's
# lanes and locator event, quote stamps, cards and a surface), one that is
# already English, and one with an old-looking word on a path the migration does
# not own. The up rewrites exactly the first, a second run changes nothing, the
# down restores the old spellings byte for byte on those paths, and the up
# re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0163 message metadata names and their down migration on grid_msgnames"
migrate_before grid_msgnames 0163_message_metadata_english
sql_in grid_msgnames <<'SQL'
INSERT INTO conversations (id, organization_id, created_by) VALUES ('s_0162', 'org_0162', 'user_1');
INSERT INTO messages (id, conversation_id, organization_id, role, content, metadata) VALUES
  ('a0000000-0000-4000-8000-000000000162', 's_0162', 'org_0162', 'assistant', 'Bericht', '{
    "findings": {"v": 1, "items": [
      {"requirement": "R", "status": "nicht_erfuellt", "grounding": "abgeleitet"},
      {"requirement": "S", "status": "offen", "grounding": "offen"},
      {"requirement": "T", "grounding": "belegt"}]},
    "answerMeta": {"v": 1, "callout": {"kind": "frist", "text": "Binnen sechs Wochen."}},
    "run_ledger": {"runId": "r1", "status": "laeuft",
      "phases": [{"phase": "planen", "startedAt": "2026-01-01T00:00:00.000Z", "endedAt": "2026-01-01T00:01:00.000Z"},
                 {"phase": "recherchieren", "startedAt": "2026-01-01T00:01:00.000Z"}],
      "steps": [{"id": "runde-1", "phase": "recherchieren", "intent": "x", "startedAt": "2026-01-01T00:01:00.000Z", "docs": []}],
      "error": {"reason": "x", "completedBefore": ["planen"]},
      "grundlage": [{"name": "a.pdf", "loci": []}],
      "startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:01:00.000Z"},
    "citations": {"v": 1, "sources": [
      {"content": "c", "kind": "baurecht", "lane": "baurecht_oib_leitfaden", "binding_status": "verbindlich_erklaert", "rank": "landesgesetz", "punkt": "3.5.2", "shelf": "archiv"},
      {"content": "d", "kind": "projekt", "lane": "projekt", "binding_status": "unbekannt"}]},
    "provenance": {"degradedReasons": ["grundlage_unread", "no_report_file"],
      "thinkingSteps": [
        {"id": "s1", "userMessageId": "u", "kind": "sources", "traceLanes": [{"key": "buero_piloti", "label": "x", "kind": "buero", "hitCount": 1, "sources": [], "signal": "office"}]},
        {"id": "s2", "userMessageId": "u", "kind": "retrieval", "turnEvent": {"key": "status.retrieval.punkt", "values": {"document": "D", "punkt": "3.1"}}},
        {"id": "s3", "userMessageId": "u", "kind": "retrieval", "turnEvent": {"key": "status.retrieval.plain", "values": {"punkt": "kept"}}}],
      "retrievalLedger": [{"index": 0, "key": "status.retrieval.punkt"}],
      "quoteStamps": [{"text": "q", "status": "verbatim", "punkt": "3.1"}]},
    "cards": [
      {"type": "fire_access_plan", "aufstellflaeche": {"width": 1}, "gebaeudeklasse": "GK 4"},
      {"type": "guardrail_check", "context": "dachterrasse"},
      {"type": "building_section", "markers": [{"label": "F", "height_m": 1, "kind": "fluchtniveau"}, {"label": "G", "height_m": 2, "kind": "threshold"}]},
      {"type": "document_draft", "path": "/entwuerfe/a.md"},
      {"type": "document_grid", "documents": [{"file_name": "a", "source": "buero"}]},
      {"type": "surface", "components": [{"id": "root", "component": "Column", "children": ["g"]}, {"id": "g", "component": "guardrail_check", "context": "balkon"}, {"id": "t", "component": "Text", "text": "x"}]},
      {"type": "calculation", "title": "bleibt", "status": "offen"}]
  }'),
  ('a0000000-0000-4000-8000-000000000163', 's_0162', 'org_0162', 'assistant', 'Neu', '{
    "findings": {"v": 1, "items": [{"requirement": "R", "status": "open", "grounding": "open"}]},
    "run_ledger": {"runId": "r2", "status": "done", "phases": [{"phase": "filed", "startedAt": "2026-01-01T00:00:00.000Z"}], "steps": [], "startedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"},
    "citations": {"v": 1, "sources": [{"content": "c", "kind": "building_law", "lane": "building_law_oib", "clause": "3.5.2"}]}
  }'),
  ('a0000000-0000-4000-8000-000000000164', 's_0162', 'org_0162', 'assistant', 'Fremd', '{
    "note": {"status": "offen", "kind": "baurecht"},
    "cards": [{"type": "calculation", "title": "Rechenweg", "kind": "projekt", "status": "erfuellt"}]
  }'),
  ('a0000000-0000-4000-8000-000000000165', 's_0162', 'org_0162', 'user', 'Frage', NULL);
INSERT INTO citation_events (organization_id, conversation_id, turn_id, agent, kind, severity, detail) VALUES
  ('org_0162', 's_0162', 't1', 'shallow', 'turn_verified', 'info', '{"lanes": {"baurecht_oib": 2, "projekt": 1, "web": 3}, "origins": {"kb": 3}}');
SQL
OLD_0162=$(cat <<'SQL'
SELECT md5(string_agg(coalesce(metadata::text, '-'), '|' ORDER BY id)) FROM messages WHERE id <> 'a0000000-0000-4000-8000-000000000163'
SQL
)
BEFORE_0162=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_msgnames -tAc "$OLD_0162")
apply_in grid_msgnames 0163_message_metadata_english.sql
M_0162="SELECT metadata FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'"
check_in grid_msgnames "SELECT (metadata @> '{\"findings\": {\"items\": [{\"status\": \"not_met\", \"grounding\": \"derived\"}, {\"status\": \"open\", \"grounding\": \"open\"}, {\"grounding\": \"sourced\"}]}}')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "true" "0163 rewrites a finding's status and grounding"
check_in grid_msgnames "SELECT metadata #>> '{answerMeta,callout,kind}' FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "deadline" "0163 rewrites a callout kind"
check_in grid_msgnames "SELECT (metadata #>> '{run_ledger,status}') || ',' || (metadata #>> '{run_ledger,phases,0,phase}') || ',' || (metadata #>> '{run_ledger,phases,1,phase}') || ',' || (metadata #>> '{run_ledger,steps,0,phase}') || ',' || (metadata #>> '{run_ledger,error,completedBefore,0}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "running,planning,researching,researching,planning" "0163 rewrites the run ledger's status and phases"
check_in grid_msgnames "SELECT ((metadata -> 'run_ledger') ? 'grundlage')::text || ',' || (metadata #>> '{run_ledger,basis,0,name}') || ',' || (metadata #>> '{run_ledger,steps,0,id}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "false,a.pdf,runde-1" "0163 renames the ledger's basis key and leaves the step id"
check_in grid_msgnames "SELECT (metadata #>> '{citations,sources,0,kind}') || ',' || (metadata #>> '{citations,sources,0,lane}') || ',' || (metadata #>> '{citations,sources,0,binding_status}') || ',' || (metadata #>> '{citations,sources,0,rank}') || ',' || (metadata #>> '{citations,sources,0,clause}') || ',' || ((metadata #> '{citations,sources,0}') ? 'punkt')::text || ',' || (metadata #>> '{citations,sources,0,shelf}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "building_law,building_law_oib_guide,declared_binding,state_law,3.5.2,false,archiv" "0163 rewrites a citation's kind, lane, binding status, rank and Punkt, and leaves its shelf"
check_in grid_msgnames "SELECT (metadata #>> '{citations,sources,1,kind}') || ',' || (metadata #>> '{citations,sources,1,lane}') || ',' || (metadata #>> '{citations,sources,1,binding_status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "project,project,unknown" "0163 rewrites a project citation"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,degradedReasons}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" '["basis_unread", "no_report_file"]' "0163 rewrites a degraded reason and keeps the others"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,thinkingSteps,0,traceLanes,0,key}') || ',' || (metadata #>> '{provenance,thinkingSteps,0,traceLanes,0,kind}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "office_piloti,office" "0163 rewrites a trace lane's key and kind"
check_in grid_msgnames "SELECT (metadata #> '{provenance,thinkingSteps,1,turnEvent}')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" '{"key": "status.retrieval.clause", "values": {"clause": "3.1", "document": "D"}}' "0163 renames the locator event's key and its value"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,thinkingSteps,2,turnEvent,values,punkt}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "kept" "0163 leaves a value named punkt on another event"
check_in grid_msgnames "SELECT (metadata #>> '{provenance,retrievalLedger,0,key}') || ',' || (metadata #>> '{provenance,quoteStamps,0,clause}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "status.retrieval.clause,3.1" "0163 rewrites the ledger's key and a quote stamp's Punkt"
check_in grid_msgnames "SELECT (metadata #>> '{cards,0,staging_area,width}') || ',' || (metadata #>> '{cards,0,building_class}') || ',' || ((metadata #> '{cards,0}') ? 'aufstellflaeche')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "1,GK 4,false" "0163 renames a fire access card's fields"
check_in grid_msgnames "SELECT (metadata #>> '{cards,1,context}') || ',' || (metadata #>> '{cards,2,markers,0,kind}') || ',' || (metadata #>> '{cards,2,markers,1,kind}') || ',' || (metadata #>> '{cards,3,path}') || ',' || (metadata #>> '{cards,4,documents,0,source}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "roof_terrace,escape_level,threshold,/drafts/a.md,office" "0163 rewrites a railing context, a section marker, a draft path and a document source"
check_in grid_msgnames "SELECT (metadata #>> '{cards,5,components,1,context}') || ',' || (metadata #>> '{cards,5,components,2,text}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" "balcony,x" "0163 rewrites a card inside a surface"
check_in grid_msgnames "SELECT (metadata #> '{cards,6}')::text FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000162'" '{"type": "calculation", "title": "bleibt", "status": "offen"}' "0163 leaves a card it has no rule for"
check_in grid_msgnames "SELECT (metadata #>> '{run_ledger,status}') || ',' || (metadata #>> '{findings,items,0,status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000163'" "done,open" "0163 leaves English metadata alone"
check_in grid_msgnames "SELECT (metadata #> '{note}')::text || (metadata #>> '{cards,0,kind}') || (metadata #>> '{cards,0,status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000164'" '{"kind": "baurecht", "status": "offen"}projekterfuellt' "0163 leaves an old-looking word on a path it does not own"
check_in grid_msgnames "SELECT count(*) FROM messages WHERE metadata IS NULL" "1" "0163 leaves a message without metadata alone"
check_in grid_msgnames "SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(detail -> 'lanes') k) FROM citation_events WHERE conversation_id = 's_0162'" "building_law_oib,project,web" "0163 renames the lane keys of a citation event and keeps their counts"
AFTER_ONCE_0162=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_msgnames -tAc "$OLD_0162")
apply_in grid_msgnames 0163_message_metadata_english.sql
check_in grid_msgnames "$OLD_0162" "$AFTER_ONCE_0162" "0163 changes nothing the second time"
apply_in grid_msgnames 0163_message_metadata_english.down.sql
check_in grid_msgnames "$OLD_0162" "$BEFORE_0162" "down restores every stored byte of the metadata the migration took"
check_in grid_msgnames "SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(detail -> 'lanes') k) FROM citation_events WHERE conversation_id = 's_0162'" "baurecht_oib,projekt,web" "down restores a citation event's lane keys"
check_in grid_msgnames "SELECT (metadata #>> '{run_ledger,status}') || ',' || (metadata #>> '{findings,items,0,status}') FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000163'" "fertig,offen" "down turns a message the new build wrote back into German too"
apply_in grid_msgnames 0163_message_metadata_english.sql
apply_in grid_msgnames 0163_message_metadata_english.sql
check_in grid_msgnames "$OLD_0162" "$AFTER_ONCE_0162" "0163 re-applies, twice"
echo "==> 0163 message metadata names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0164: the research plan's stored keys and values become English, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0164. A plan preview
# whose fence holds the old keys and values (and prose OUTSIDE the fence that
# mentions the same words), the reader's `approve {…}` reply as a user message
# and as the card's stored answer, a task, a standing task and a run that froze
# the reader's documents, and a Büroablage proposal whose payload names its
# shelf. The up rewrites the fence and the reply as text (nothing else in the
# message), the documents' keys, the payloads and the CHECK that reads them; a
# second run changes nothing; the down restores the bytes; the up re-applies
# twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0164 plan names and their down migration on grid_plannames"
migrate_before grid_plannames 0164_plan_documents_english
sql_in grid_plannames <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000163', 'org_0163', 'Plan 0164', 'user_1', 'proj_0163');
INSERT INTO conversations (id, organization_id, created_by, project_id) VALUES ('s_0163', 'org_0163', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000163');
INSERT INTO messages (id, conversation_id, organization_id, role, content, metadata) VALUES
  ('a0000000-0000-4000-8000-000000000263', 's_0163', 'org_0163', 'assistant',
   E'**Research Plan Preview**\n\nDie grundlage ist unklar: "grundlage": kein Schluessel hier.\n\n```plan_json\n{"title": "Pruefung \\"grundlage\\": x", "sections": ["A"], "genre": "pruefbericht", "depth": "kurzpruefung", "grundlage": ["Einreichplan.pdf"], "ausgeschlossen": [], "unterlagen": [{"name": "Einreichplan.pdf"}]}\n```\n\n---\nReply **approve**',
   NULL),
  ('a0000000-0000-4000-8000-000000000264', 's_0163', 'org_0163', 'user',
   'approve {"sections":["A"],"genre":"aktenvermerk","depth":"gutachten","grundlage":["a.pdf"],"ausgeschlossen":["b.pdf"],"data_sources":["knowledge_base"]}', NULL),
  ('a0000000-0000-4000-8000-000000000265', 's_0163', 'org_0163', 'assistant', 'Plan', '{"promptState": {"response": "approve {\"genre\":\"vergleich\",\"grundlage\":[]}", "respondedAt": "2026-01-01T00:00:00.000Z"}}'),
  ('a0000000-0000-4000-8000-000000000266', 's_0163', 'org_0163', 'assistant', E'Ein ```plan_json\n{"genre": "report", "basis": []}\n```', NULL),
  ('a0000000-0000-4000-8000-000000000267', 's_0163', 'org_0163', 'user', 'Bitte "grundlage": pruefen, genre pruefbericht', NULL);
INSERT INTO tasks (id, organization_id, project_id, kind, title, plan, requester_user_id) VALUES
  ('eeeeeeee-0000-4000-8000-000000000163', 'org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Dokument',
   '{"prompt": "x", "skill": {}, "dataSources": null, "documents": {"grundlage": [{"name": "a.pdf", "shelf": "project"}], "ausgeschlossen": [{"name": "b.pdf"}]}}', 'user_1'),
  ('eeeeeeee-0000-4000-8000-000000000164', 'org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Ohne',
   '{"prompt": "x", "skill": {}, "dataSources": null}', 'user_1');
INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger) VALUES
  ('org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Dokument',
   '{"prompt": "x", "skill": {}, "dataSources": null, "documents": {"grundlage": [{"name": "a.pdf"}], "ausgeschlossen": []}}', 'user_1', 'manual');
INSERT INTO task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot) VALUES
  ('org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'document', 'Dokument',
   '{"prompt": "x", "skill": {}, "dataSources": null, "documents": {"grundlage": [], "ausgeschlossen": [{"name": "c.pdf"}]}}', 'user_1', 'delegated', 'succeeded', '{}');
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('c1c1c1c1-0000-4000-8000-000000000163', 'org_0163', NULL, 'archiv', 'file_operation',
   '{"operation": "move", "operations": [{"document": "a.pdf", "source": "buero", "target_folder": "x"}, {"document": "b.pdf", "source": "buero"}]}', 'piloti', 'user_1'),
  ('c1c1c1c1-0000-4000-8000-000000000164', 'org_0163', 'aaaaaaaa-0000-4000-8000-000000000163', 'project', 'file_operation',
   '{"operation": "move", "operations": [{"document": "c.pdf", "source": "projekt", "target_folder": "x"}]}', 'piloti', 'user_1');
SQL
PLAN_0163="SELECT md5(coalesce((SELECT string_agg(content, '|' ORDER BY id) FROM messages WHERE id <> 'a0000000-0000-4000-8000-000000000266'), '') || (SELECT string_agg(coalesce(metadata::text, '-'), '|' ORDER BY id) FROM messages) || (SELECT string_agg(plan::text, '|' ORDER BY title, id) FROM tasks) || (SELECT string_agg(plan::text, '|') FROM task_definitions) || (SELECT string_agg(plan::text, '|') FROM task_runs) || (SELECT string_agg(payload::text, '|' ORDER BY id) FROM proposed_changes))"
BEFORE_0163=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_plannames -tAc "$PLAN_0163")
apply_in grid_plannames 0164_plan_documents_english.sql
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000263'" $'**Research Plan Preview**\n\nDie grundlage ist unklar: "grundlage": kein Schluessel hier.\n\n```plan_json\n{"title": "Pruefung \\"grundlage\\": x", "sections": ["A"], "genre": "inspection_report", "depth": "quick_check", "basis": ["Einreichplan.pdf"], "excluded": [], "documents": [{"name": "Einreichplan.pdf"}]}\n```\n\n---\nReply **approve**' "0164 rewrites the keys and values inside the fence and nothing outside it, nor an escaped quote inside a title"
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000264'" 'approve {"sections":["A"],"genre":"file_note","depth":"expert_report","basis":["a.pdf"],"excluded":["b.pdf"],"data_sources":["knowledge_base"]}' "0164 rewrites an approval reply"
check_in grid_plannames "SELECT metadata #>> '{promptState,response}' FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000265'" 'approve {"genre":"comparison","basis":[]}' "0164 rewrites the answered card's reply"
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000266'" $'Ein ```plan_json\n{"genre": "report", "basis": []}\n```' "0164 leaves a plan that is already English"
check_in grid_plannames "SELECT content FROM messages WHERE id = 'a0000000-0000-4000-8000-000000000267'" 'Bitte "grundlage": pruefen, genre pruefbericht' "0164 leaves a message that has neither a fence nor an approval"
check_in grid_plannames "SELECT (plan -> 'documents')::text FROM tasks WHERE id = 'eeeeeeee-0000-4000-8000-000000000163'" '{"basis": [{"name": "a.pdf", "shelf": "project"}], "excluded": [{"name": "b.pdf"}]}' "0164 renames the keys of a task's documents"
check_in grid_plannames "SELECT (plan ? 'documents')::text FROM tasks WHERE id = 'eeeeeeee-0000-4000-8000-000000000164'" "false" "0164 does not invent documents on a task that named none"
check_in grid_plannames "SELECT ((SELECT plan -> 'documents' FROM task_definitions)::text) || ((SELECT plan -> 'documents' FROM task_runs)::text)" '{"basis": [{"name": "a.pdf"}], "excluded": []}{"basis": [], "excluded": [{"name": "c.pdf"}]}' "0164 renames the keys on a standing task and on a run"
check_in grid_plannames "SELECT (payload #>> '{operations,0,source}') || ',' || (payload #>> '{operations,1,source}') FROM proposed_changes WHERE id = 'c1c1c1c1-0000-4000-8000-000000000163'" "office,office" "0164 rewrites a Büroablage proposal's sources"
check_in grid_plannames "SELECT payload #>> '{operations,0,source}' FROM proposed_changes WHERE id = 'c1c1c1c1-0000-4000-8000-000000000164'" "project" "0164 rewrites a project proposal's source"
refused_in grid_plannames "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0163', NULL, 'archiv', 'file_operation', '{\"operation\": \"move\", \"operations\": [{\"document\": \"x.pdf\", \"source\": \"buero\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "the CHECK still accepts the old source"
check_in grid_plannames "SELECT convalidated::text FROM pg_constraint WHERE conname = 'proposed_changes_archiv_move' AND conrelid = 'proposed_changes'::regclass" "true" "the CHECK is validated"
sql_in grid_plannames <<'SQL'
INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('org_0163', NULL, 'archiv', 'file_operation', '{"operation": "move", "operations": [{"document": "x.pdf", "source": "office"}]}', 'piloti', 'user_1');
SQL
sql_in grid_plannames <<'SQL'
DELETE FROM proposed_changes WHERE payload #>> '{operations,0,document}' = 'x.pdf';
SQL
AFTER_ONCE_0163=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_plannames -tAc "$PLAN_0163")
apply_in grid_plannames 0164_plan_documents_english.sql
check_in grid_plannames "$PLAN_0163" "$AFTER_ONCE_0163" "0164 changes nothing the second time"
apply_in grid_plannames 0164_plan_documents_english.down.sql
check_in grid_plannames "$PLAN_0163" "$BEFORE_0163" "down restores every stored byte of what the migration took"
refused_in grid_plannames "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0163', NULL, 'archiv', 'file_operation', '{\"operation\": \"move\", \"operations\": [{\"document\": \"x.pdf\", \"source\": \"office\"}]}', 'piloti', 'user_1')" "proposed_changes_archiv_move" "down put the CHECK back on the old source"
apply_in grid_plannames 0164_plan_documents_english.sql
apply_in grid_plannames 0164_plan_documents_english.sql
check_in grid_plannames "$PLAN_0163" "$AFTER_ONCE_0163" "0164 re-applies, twice"
echo "==> 0164 plan names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0165: the Fassung table, a constraint and an inbox type take English
# names, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0165. The announcement
# table is renamed with its key and its policy (still one, still tenant-scoped);
# the Büroablage CHECK keeps refusing what it refused under its new name; an
# inbox row of the old type moves to the new one together with its group key,
# and a row of another type is left alone. The down puts every name back, and
# the up re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0165 revision names and their down migration on grid_revnames"
migrate_before grid_revnames 0165_revision_names
sql_in grid_revnames <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000164', 'org_0165', 'Namen 0165', 'user_1', 'proj_0165');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
VALUES ('d1d1d1d1-0000-4000-8000-000000000164', 'org_0165', 'user_1', 'neu.pdf', 'k/0165/neu', 'proj_0165', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000164');
INSERT INTO document_fassung_announcements (organization_id, document_id, anchor_id) VALUES
  ('org_0165', 'd1d1d1d1-0000-4000-8000-000000000164', 'd2d2d2d2-0000-4000-8000-000000000164'),
  ('org_other', 'd1d1d1d1-0000-4000-8000-000000000164', 'd3d3d3d3-0000-4000-8000-000000000164');
INSERT INTO inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id, anchor_id, group_key, actionable) VALUES
  ('org_0165', 'user_1', 'document.new_fassung', 'document', 'd1d1d1d1-0000-4000-8000-000000000164', 'd2d2d2d2-0000-4000-8000-000000000164',
   'document.new_fassung:document:d1d1d1d1-0000-4000-8000-000000000164:d2d2d2d2-0000-4000-8000-000000000164', false),
  ('org_0165', 'user_1', 'job.completed', 'document', 'd1d1d1d1-0000-4000-8000-000000000164', NULL,
   'job.completed:document:d1d1d1d1-0000-4000-8000-000000000164', false);
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of)
VALUES ('c1c1c1c1-0000-4000-8000-000000000164', 'org_0165', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"Norm.pdf","source":"office","target_folder":"Normen"}]}', 'piloti', 'user_1');
SQL
apply_in grid_revnames 0165_revision_names.sql
check_in grid_revnames "SELECT (to_regclass('document_revision_announcements') IS NOT NULL AND to_regclass('document_fassung_announcements') IS NULL)::text" "true" "0165 renames the announcement table"
check_in grid_revnames "SELECT count(*) FROM document_revision_announcements" "2" "0165 keeps the announcements"
check_in grid_revnames "SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'document_revision_announcements'::regclass" "document_revision_announcements_document_fkey,document_revision_announcements_pk" "0165 renames the key and the foreign key"
check_in grid_revnames "SELECT relrowsecurity::text || ':' || (SELECT count(*) FROM pg_policy WHERE polrelid = 'document_revision_announcements'::regclass)::text FROM pg_class WHERE relname = 'document_revision_announcements'" "true:1" "the renamed table is secured by exactly one policy"
RW164=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_revnames -qtA \
  -c "SET grid.organization_id = 'org_0165'" \
  -c "SELECT count(*) FROM document_revision_announcements")
if [ "$RW164" != "1" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_revnames: the runtime role saw another organization's announcements, or not its own (got: $RW164)" >&2
  exit 1
fi
check_in grid_revnames "SELECT string_agg(type, ',' ORDER BY type) FROM inbox_items" "document.new_revision,job.completed" "0165 gives the inbox row the new type and leaves the others"
check_in grid_revnames "SELECT group_key FROM inbox_items WHERE type = 'document.new_revision'" "document.new_revision:document:d1d1d1d1-0000-4000-8000-000000000164:d2d2d2d2-0000-4000-8000-000000000164" "0165 moves the group key with the type"
check_in grid_revnames "SELECT (count(*) FILTER (WHERE conname = 'proposed_changes_office_shelf_move') - count(*) FILTER (WHERE conname = 'proposed_changes_archiv_move'))::text FROM pg_constraint WHERE conrelid = 'proposed_changes'::regclass" "1" "0165 renames the Büroablage constraint"
refused_in grid_revnames "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0165', NULL, 'archiv', 'memory', '{}', 'piloti', 'user_1')" "proposed_changes_office_shelf_move" "the renamed constraint still refuses a Büroablage proposal that is not a move"
apply_in grid_revnames 0165_revision_names.down.sql
check_in grid_revnames "SELECT (to_regclass('document_fassung_announcements') IS NOT NULL AND to_regclass('document_revision_announcements') IS NULL)::text" "true" "down gives the announcement table its name back"
check_in grid_revnames "SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'document_fassung_announcements'::regclass" "document_fassung_announcements_document_fkey,document_fassung_announcements_pk" "down restores the key names"
check_in grid_revnames "SELECT string_agg(type, ',' ORDER BY type) FROM inbox_items" "document.new_fassung,job.completed" "down restores the inbox type"
check_in grid_revnames "SELECT group_key FROM inbox_items WHERE type = 'document.new_fassung'" "document.new_fassung:document:d1d1d1d1-0000-4000-8000-000000000164:d2d2d2d2-0000-4000-8000-000000000164" "down restores the group key"
check_in grid_revnames "SELECT count(*) FROM pg_constraint WHERE conname = 'proposed_changes_archiv_move' AND conrelid = 'proposed_changes'::regclass" "1" "down restores the Büroablage constraint name"
apply_in grid_revnames 0165_revision_names.sql
apply_in grid_revnames 0165_revision_names.sql
check_in grid_revnames "SELECT count(*) FROM document_revision_announcements" "2" "0165 re-applies, twice"
echo "==> 0165 revision names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0166: English kinds on permit records and their requirements, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0166. Every German kind
# is rewritten and the new CHECK refuses the old spelling; `nachforderung` is
# the one word both tables share and becomes `information_request` in both.
# ---------------------------------------------------------------------------
echo "==> verifying the 0166 permit kinds and their down migration on grid_permit_kinds"
migrate_before grid_permit_kinds 0166_permit_kinds
sql_in grid_permit_kinds <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000165', 'org_0166', 'Bescheide 0166', 'user_1', 'proj_0166');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'a.pdf', 'k/0166/a', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165'),
  ('d2d2d2d2-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'b.pdf', 'k/0166/b', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165'),
  ('d3d3d3d3-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'c.pdf', 'k/0166/c', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165'),
  ('d4d4d4d4-0000-4000-8000-000000000165', 'org_0166', 'user_1', 'd.pdf', 'k/0166/d', 'proj_0166', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000165');
INSERT INTO permit_records (id, organization_id, project_id, document_id, collection_name, file_name, kind, model) VALUES
  ('e1e1e1e1-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd1d1d1d1-0000-4000-8000-000000000165', 'proj_0166', 'a.pdf', 'bewilligung', 'm'),
  ('e2e2e2e2-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd2d2d2d2-0000-4000-8000-000000000165', 'proj_0166', 'b.pdf', 'nachforderung', 'm'),
  ('e3e3e3e3-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd3d3d3d3-0000-4000-8000-000000000165', 'proj_0166', 'c.pdf', 'ablehnung', 'm'),
  ('e4e4e4e4-0000-4000-8000-000000000165', 'org_0166', 'aaaaaaaa-0000-4000-8000-000000000165', 'd4d4d4d4-0000-4000-8000-000000000165', 'proj_0166', 'd.pdf', 'sonstiges', 'm');
INSERT INTO permit_requirements (organization_id, record_id, project_id, position, kind, content) VALUES
  ('org_0166', 'e1e1e1e1-0000-4000-8000-000000000165', 'aaaaaaaa-0000-4000-8000-000000000165', 1, 'auflage', 'Brandschutzkonzept vorlegen.'),
  ('org_0166', 'e2e2e2e2-0000-4000-8000-000000000165', 'aaaaaaaa-0000-4000-8000-000000000165', 1, 'nachforderung', 'Statischen Nachweis ergänzen.'),
  ('org_0166', 'e2e2e2e2-0000-4000-8000-000000000165', 'aaaaaaaa-0000-4000-8000-000000000165', 2, 'hinweis', 'Frist beachten.');
SQL
apply_in grid_permit_kinds 0166_permit_kinds.sql
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY file_name) FROM permit_records" "approval,information_request,refusal,other" "0166 rewrites every record kind"
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY position, kind) FROM permit_requirements" "condition,information_request,note" "0166 rewrites every requirement kind"
refused_in grid_permit_kinds "UPDATE permit_records SET kind = 'bewilligung' WHERE file_name = 'a.pdf'" "permit_records_kind_check" "the old record kind was accepted"
refused_in grid_permit_kinds "UPDATE permit_requirements SET kind = 'auflage' WHERE position = 1 AND kind = 'condition'" "permit_requirements_kind_check" "the old requirement kind was accepted"
check_in grid_permit_kinds "SELECT count(*) FROM pg_constraint WHERE conname IN ('permit_records_kind_check', 'permit_requirements_kind_check') AND convalidated" "2" "both CHECKs are validated"
apply_in grid_permit_kinds 0166_permit_kinds.down.sql
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY file_name) FROM permit_records" "bewilligung,nachforderung,ablehnung,sonstiges" "down restores the record kinds"
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY position, kind) FROM permit_requirements" "auflage,nachforderung,hinweis" "down restores the requirement kinds"
refused_in grid_permit_kinds "UPDATE permit_records SET kind = 'approval' WHERE file_name = 'a.pdf'" "permit_records_kind_check" "down left the English record kind accepted"
apply_in grid_permit_kinds 0166_permit_kinds.sql
apply_in grid_permit_kinds 0166_permit_kinds.sql
check_in grid_permit_kinds "SELECT string_agg(kind, ',' ORDER BY file_name) FROM permit_records" "approval,information_request,refusal,other" "0166 re-applies, twice"
echo "==> 0166 permit kinds and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0167: the task kind, the document roles and the BIM rule ids take
# English values, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0167. A role or a rule
# id that exists under both spellings for the same key (an older pod wrote the
# old one after the migration ran) keeps the new one. Nothing else moves.
# ---------------------------------------------------------------------------
echo "==> verifying the 0167 task, role and rule names and their down migration on grid_task_names"
migrate_before grid_task_names 0167_task_role_and_rule_names
sql_in grid_task_names <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000166', 'org_0167', 'Namen 0167', 'user_1', 'proj_0167');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000166', 'org_0167', 'user_1', 'plan.pdf', 'k/0167/plan', 'proj_0167', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000166'),
  ('d2d2d2d2-0000-4000-8000-000000000166', 'org_0167', 'user_1', 'modell.ifc', 'k/0167/modell', 'proj_0167', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000166');
INSERT INTO tasks (organization_id, project_id, kind, title, plan, requester_user_id) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'einreichcheck', 'Einreichcheck', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'document', 'Dokument', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1');
INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'einreichcheck', 'Einreichcheck', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1', 'manual');
INSERT INTO task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status, skill_snapshot) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'einreichcheck', 'Einreichcheck', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1', 'delegated', 'succeeded', '{}'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'compliance_check', 'Normprüfung', '{"prompt":"x","skill":{},"dataSources":null}', 'user_1', 'delegated', 'succeeded', '{}');
INSERT INTO document_roles (organization_id, project_id, document_id, role, scope_instance_id, created_by) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'bebauungsplan', NULL, 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'bestandsplan', 'b1', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'lageplan', NULL, 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd1d1d1d1-0000-4000-8000-000000000166', 'site_plan', NULL, 'user_2');
INSERT INTO bim_models (id, organization_id, project_id, document_id, status)
VALUES ('f1f1f1f1-0000-4000-8000-000000000166', 'org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'd2d2d2d2-0000-4000-8000-000000000166', 'completed');
INSERT INTO bim_check_confirmations (organization_id, project_id, rule_id, model_id, confirmed_by) VALUES
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib2-feuerwiderstand-tragend', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib3-raumhoehe', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib4-tuer-durchgangsbreite', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_1'),
  ('org_0167', 'aaaaaaaa-0000-4000-8000-000000000166', 'oib4-door-clear-width', 'f1f1f1f1-0000-4000-8000-000000000166', 'user_2');
SQL
apply_in grid_task_names 0167_task_role_and_rule_names.sql
check_in grid_task_names "SELECT string_agg(kind, ',' ORDER BY kind) FROM tasks" "document,submission_check" "0167 renames the kind on tasks"
check_in grid_task_names "SELECT string_agg(kind, ',') FROM task_definitions" "submission_check" "0167 renames the kind on task_definitions"
check_in grid_task_names "SELECT string_agg(kind, ',' ORDER BY kind) FROM task_runs" "compliance_check,submission_check" "0167 renames the kind on task_runs and leaves the others"
check_in grid_task_names "SELECT string_agg(role || ':' || coalesce(scope_instance_id, '-') || ':' || created_by, ',' ORDER BY role) FROM document_roles" "development_plan:-:user_1,existing_plans:b1:user_1,site_plan:-:user_2" "0167 renames the roles, and the binding that existed under both spellings keeps the new one"
check_in grid_task_names "SELECT string_agg(rule_id || ':' || confirmed_by, ',' ORDER BY rule_id) FROM bim_check_confirmations" "oib2-fire-resistance-load-bearing:user_1,oib3-room-height:user_1,oib4-door-clear-width:user_2" "0167 renames the rule ids, and the confirmation that existed under both spellings keeps the new one"
apply_in grid_task_names 0167_task_role_and_rule_names.down.sql
check_in grid_task_names "SELECT string_agg(kind, ',' ORDER BY kind) FROM tasks" "document,einreichcheck" "down restores the task kind"
check_in grid_task_names "SELECT string_agg(role, ',' ORDER BY role) FROM document_roles" "bebauungsplan,bestandsplan,lageplan" "down restores the roles"
check_in grid_task_names "SELECT string_agg(rule_id, ',' ORDER BY rule_id) FROM bim_check_confirmations" "oib2-feuerwiderstand-tragend,oib3-raumhoehe,oib4-tuer-durchgangsbreite" "down restores the rule ids"
apply_in grid_task_names 0167_task_role_and_rule_names.sql
apply_in grid_task_names 0167_task_role_and_rule_names.sql
check_in grid_task_names "SELECT string_agg(role, ',' ORDER BY role) FROM document_roles" "development_plan,existing_plans,site_plan" "0167 re-applies, twice"
echo "==> 0167 task, role and rule names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0168: English topic tags on conversations, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0168. Each array is
# rewritten element by element in the order of first appearance, an old key
# and its new spelling in one array collapse to one, a conversation without an
# old key is not touched (its `updated_at` stays), and the rewrite does not
# bump `updated_at` of one that is.
# ---------------------------------------------------------------------------
echo "==> verifying the 0168 conversation tag names and their down migration on grid_tag_names"
migrate_before grid_tag_names 0168_conversation_tag_names
sql_in grid_tag_names <<'SQL'
INSERT INTO conversations (id, organization_id, created_by, tags, updated_at) VALUES
  ('s_0168_a', 'org_0168', 'user_1', ARRAY['brandschutz', 'statik', 'brandschutz'], '2026-01-01 10:00:00+00'),
  ('s_0168_b', 'org_0168', 'user_1', ARRAY['allgemein'], '2026-01-02 10:00:00+00'),
  ('s_0168_c', 'org_0168', 'user_1', ARRAY['hygiene'], '2026-01-03 10:00:00+00'),
  ('s_0168_d', 'org_0168', 'user_1', ARRAY['fire_safety', 'brandschutz', 'energie'], '2026-01-04 10:00:00+00'),
  ('s_0168_e', 'org_0168', 'user_1', '{}', '2026-01-05 10:00:00+00');
SQL
apply_in grid_tag_names 0168_conversation_tag_names.sql
check_in grid_tag_names "SELECT string_agg(id || '=' || array_to_string(tags, '|'), ',' ORDER BY id) FROM conversations" "s_0168_a=fire_safety|structural,s_0168_b=general,s_0168_c=hygiene,s_0168_d=fire_safety|energy,s_0168_e=" "0168 rewrites the tags in order, without duplicates"
check_in grid_tag_names "SELECT count(*) FROM conversations WHERE updated_at <> ('2026-01-0' || (ascii(right(id, 1)) - 96)::text || ' 10:00:00+00')::timestamptz" "0" "0168 does not bump updated_at"
apply_in grid_tag_names 0168_conversation_tag_names.down.sql
check_in grid_tag_names "SELECT string_agg(id || '=' || array_to_string(tags, '|'), ',' ORDER BY id) FROM conversations" "s_0168_a=brandschutz|statik,s_0168_b=allgemein,s_0168_c=hygiene,s_0168_d=brandschutz|energie,s_0168_e=" "down restores the German keys"
apply_in grid_tag_names 0168_conversation_tag_names.sql
apply_in grid_tag_names 0168_conversation_tag_names.sql
check_in grid_tag_names "SELECT array_to_string(tags, '|') FROM conversations WHERE id = 's_0168_a'" "fire_safety|structural" "0168 re-applies, twice"
echo "==> 0168 conversation tag names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0169: English names for the builtin skills, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0169. An
# organization's decision about a playbook follows the rename, a clone that kept
# the builtin's name keeps shadowing it, a job and a standing task keep naming
# the skill, and a slash token inside a path is not one.
# ---------------------------------------------------------------------------
echo "==> verifying the 0169 skill names and their down migration on grid_skill_names"
migrate_before grid_skill_names 0169_skill_names
sql_in grid_skill_names <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000168', 'org_0169', 'Skills 0169', 'user_1', 'proj_0169');
INSERT INTO platform_skills (name, description, body, created_by) VALUES
  ('einreichcheck', 'd', 'b', 'platform'),
  ('brandschutz', 'd', 'b', 'platform'),
  ('fire-safety', 'd', 'b', 'platform');
INSERT INTO curated_skill_activations (organization_id, skill_name, enabled, updated_by) VALUES
  ('org_0169', 'einreichcheck', false, 'user_1'),
  ('org_0169', 'bestand', true, 'user_1'),
  ('org_0169', 'brandschutz', true, 'user_1'),
  ('org_0169', 'fire-safety', false, 'user_2');
INSERT INTO skills (organization_id, name, description, body, origin, cloned_from, created_by) VALUES
  ('org_0169', 'einreichcheck', 'd', 'b', 'platform-clone', 'einreichcheck', 'user_1'),
  ('org_0169', 'bestand', 'd', 'b', 'platform-clone', 'bestand', 'user_1'),
  ('org_0169', 'existing-building', 'd', 'b', 'org', NULL, 'user_1'),
  ('org_0169', 'brandschutz-check', 'd', 'b', 'platform-clone', 'brandschutz', 'user_1'),
  ('org_0169', 'hausregeln', 'd', 'b', 'org', NULL, 'user_1');
INSERT INTO jobs (id, project_id, organization_id, name, prompt, skill_name, skill_snapshot, output, enabled, schedule_timezone, created_by)
VALUES
  ('bbbbbbbb-0000-4000-8000-000000000168', 'aaaaaaaa-0000-4000-8000-000000000168', 'org_0169', 'Wöchentlich', '/einreichcheck bis Freitag; Ablage /brandschutz/eg bleibt', 'einreichcheck',
   '{"name":"einreichcheck","description":"d","body":"b","metadata":{},"origin":"platform"}', 'chat', true, 'UTC', 'user_1'),
  ('bbbbbbbb-0000-4000-8000-000000000169', 'aaaaaaaa-0000-4000-8000-000000000168', 'org_0169', 'Ohne Skill', 'Prüfe den Bestand', NULL, NULL, 'chat', true, 'UTC', 'user_1');
INSERT INTO task_definitions (organization_id, project_id, kind, title, plan, requester_user_id, trigger) VALUES
  ('org_0169', 'aaaaaaaa-0000-4000-8000-000000000168', 'compliance_check', 'Einreichcheck', '{"prompt":"Prüfe — /einreichcheck.","skill":{"name":"einreichcheck"},"dataSources":null}', 'user_1', 'manual');
SQL
apply_in grid_skill_names 0169_skill_names.sql
check_in grid_skill_names "SELECT string_agg(name, ',' ORDER BY name) FROM platform_skills" "fire-safety,submission-check" "0169 renames the platform skills, and the one that existed under both names keeps the new one"
check_in grid_skill_names "SELECT string_agg(skill_name || ':' || enabled::text || ':' || updated_by, ',' ORDER BY skill_name) FROM curated_skill_activations" "existing-building:true:user_1,fire-safety:false:user_2,submission-check:false:user_1" "0169 carries an organization's decision over to the new name"
check_in grid_skill_names "SELECT string_agg(name || '<' || coalesce(cloned_from, '-'), ',' ORDER BY name) FROM skills" "bestand<existing-building,brandschutz-check<fire-safety,existing-building<-,hausregeln<-,submission-check<submission-check" "0169 renames a clone that kept the builtin's name (unless the organization already has the new one, as with bestand) and repoints cloned_from"
check_in grid_skill_names "SELECT coalesce(skill_name, '-') || '|' || coalesce(skill_snapshot ->> 'name', '-') || '|' || prompt FROM jobs WHERE name = 'Wöchentlich'" "submission-check|submission-check|/submission-check bis Freitag; Ablage /brandschutz/eg bleibt" "0169 renames a job's skill and its slash token, and not a path"
check_in grid_skill_names "SELECT prompt FROM jobs WHERE name = 'Ohne Skill'" "Prüfe den Bestand" "0169 leaves the words of a prompt alone"
check_in grid_skill_names "SELECT (plan ->> 'prompt') || '|' || (plan #>> '{skill,name}') FROM task_definitions" "Prüfe — /submission-check.|submission-check" "0169 renames the skill of a standing task"
apply_in grid_skill_names 0169_skill_names.down.sql
check_in grid_skill_names "SELECT string_agg(name, ',' ORDER BY name) FROM platform_skills" "brandschutz,einreichcheck" "down restores the platform skill names (the new-only duplicate is the loss)"
check_in grid_skill_names "SELECT string_agg(skill_name, ',' ORDER BY skill_name) FROM curated_skill_activations" "bestand,brandschutz,einreichcheck" "down restores the activations"
check_in grid_skill_names "SELECT skill_name || '|' || prompt FROM jobs WHERE name = 'Wöchentlich'" "einreichcheck|/einreichcheck bis Freitag; Ablage /brandschutz/eg bleibt" "down restores a job's skill and slash token"
apply_in grid_skill_names 0169_skill_names.sql
apply_in grid_skill_names 0169_skill_names.sql
check_in grid_skill_names "SELECT skill_name FROM jobs WHERE name = 'Wöchentlich'" "submission-check" "0169 re-applies, twice"
echo "==> 0169 skill names and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0172: the inbox payload's `marksFassung` becomes `marksRevision`, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0172. Only the key moves,
# the count stays; a payload with both keys keeps the new one's value; a row
# without the old key is not touched (its `updated_at` stays).
# ---------------------------------------------------------------------------
echo "==> verifying the 0172 inbox revision marks and their down migration on grid_revmarks"
migrate_before grid_revmarks 0172_inbox_revision_marks
sql_in grid_revmarks <<'SQL'
INSERT INTO inbox_items (id, organization_id, recipient_user_id, type, resource_type, resource_id, group_key, actionable, payload, updated_at) VALUES
  ('a1a1a1a1-0000-4000-8000-000000000173', 'org_0173', 'user_1', 'document.new_revision', 'document', 'd1', 'g1', false, '{"openMarks": 3, "marksFassung": 2}', '2026-01-01 10:00:00+00'),
  ('a2a2a2a2-0000-4000-8000-000000000173', 'org_0173', 'user_1', 'document.new_revision', 'document', 'd2', 'g2', false, '{"openMarks": 1, "marksFassung": 1, "marksRevision": 4}', '2026-01-02 10:00:00+00'),
  ('a3a3a3a3-0000-4000-8000-000000000173', 'org_0173', 'user_1', 'document.new_revision', 'document', 'd3', 'g3', false, '{"openMarks": 2}', '2026-01-03 10:00:00+00');
SQL
apply_in grid_revmarks 0172_inbox_revision_marks.sql
check_in grid_revmarks "SELECT string_agg(payload::text, ' ' ORDER BY group_key) FROM inbox_items" '{"openMarks": 3, "marksRevision": 2} {"openMarks": 1, "marksRevision": 4} {"openMarks": 2}' "0172 renames the key, keeps the new key's value when both exist, and leaves other payloads alone"
check_in grid_revmarks "SELECT count(*) FROM inbox_items WHERE updated_at <> ('2026-01-0' || right(group_key, 1) || ' 10:00:00+00')::timestamptz" "0" "0172 does not bump updated_at"
apply_in grid_revmarks 0172_inbox_revision_marks.down.sql
check_in grid_revmarks "SELECT string_agg(payload::text, ' ' ORDER BY group_key) FROM inbox_items" '{"openMarks": 3, "marksFassung": 2} {"openMarks": 1, "marksFassung": 4} {"openMarks": 2}' "down restores the old key, with the value up kept (the newer one)"
apply_in grid_revmarks 0172_inbox_revision_marks.sql
apply_in grid_revmarks 0172_inbox_revision_marks.sql
check_in grid_revmarks "SELECT payload->>'marksRevision' FROM inbox_items WHERE group_key = 'g1'" "2" "0172 re-applies, twice"
echo "==> 0172 inbox revision marks and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0176: an organization-scoped operation proposal, one open call per
# conversation, and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0176, with three open
# operation proposals for one call in one conversation (the repeat 0176 folds), a
# different call, and a Büroablage move. The scope accepts `organization` with
# no project and only for an `operation`; the Büroablage CHECK still holds for
# the Büroablage; the unique index refuses a second open call, and frees it
# once decided. The runtime role sees its organization's proposals and no other's.
# ---------------------------------------------------------------------------
echo "==> verifying the 0176 organization operation proposals and their down migration on grid_orgop"
migrate_before grid_orgop 0176_organization_operation_proposals
sql_in grid_orgop <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000174', 'org_0176', 'Haus 0176', 'user_1', 'proj_0176');
INSERT INTO conversations (id, organization_id, created_by, project_id)
VALUES ('conv_0176', 'org_0176', 'user_1', 'aaaaaaaa-0000-4000-8000-000000000174');
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id, created_at) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000174', 'org_0176', 'aaaaaaaa-0000-4000-8000-000000000174', 'project', 'operation',
   '{"operation":"folder-rename","input":{"params":{"id":"p"},"body":{"name":"A"}},"summary":"s"}', 'piloti', 'user_1', 'conv_0176', '2026-01-01 10:00:00+00'),
  ('d2d2d2d2-0000-4000-8000-000000000174', 'org_0176', 'aaaaaaaa-0000-4000-8000-000000000174', 'project', 'operation',
   '{"operation":"folder-rename","input":{"body":{"name":"A"},"params":{"id":"p"}},"summary":"s"}', 'piloti', 'user_1', 'conv_0176', '2026-01-01 10:01:00+00'),
  ('d3d3d3d3-0000-4000-8000-000000000174', 'org_0176', 'aaaaaaaa-0000-4000-8000-000000000174', 'project', 'operation',
   '{"operation":"folder-rename","input":{"params":{"id":"p"},"body":{"name":"A"}},"summary":"s"}', 'piloti', 'user_1', 'conv_0176', '2026-01-01 10:02:00+00'),
  ('d4d4d4d4-0000-4000-8000-000000000174', 'org_0176', 'aaaaaaaa-0000-4000-8000-000000000174', 'project', 'operation',
   '{"operation":"folder-rename","input":{"params":{"id":"p"},"body":{"name":"B"}},"summary":"s"}', 'piloti', 'user_1', 'conv_0176', '2026-01-01 10:03:00+00');
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('d5d5d5d5-0000-4000-8000-000000000174', 'org_0176', NULL, 'office_shelf', 'file_operation',
   '{"operation":"move","operations":[{"document":"Norm.pdf","source":"office","target_folder":"Normen"}]}', 'piloti', 'user_1');
SQL
refused_in grid_orgop "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0176', NULL, 'organization', 'operation', '{}', 'piloti', 'user_1')" "violates check constraint" "the organization scope existed before 0176"
apply_in grid_orgop 0176_organization_operation_proposals.sql
check_in grid_orgop "SELECT string_agg(left(id::text, 2), ',' ORDER BY created_at) FROM proposed_changes WHERE kind = 'operation'" "d1,d4" "0176 folds a repeated open call to its oldest proposal, however its keys were ordered, and keeps another input"
check_in grid_orgop "SELECT count(*) FROM proposed_changes WHERE scope = 'office_shelf'" "1" "0176 leaves the Büroablage's proposal"
PO174="INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id) VALUES ('org_0176'"
sql_in grid_orgop <<<"$PO174, NULL, 'organization', 'operation', '{\"operation\":\"organization-memory-create\",\"input\":{\"body\":{\"content\":\"x\"}},\"summary\":\"s\"}', 'piloti', 'user_1', 'conv_0176')"
check_in grid_orgop "SELECT count(*) FROM proposed_changes WHERE scope = 'organization'" "1" "an operation is stored on the organization with no project"
refused_in grid_orgop "$PO174, NULL, 'organization', 'memory', '{}', 'piloti', 'user_1', NULL)" "proposed_changes_organization_operation" "an organization-scoped note was accepted"
refused_in grid_orgop "$PO174, NULL, 'organization', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"a.pdf\",\"source\":\"office\"}]}', 'piloti', 'user_1', NULL)" "proposed_changes_organization_operation" "an organization-scoped file move was accepted"
refused_in grid_orgop "$PO174, 'aaaaaaaa-0000-4000-8000-000000000174', 'organization', 'operation', '{}', 'piloti', 'user_1', NULL)" "proposed_changes_scope_owner" "an organization-scoped proposal naming a project was accepted"
refused_in grid_orgop "$PO174, NULL, 'regal', 'operation', '{}', 'piloti', 'user_1', NULL)" "proposed_changes_scope_known" "an unknown shelf was accepted"
refused_in grid_orgop "$PO174, NULL, 'office_shelf', 'operation', '{}', 'piloti', 'user_1', NULL)" "proposed_changes_office_shelf_move" "a Büroablage proposal of another kind was accepted"
refused_in grid_orgop "$PO174, NULL, 'organization', 'operation', '{\"operation\":\"organization-memory-create\",\"input\":{\"body\":{\"content\":\"x\"}},\"summary\":\"again\"}', 'piloti', 'user_1', 'conv_0176')" "uniq_proposed_changes_open_operation" "a second open proposal of the same call was accepted"
sql_in grid_orgop <<<"$PO174, NULL, 'organization', 'operation', '{\"operation\":\"organization-memory-create\",\"input\":{\"body\":{\"content\":\"x\"}},\"summary\":\"no chat\"}', 'piloti', 'user_1', NULL), ('org_0176', NULL, 'organization', 'operation', '{\"operation\":\"organization-memory-create\",\"input\":{\"body\":{\"content\":\"x\"}},\"summary\":\"no chat\"}', 'piloti', 'user_1', NULL)"
sql_in grid_orgop <<'SQL'
UPDATE proposed_changes SET status = 'dismissed', decided_by = 'user_1', decided_at = now()
  WHERE scope = 'organization' AND origin_conversation_id = 'conv_0176';
INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of, origin_conversation_id)
VALUES ('org_0176', NULL, 'organization', 'operation',
        '{"operation":"organization-memory-create","input":{"body":{"content":"x"}},"summary":"again"}', 'piloti', 'user_1', 'conv_0176');
SQL
check_in grid_orgop "SELECT count(*) FROM proposed_changes WHERE scope = 'organization' AND origin_conversation_id = 'conv_0176'" "2" "a decided proposal frees its call, and a repeat in no conversation is not folded"
RW174=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_orgop -qtA \
  -c "SET grid.organization_id = 'org_other_0176'" \
  -c "SELECT count(*) FROM proposed_changes WHERE scope = 'organization'")
if [ "$RW174" != "0" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_orgop: the runtime role saw another organization's organization-scoped proposals (got: $RW174)" >&2
  exit 1
fi
apply_in grid_orgop 0176_organization_operation_proposals.down.sql
check_in grid_orgop "SELECT count(*) FROM proposed_changes WHERE scope = 'organization'" "0" "down deleted the organization-scoped proposals"
check_in grid_orgop "SELECT count(*) FROM pg_indexes WHERE indexname = 'uniq_proposed_changes_open_operation'" "0" "down dropped the open call's unique index"
refused_in grid_orgop "$PO174, NULL, 'organization', 'operation', '{}', 'piloti', 'user_1', NULL)" "violates check constraint" "down left the organization scope allowed"
refused_in grid_orgop "$PO174, NULL, 'office_shelf', 'operation', '{}', 'piloti', 'user_1', NULL)" "proposed_changes_office_shelf_move" "down left the Büroablage CHECK open to another kind"
apply_in grid_orgop 0176_organization_operation_proposals.sql
apply_in grid_orgop 0176_organization_operation_proposals.sql
check_in grid_orgop "SELECT count(*) FROM proposed_changes WHERE kind = 'operation'" "2" "0176 re-applies, twice, keeping the proposals it should"
echo "==> 0176 organization operation proposals and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0177: the inbox types of a task run say `task_run`, not `job`, and
# the DOWN.
#
# On a database of its own, migrated to whatever precedes 0177. Each of the three
# types moves with the front of its group key; another type is not touched.
# ---------------------------------------------------------------------------
echo "==> verifying the 0177 task run inbox types and their down migration on grid_taskruninbox"
migrate_before grid_taskruninbox 0177_task_run_inbox_types
sql_in grid_taskruninbox <<'SQL'
INSERT INTO inbox_items (id, organization_id, recipient_user_id, type, resource_type, resource_id, group_key, actionable) VALUES
  ('a1a1a1a1-0000-4000-8000-000000000175', 'org_0177', 'user_1', 'job.completed', 'project', 'p1', 'job.completed:project:p1:j1', false),
  ('a2a2a2a2-0000-4000-8000-000000000175', 'org_0177', 'user_1', 'job.failed', 'project', 'p1', 'job.failed:project:p1:j2', false),
  ('a3a3a3a3-0000-4000-8000-000000000175', 'org_0177', 'user_1', 'job.waiting', 'project', 'p1', 'job.waiting:project:p1:r3', true),
  ('a4a4a4a4-0000-4000-8000-000000000175', 'org_0177', 'user_1', 'document.new_revision', 'document', 'd1', 'document.new_revision:document:d1:d2', false);
SQL
apply_in grid_taskruninbox 0177_task_run_inbox_types.sql
check_in grid_taskruninbox "SELECT string_agg(type || '=' || group_key, ' ' ORDER BY id) FROM inbox_items" "task_run.completed=task_run.completed:project:p1:j1 task_run.failed=task_run.failed:project:p1:j2 task_run.waiting=task_run.waiting:project:p1:r3 document.new_revision=document.new_revision:document:d1:d2" "0177 renames the three task run types with their group keys and leaves the others"
apply_in grid_taskruninbox 0177_task_run_inbox_types.down.sql
check_in grid_taskruninbox "SELECT string_agg(type || '=' || group_key, ' ' ORDER BY id) FROM inbox_items" "job.completed=job.completed:project:p1:j1 job.failed=job.failed:project:p1:j2 job.waiting=job.waiting:project:p1:r3 document.new_revision=document.new_revision:document:d1:d2" "down restores the job types and their group keys"
apply_in grid_taskruninbox 0177_task_run_inbox_types.sql
apply_in grid_taskruninbox 0177_task_run_inbox_types.sql
check_in grid_taskruninbox "SELECT count(*) FROM inbox_items WHERE type LIKE 'task_run.%'" "3" "0177 re-applies, twice"
echo "==> 0177 task run inbox types and down migration verified"
# Migration 0179: the asks another agent puts to Piloti (ADR-0124), and the DOWN.
#
# On a database of its own, migrated through 0179, with one conversation per
# organization. The CHECKs refuse an unknown state, a refusal without its
# reason, a reason on a running ask, a terminal ask without its end and a
# running one with an end; the composite key refuses an ask on another
# organization's conversation and cascades with the conversation. The runtime
# role sees its organization's asks and no other's. The down drops the table
# and leaves the conversations.
# ---------------------------------------------------------------------------
echo "==> verifying the 0179 asks and their down migration on grid_asks"
migrate_until grid_asks 0179_piloti_asks
sql_in grid_asks <<'SQL'
INSERT INTO conversations (id, organization_id, created_by) VALUES
  ('conv_0178_a', 'org_0178_a', 'user_1'),
  ('conv_0178_b', 'org_0178_b', 'user_2');
INSERT INTO piloti_asks (id, organization_id, conversation_id, requested_by) VALUES
  ('a1a1a1a1-0000-4000-8000-000000000177', 'org_0178_a', 'conv_0178_a', 'user_1'),
  ('b1b1b1b1-0000-4000-8000-000000000177', 'org_0178_b', 'conv_0178_b', 'user_2');
UPDATE piloti_asks SET state = 'completed', ended_at = now() WHERE id = 'a1a1a1a1-0000-4000-8000-000000000177';
SQL
check_in grid_asks "SELECT state FROM piloti_asks WHERE id = 'b1b1b1b1-0000-4000-8000-000000000177'" "submitted" "0179: an ask starts submitted"
PA177="INSERT INTO piloti_asks (id, organization_id, conversation_id, requested_by, state, reason, ended_at) VALUES (gen_random_uuid(), 'org_0178_a', 'conv_0178_a', 'user_1'"
refused_in grid_asks "$PA177, 'input-required', NULL, now())" "piloti_asks_state_known" "an unknown state"
refused_in grid_asks "$PA177, 'rejected', NULL, now())" "piloti_asks_reason_when_refused" "a rejected ask without its reason"
refused_in grid_asks "$PA177, 'working', 'why', NULL)" "piloti_asks_reason_when_refused" "a reason on a running ask"
refused_in grid_asks "$PA177, 'failed', '', now())" "piloti_asks_reason_length" "an empty reason"
refused_in grid_asks "$PA177, 'completed', NULL, NULL)" "piloti_asks_ended_when_terminal" "a completed ask without its end"
refused_in grid_asks "$PA177, 'working', NULL, now())" "piloti_asks_ended_when_terminal" "a running ask with an end"
refused_in grid_asks "INSERT INTO piloti_asks (id, organization_id, conversation_id, requested_by) VALUES (gen_random_uuid(), 'org_0178_a', 'conv_0178_b', 'user_1')" "piloti_asks_conversation_fkey" "an ask on another organization's conversation"
RW177=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_asks -qtA \
  -c "SET grid.organization_id = 'org_0178_a'" \
  -c "SELECT string_agg(id::text, ',') FROM piloti_asks")
if [ "$RW177" != "a1a1a1a1-0000-4000-8000-000000000177" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_asks: the runtime role saw asks that are not its organization's (got: $RW177)" >&2
  exit 1
fi
sql_in grid_asks <<<"DELETE FROM conversations WHERE id = 'conv_0178_b';"
check_in grid_asks "SELECT count(*) FROM piloti_asks WHERE organization_id = 'org_0178_b'" "0" "0179: an ask goes with its conversation"
apply_in grid_asks 0179_piloti_asks.sql
check_in grid_asks "SELECT count(*) FROM piloti_asks" "1" "0179 re-applies and keeps the asks"
apply_in grid_asks 0179_piloti_asks.down.sql
check_in grid_asks "SELECT count(*) FROM pg_tables WHERE tablename = 'piloti_asks'" "0" "0179 down drops the table"
check_in grid_asks "SELECT count(*) FROM conversations WHERE id = 'conv_0178_a'" "1" "0179 down leaves the conversations"
apply_in grid_asks 0179_piloti_asks.sql
check_in grid_asks "SELECT count(*) FROM pg_tables WHERE tablename = 'piloti_asks'" "1" "0179 applies again after its down"
echo "==> 0179 asks and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0180: the folder cards of the file tools (ADR-0127), and the DOWN.
#
# On a database of its own, migrated through 0180, with one Archiv (office
# shelf) folder per organization. The CHECKs refuse an abstract past 600
# characters, key facts that are not an array or hold nine entries, and an
# unknown status; the composite key refuses a card on another organization's
# folder (or on the wrong shelf), a second card for one folder, and cascades
# with the folder. The runtime role sees its organization's cards and no
# other's, and cannot write one into another organization. The down drops the
# table and leaves the folders.
# ---------------------------------------------------------------------------
echo "==> verifying the 0180 folder cards and their down migration on grid_foldercards"
migrate_until grid_foldercards 0180_folder_cards
sql_in grid_foldercards <<'SQL'
INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000180', 'org_0180_a', 'office_shelf', 'Vertraege', 'Vertraege'),
  ('f2f2f2f2-0000-4000-8000-000000000180', 'org_0180_b', 'office_shelf', 'Vertraege', 'Vertraege'),
  ('f3f3f3f3-0000-4000-8000-000000000180', 'org_0180_b', 'office_shelf', 'Plaene', 'Plaene');
INSERT INTO folder_cards (organization_id, folder_id, scope, collection, input_hash) VALUES
  ('org_0180_a', 'f1f1f1f1-0000-4000-8000-000000000180', 'office_shelf', 'archiv_org_0180_a', 'h1'),
  ('org_0180_b', 'f2f2f2f2-0000-4000-8000-000000000180', 'office_shelf', 'archiv_org_0180_b', 'h2');
SQL
check_in grid_foldercards "SELECT status || ':' || key_facts::text FROM folder_cards WHERE organization_id = 'org_0180_a'" "stale:[]" "0180: a card starts stale with no key facts"
FC180="INSERT INTO folder_cards (organization_id, folder_id, scope, collection, input_hash"
refused_in grid_foldercards "UPDATE folder_cards SET abstract = repeat('a', 601) WHERE organization_id = 'org_0180_a'" "folder_cards_abstract_length" "an abstract past 600 characters"
refused_in grid_foldercards "UPDATE folder_cards SET key_facts = '{}'::jsonb WHERE organization_id = 'org_0180_a'" "folder_cards_key_facts_shape" "key facts that are not an array"
refused_in grid_foldercards "UPDATE folder_cards SET key_facts = '[1,2,3,4,5,6,7,8,9]'::jsonb WHERE organization_id = 'org_0180_a'" "folder_cards_key_facts_shape" "nine key facts"
refused_in grid_foldercards "UPDATE folder_cards SET status = 'building' WHERE organization_id = 'org_0180_a'" "folder_cards_status_check" "an unknown status"
refused_in grid_foldercards "$FC180) VALUES ('org_0180_a', 'f3f3f3f3-0000-4000-8000-000000000180', 'office_shelf', 'archiv_org_0180_a', 'h')" "folder_cards_folder_fkey" "a card on another organization's folder"
refused_in grid_foldercards "$FC180) VALUES ('org_0180_b', 'f3f3f3f3-0000-4000-8000-000000000180', 'project', 'archiv_org_0180_b', 'h')" "folder_cards_folder_fkey" "a card on the wrong shelf"
refused_in grid_foldercards "$FC180) VALUES ('org_0180_a', 'f1f1f1f1-0000-4000-8000-000000000180', 'office_shelf', 'archiv_org_0180_a', 'h')" "folder_cards_folder_key" "a second card for one folder"
RW180=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_foldercards -qtA \
  -c "SET grid.organization_id = 'org_0180_a'" \
  -c "SELECT string_agg(organization_id, ',') FROM folder_cards")
if [ "$RW180" != "org_0180_a" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_foldercards: the runtime role saw cards that are not its organization's (got: $RW180)" >&2
  exit 1
fi
RWUP180=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_foldercards -qtA \
  -c "SET grid.organization_id = 'org_0180_a'" \
  -c "WITH u AS (UPDATE folder_cards SET collection = 'x' WHERE organization_id = 'org_0180_b' RETURNING 1) SELECT count(*) FROM u")
if [ "$RWUP180" != "0" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_foldercards: the runtime role updated another organization's card (got: $RWUP180)" >&2
  exit 1
fi
sql_in grid_foldercards <<<"DELETE FROM project_folders WHERE id = 'f2f2f2f2-0000-4000-8000-000000000180';"
check_in grid_foldercards "SELECT count(*) FROM folder_cards WHERE organization_id = 'org_0180_b'" "0" "0180: a card goes with its folder"
apply_in grid_foldercards 0180_folder_cards.sql
check_in grid_foldercards "SELECT count(*) FROM folder_cards" "1" "0180 re-applies and keeps the cards"
apply_in grid_foldercards 0180_folder_cards.down.sql
check_in grid_foldercards "SELECT count(*) FROM pg_tables WHERE tablename = 'folder_cards'" "0" "0180 down drops the table"
check_in grid_foldercards "SELECT count(*) FROM project_folders WHERE id = 'f1f1f1f1-0000-4000-8000-000000000180'" "1" "0180 down leaves the folders"
apply_in grid_foldercards 0180_folder_cards.sql
check_in grid_foldercards "SELECT count(*) FROM pg_tables WHERE tablename = 'folder_cards'" "1" "0180 applies again after its down"
echo "==> 0180 folder cards and down migration verified"

# ---------------------------------------------------------------------------
# Migration 0181: the office's conventions as Piloti counted them (ADR-0129),
# and the DOWN.
#
# On a database of its own, migrated through 0181, with one row per
# organization: the runtime role reads and updates only its own, a row is
# computed whole or not at all, and the down drops only the derived table.
# ---------------------------------------------------------------------------
echo "==> verifying the 0181 office conventions and their down migration on grid_officeconv"
migrate_until grid_officeconv 0181_office_conventions
sql_in grid_officeconv <<'SQL'
INSERT INTO office_conventions (organization_id, conventions, extractor_version, source_fingerprint, computed_at) VALUES
  ('org_0181_a', '{"version":1,"projects":3}'::jsonb, 1, 'fp_a', now()),
  ('org_0181_b', '{"version":1,"projects":4}'::jsonb, 1, 'fp_b', now());
INSERT INTO office_conventions (organization_id, refresh_requested_at) VALUES ('org_0181_c', now());
SQL
check_in grid_officeconv "SELECT count(*) FROM office_conventions WHERE conventions IS NULL" "1" "0181: a row may wait for its first refresh"
refused_in grid_officeconv "UPDATE office_conventions SET source_fingerprint = NULL WHERE organization_id = 'org_0181_a'" "office_conventions_computed_together" "conventions without their fingerprint"
refused_in grid_officeconv "UPDATE office_conventions SET conventions = '{}'::jsonb WHERE organization_id = 'org_0181_c'" "office_conventions_computed_together" "conventions without when they were computed"
RW181=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_officeconv -qtA \
  -c "SET grid.organization_id = 'org_0181_a'" \
  -c "SELECT string_agg(organization_id, ',') FROM office_conventions")
if [ "$RW181" != "org_0181_a" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_officeconv: the runtime role saw conventions that are not its organization's (got: $RW181)" >&2
  exit 1
fi
RWUP181=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_officeconv -qtA \
  -c "SET grid.organization_id = 'org_0181_a'" \
  -c "WITH u AS (UPDATE office_conventions SET refresh_requested_at = now() WHERE organization_id = 'org_0181_b' RETURNING 1) SELECT count(*) FROM u")
if [ "$RWUP181" != "0" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_officeconv: the runtime role updated another organization's conventions (got: $RWUP181)" >&2
  exit 1
fi
apply_in grid_officeconv 0181_office_conventions.sql
check_in grid_officeconv "SELECT count(*) FROM office_conventions" "3" "0181 re-applies and keeps the rows"
apply_in grid_officeconv 0181_office_conventions.down.sql
check_in grid_officeconv "SELECT count(*) FROM pg_tables WHERE tablename = 'office_conventions'" "0" "0181 down drops the table"
apply_in grid_officeconv 0181_office_conventions.sql
check_in grid_officeconv "SELECT count(*) FROM pg_tables WHERE tablename = 'office_conventions'" "1" "0181 applies again after its down"
echo "==> 0181 office conventions and down migration verified"

# ---------------------------------------------------------------------------
# 0182: a person's decision on one line of the office's conventions (ADR-0129).
# One row per organization and line, under RLS; the decision is confirmed or
# declined and the line is a JSON object. The down drops the table (authored
# rows go with it, which the down says).
# ---------------------------------------------------------------------------
echo "==> verifying the 0182 office convention decisions and their down migration on grid_officedec"
migrate_until grid_officedec 0182_office_convention_decisions
sql_in grid_officedec <<'SQL'
INSERT INTO office_convention_decisions (organization_id, line_key, decision, line, decided_by) VALUES
  ('org_0182_a', 'folder:behoerde', 'confirmed', '{"kind":"folder","key":"folder:behoerde"}'::jsonb, 'user_a'),
  ('org_0182_b', 'folder:behoerde', 'declined', '{"kind":"folder","key":"folder:behoerde"}'::jsonb, 'user_b');
SQL
check_in grid_officedec "SELECT count(*) FROM office_convention_decisions" "2" "0182: the same line may be decided by two organizations"
refused_in grid_officedec "INSERT INTO office_convention_decisions (organization_id, line_key, decision, line, decided_by) VALUES ('org_0182_a', 'folder:behoerde', 'declined', '{}'::jsonb, 'u')" "office_convention_decisions_pkey" "a second decision on one line"
refused_in grid_officedec "INSERT INTO office_convention_decisions (organization_id, line_key, decision, line, decided_by) VALUES ('org_0182_a', 'x', 'maybe', '{}'::jsonb, 'u')" "office_convention_decisions_decision_known" "a decision that is neither confirmed nor declined"
refused_in grid_officedec "INSERT INTO office_convention_decisions (organization_id, line_key, decision, line, decided_by) VALUES ('org_0182_a', 'y', 'confirmed', '[]'::jsonb, 'u')" "office_convention_decisions_line_object" "a line that is not an object"
RW182=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_officedec -qtA \
  -c "SET grid.organization_id = 'org_0182_a'" \
  -c "SELECT string_agg(organization_id, ',') FROM office_convention_decisions")
if [ "$RW182" != "org_0182_a" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_officedec: the runtime role saw decisions that are not its organization's (got: $RW182)" >&2
  exit 1
fi
RWUP182=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_officedec -qtA \
  -c "SET grid.organization_id = 'org_0182_a'" \
  -c "WITH u AS (UPDATE office_convention_decisions SET decision = 'declined' WHERE organization_id = 'org_0182_b' RETURNING 1) SELECT count(*) FROM u")
if [ "$RWUP182" != "0" ]; then
  echo "MIGRATION ASSERTION FAILED on grid_officedec: the runtime role changed another organization's decision (got: $RWUP182)" >&2
  exit 1
fi
apply_in grid_officedec 0182_office_convention_decisions.sql
check_in grid_officedec "SELECT count(*) FROM office_convention_decisions" "2" "0182 re-applies and keeps the rows"
apply_in grid_officedec 0182_office_convention_decisions.down.sql
check_in grid_officedec "SELECT count(*) FROM pg_tables WHERE tablename = 'office_convention_decisions'" "0" "0182 down drops the table"
apply_in grid_officedec 0182_office_convention_decisions.sql
check_in grid_officedec "SELECT count(*) FROM pg_tables WHERE tablename = 'office_convention_decisions'" "1" "0182 applies again after its down"
echo "==> 0182 office convention decisions and down migration verified"

# ---------------------------------------------------------------------------
# 0183: a report's thread (ADR-0118, amended). The conversations session the
# server opened the ticket in is UUID-shaped or NULL; the down drops both
# columns and 0183 applies again after it.
# ---------------------------------------------------------------------------
echo "==> verifying the 0183 product feedback thread columns and their down migration on grid_feedbackthread"
migrate_until grid_feedbackthread 0183_product_feedback_thread
sql_in grid_feedbackthread <<'SQL'
INSERT INTO product_feedback (organization_id, user_id, kind, message, posthog_widget_session_id) VALUES
  ('org_0183_a', 'user_a', 'bug', 'The upload stops at 99 percent', '0b1c2d3e-4f50-4617-8899-aabbccddeeff'),
  ('org_0183_a', 'user_a', 'idea', 'Filed before 0183, no session', NULL);
SQL
check_in grid_feedbackthread "SELECT count(*) FROM product_feedback" "2" "0183: a session or none"
refused_in grid_feedbackthread "INSERT INTO product_feedback (organization_id, user_id, kind, message, posthog_widget_session_id) VALUES ('org_0183_a', 'u', 'bug', 'not a session id here', 'x;--')" "product_feedback_posthog_widget_session_id_shape" "a session id that is not UUID-shaped"
apply_in grid_feedbackthread 0183_product_feedback_thread.sql
check_in grid_feedbackthread "SELECT count(*) FROM product_feedback WHERE posthog_widget_session_id IS NOT NULL" "1" "0183 re-applies and keeps the session"
apply_in grid_feedbackthread 0183_product_feedback_thread.down.sql
check_in grid_feedbackthread "SELECT count(*) FROM information_schema.columns WHERE table_name = 'product_feedback' AND column_name IN ('posthog_widget_session_id', 'reporter_seen_at')" "0" "0183 down drops both columns"
apply_in grid_feedbackthread 0183_product_feedback_thread.sql
check_in grid_feedbackthread "SELECT count(*) FROM information_schema.columns WHERE table_name = 'product_feedback' AND column_name IN ('posthog_widget_session_id', 'reporter_seen_at')" "2" "0183 applies again after its down"
echo "==> 0183 product feedback thread and down migration verified"

# ---------------------------------------------------------------------------
# 0184: the reporter's notice of a team reply (ADR-0118, second amendment). The
# watermark is nullable and moves only forward under its compare-and-set; the
# down drops it and 0184 applies again after it.
# ---------------------------------------------------------------------------
echo "==> verifying the 0184 product feedback reply notice column and its down migration on grid_feedbacknotice"
migrate_until grid_feedbacknotice 0184_product_feedback_reply_notice
sql_in grid_feedbacknotice <<'SQL'
INSERT INTO product_feedback (organization_id, user_id, kind, message, posthog_ticket_id) VALUES
  ('org_0184_a', 'user_a', 'bug', 'The upload stops at 99 percent', 'ticket-0184');
SQL
check_in grid_feedbacknotice "SELECT count(*) FROM product_feedback WHERE reporter_notified_at IS NULL" "1" "0184: nothing announced yet"
check_in grid_feedbacknotice "WITH u AS (UPDATE product_feedback SET reporter_notified_at = '2026-10-22T10:00:00Z' WHERE posthog_ticket_id = 'ticket-0184' AND (reporter_notified_at IS NULL OR reporter_notified_at < '2026-10-22T10:00:00Z') RETURNING 1) SELECT count(*) FROM u" "1" "0184: the first poke moves the watermark"
check_in grid_feedbacknotice "WITH u AS (UPDATE product_feedback SET reporter_notified_at = '2026-10-22T10:00:00Z' WHERE posthog_ticket_id = 'ticket-0184' AND (reporter_notified_at IS NULL OR reporter_notified_at < '2026-10-22T10:00:00Z') RETURNING 1) SELECT count(*) FROM u" "0" "0184: a replayed poke moves nothing"
apply_in grid_feedbacknotice 0184_product_feedback_reply_notice.sql
check_in grid_feedbacknotice "SELECT count(*) FROM product_feedback WHERE reporter_notified_at IS NOT NULL" "1" "0184 re-applies and keeps the watermark"
apply_in grid_feedbacknotice 0184_product_feedback_reply_notice.down.sql
check_in grid_feedbacknotice "SELECT count(*) FROM information_schema.columns WHERE table_name = 'product_feedback' AND column_name = 'reporter_notified_at'" "0" "0184 down drops the column"
apply_in grid_feedbacknotice 0184_product_feedback_reply_notice.sql
check_in grid_feedbacknotice "SELECT count(*) FROM information_schema.columns WHERE table_name = 'product_feedback' AND column_name = 'reporter_notified_at'" "1" "0184 applies again after its down"
echo "==> 0184 product feedback reply notice and down migration verified"

# ---------------------------------------------------------------------------
# Migrations 0159 to 0162: the project profile's names in English, and their DOWNs.
#
# On a database of its own, migrated to what precedes 0159, with a project whose
# profile, prompt view, dismissed values, building bindings, proposed patch and
# permit record all hold the German names. Each migration rewrites its own table;
# a second run changes nothing; the down restores the German names.
# ---------------------------------------------------------------------------
echo "==> verifying the 0159-0162 English profile names and their down migrations on grid_profile_names"
migrate_before grid_profile_names 0159_english_profile_names
sql_in grid_profile_names <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name, profile, profile_prompt_view, profile_version) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000159', 'org_0159', 'Haus Wien', 'user_1', 'proj_0159',
   '{"facts":{"bundesland":{"value":"wien","confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "nutzungen@bw1":{"value":["wohnen","buero"],"confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "wohneinheiten@bw1@wohnen":{"value":4,"confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "gebaeudeklasse@bw1":{"value":3,"confidence":"confirmed","source":"derivation","updatedAt":"x",
                "evidence":[{"kind":"derivation","rule":"gebaeudeklasse","inputs":[{"key":"geschosse_oberirdisch@bw1","value":3},{"key":"nutzungen@bw1","value":["wohnen"]}]}]},
              "bauweise@bw1":{"value":["holzbau","offen"],"confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "project_name":{"value":"Haus","confidence":"confirmed","source":"onboarding","updatedAt":"x"},
              "agent_key":{"value":"wien","confidence":"confirmed","source":"onboarding","updatedAt":"x"}},
     "goals":{}, "unknowns":["bgf_oberirdisch@bw1"],
     "assumptions":{"erschliessung":{"value":"ja","confidence":"assumed","source":"onboarding","updatedAt":"x"}}}',
   E'PROJECT_CONTEXT v1\n\nconfirmed:\n- bundesland=wien\n- nutzungen@bw1=wohnen,buero\n- agent_key=wien\n\nunknown:\n- bgf_oberirdisch@bw1\n\nassumptions:\n- erschliessung=ja', 5),
  ('bbbbbbbb-0000-4000-8000-000000000159', 'org_0159', 'Leer', 'user_1', 'proj_0159b',
   '{"facts":{},"goals":{},"unknowns":[],"assumptions":{}}', NULL, 1);
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000159', 'org_0159', 'user_1', 'a.pdf', 'k/0159/a', 'proj_0159', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000159'),
  ('d2d2d2d2-0000-4000-8000-000000000159', 'org_0159', 'user_1', 'b.pdf', 'k/0159/b', 'proj_0159', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000159');
INSERT INTO document_roles (organization_id, project_id, document_id, role, scope_instance_id, created_by) VALUES
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd1d1d1d1-0000-4000-8000-000000000159', 'drawing', 'bw1', 'user_1'),
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'drawing', 'bw2', 'user_1'),
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'drawing', 'bldg2', 'user_1'),
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'site_plan', NULL, 'user_1');
INSERT INTO project_intakes (organization_id, project_id, created_by, dismissed, location) VALUES
  ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'user_1',
   '[{"key":"bundesland","value":"niederoesterreich"},{"key":"nutzungen@bw1","value":["wohnen"]}]',
   '{"bundesland":"tirol","gemeinde":"Innsbruck","lat":47.2}');
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES
  ('e1e1e1e1-0000-4000-8000-000000000159', 'org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'project', 'project_profile',
   '{"title":"t","patch":[{"op":"add","path":"/facts/bundesland","value":{"value":"tirol","confidence":"confirmed"}},
                          {"op":"replace","path":"/facts/nutzungen@bw1/value","value":["wohnen","buero"]},
                          {"op":"add","path":"/unknowns/-","value":"geschosse_oberirdisch@bw1"}]}', 'piloti', 'user_1'),
  ('e2e2e2e2-0000-4000-8000-000000000159', 'org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'project', 'memory',
   '{"patch":[{"path":"/facts/bundesland"}]}', 'piloti', 'user_1');
INSERT INTO permit_records (id, organization_id, project_id, document_id, collection_name, file_name, kind, bundesland, model) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000159', 'org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd1d1d1d1-0000-4000-8000-000000000159',
   'proj_0159', 'a.pdf', 'bewilligung', 'niederoesterreich', 'm');
SQL

PROFILE_0159="SELECT profile::text || ' v' || profile_version FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'"
before_0159=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_profile_names -tAc "$PROFILE_0159")
before_view_0159=$($PGBIN/psql -h "$WORKDIR" -p "$PORT" -U grid_app_owner -d grid_profile_names -tAc "SELECT profile_prompt_view FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'")

apply_in grid_profile_names 0159_english_profile_names.sql
check_in grid_profile_names "SELECT string_agg(k, ',' ORDER BY k) FROM projects, jsonb_object_keys(profile->'facts') k WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  "agent_key,building_class@bldg1,construction_method@bldg1,dwelling_units@bldg1@residential,federal_state,project_name,uses@bldg1" \
  "0159 renames the fact keys, the building id and the use zone; a key it does not know stays"
check_in grid_profile_names "SELECT profile->'facts'->'federal_state'->>'value' || '|' || (profile->'facts'->'uses@bldg1'->>'value') || '|' || (profile->'facts'->'construction_method@bldg1'->>'value') || '|' || (profile->'facts'->'agent_key'->>'value') FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  'vienna|["residential", "office"]|["timber", "open"]|wien' \
  "0159 renames the tokens under the key they sit under, and not the same word under a key it does not know"
check_in grid_profile_names "SELECT profile->'facts'->'building_class@bldg1'->'evidence'->0->>'rule' || '|' || (profile->'facts'->'building_class@bldg1'->'evidence'->0->'inputs'->0->>'key') || '|' || (profile->'facts'->'building_class@bldg1'->'evidence'->0->'inputs'->1->'value'->>0) FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  "building_class|storeys_above_ground@bldg1|residential" "0159 renames a derivation's rule, its input keys and their values"
check_in grid_profile_names "SELECT profile->'unknowns'->>0 || '|' || (profile->'assumptions'->'servicing'->>'value') FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  "gfa_above_ground@bldg1|yes" "0159 renames an unknown and an assumption (ja is yes only for servicing)"
check_in grid_profile_names "SELECT profile_prompt_view FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" \
  $'PROJECT_CONTEXT v1\n\nconfirmed:\n- federal_state=vienna\n- uses@bldg1=residential,office\n- agent_key=wien\n\nunknown:\n- gfa_above_ground@bldg1\n\nassumptions:\n- servicing=yes' \
  "0159 rewrites the prompt view the agent parses, line by line"
check_in grid_profile_names "SELECT profile_version FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" "6" "0159 bumps profile_version so an open wizard reloads"
check_in grid_profile_names "SELECT profile_version FROM projects WHERE id = 'bbbbbbbb-0000-4000-8000-000000000159'" "1" "0159 leaves a profile without German names alone"
apply_in grid_profile_names 0159_english_profile_names.sql
check_in grid_profile_names "SELECT profile_version FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" "6" "0159 re-applies without a second bump"

apply_in grid_profile_names 0160_english_intake_names.sql
check_in grid_profile_names "SELECT dismissed::text FROM project_intakes" \
  '[{"key": "federal_state", "value": "lower_austria"}, {"key": "uses@bldg1", "value": ["residential"]}]' "0160 renames a dismissed key and value"
check_in grid_profile_names "SELECT location::text FROM project_intakes" \
  '{"lat": 47.2, "federalState": "tyrol", "municipality": "Innsbruck"}' "0160 renames the location's fields and the Land's token"
apply_in grid_profile_names 0160_english_intake_names.sql

apply_in grid_profile_names 0161_english_building_ids.sql
check_in grid_profile_names "SELECT string_agg(coalesce(scope_instance_id, '-') || ':' || role, ',' ORDER BY scope_instance_id, role) FROM document_roles" \
  "bldg1:drawing,bldg2:drawing,-:site_plan" \
  "0161 renames the building id of a binding, and drops the German duplicate of a binding that already exists in English"
check_in grid_profile_names "SELECT payload->'patch'->0->>'path' || '|' || (payload->'patch'->0->'value'->>'value') || '|' || (payload->'patch'->1->>'path') || '|' || (payload->'patch'->2->>'value') FROM proposed_changes WHERE kind = 'project_profile'" \
  "/facts/federal_state|tyrol|/facts/uses@bldg1/value|storeys_above_ground@bldg1" "0161 renames a proposed profile patch's paths and values"
check_in grid_profile_names "SELECT payload::text FROM proposed_changes WHERE kind = 'memory'" '{"patch": [{"path": "/facts/bundesland"}]}' "0161 leaves a proposal of another kind alone"
apply_in grid_profile_names 0161_english_building_ids.sql
check_in grid_profile_names "SELECT count(*) FROM document_roles" "3" "0161 re-applies without losing a binding"

apply_in grid_profile_names 0162_permit_federal_state.sql
check_in grid_profile_names "SELECT bundesland || '|' || federal_state FROM permit_records" "niederoesterreich|lower_austria" "0162 backfills federal_state with the English token and keeps bundesland"
sql_in grid_profile_names <<'SQL'
INSERT INTO permit_records (organization_id, project_id, document_id, collection_name, file_name, kind, federal_state, model)
VALUES ('org_0159', 'aaaaaaaa-0000-4000-8000-000000000159', 'd2d2d2d2-0000-4000-8000-000000000159', 'proj_0159', 'b.pdf', 'bewilligung', 'styria', 'm');
SQL
check_in grid_profile_names "SELECT bundesland || '|' || federal_state FROM permit_records WHERE file_name = 'b.pdf'" "steiermark|styria" "0162: a new pod's write fills the old column, so an older pod reads it"
sql_in grid_profile_names <<<"UPDATE permit_records SET bundesland = 'tirol' WHERE file_name = 'a.pdf'"
check_in grid_profile_names "SELECT federal_state FROM permit_records WHERE file_name = 'a.pdf'" "tyrol" "0162: an older pod's write fills the new column"
apply_in grid_profile_names 0162_permit_federal_state.sql

apply_in grid_profile_names 0162_permit_federal_state.down.sql
check_in grid_profile_names "SELECT count(*) FROM information_schema.columns WHERE table_name = 'permit_records' AND column_name IN ('federal_state', 'bundesland')" "1" "0162 down drops the English column and keeps bundesland"
check_in grid_profile_names "SELECT string_agg(file_name || ':' || bundesland, ',' ORDER BY file_name) FROM permit_records" "a.pdf:tirol,b.pdf:steiermark" "0162 down leaves the German tokens, as the trigger kept them"
apply_in grid_profile_names 0161_english_building_ids.down.sql
check_in grid_profile_names "SELECT string_agg(coalesce(scope_instance_id, '-') || ':' || role, ',' ORDER BY scope_instance_id, role) FROM document_roles" "bw1:drawing,bw2:drawing,-:site_plan" "0161 down restores the bwN building ids"
check_in grid_profile_names "SELECT payload->'patch'->0->>'path' || '|' || (payload->'patch'->1->>'path') FROM proposed_changes WHERE kind = 'project_profile'" "/facts/bundesland|/facts/nutzungen@bw1/value" "0161 down restores the patch paths"
apply_in grid_profile_names 0160_english_intake_names.down.sql
check_in grid_profile_names "SELECT dismissed::text || location::text FROM project_intakes" \
  '[{"key": "bundesland", "value": "niederoesterreich"}, {"key": "nutzungen@bw1", "value": ["wohnen"]}]{"lat": 47.2, "gemeinde": "Innsbruck", "bundesland": "tirol"}' "0160 down restores the German dismissed values and location"
apply_in grid_profile_names 0159_english_profile_names.down.sql
check_in grid_profile_names "$PROFILE_0159" "${before_0159%% v*} v7" "0159 down restores the profile exactly (its version moves forward, never back)"
check_in grid_profile_names "SELECT profile_prompt_view FROM projects WHERE id = 'aaaaaaaa-0000-4000-8000-000000000159'" "$before_view_0159" "0159 down restores the prompt view exactly"
echo "==> 0159-0162 English profile names and down migrations verified"

# ---------------------------------------------------------------------------
# Migrations 0170 and 0171: the office shelf's scope value is `office_shelf`,
# and the DOWN.
#
# On a database of its own, migrated to whatever precedes 0170. An office-shelf
# folder with a child, a document filed in the child, a project document, an
# upload batch and a proposal on the shelf, an access-log entry and a quarantine
# decision under the old value. 0170 rewrites the four mutable tables (and the
# composite keys between documents and folders survive the rewrite), refuses the
# old value in their new CHECKs, and leaves the two immutable tables alone; 0171
# makes those accept both spellings. The down puts the old value back; the up
# re-applies twice.
# ---------------------------------------------------------------------------
echo "==> verifying the 0170/0171 office shelf scope and its down migrations on grid_shelfscope"
migrate_before grid_shelfscope 0170_office_shelf_scope
sql_in grid_shelfscope <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name)
VALUES ('aaaaaaaa-0000-4000-8000-000000000170', 'org_0170', 'Scope 0170', 'user_1', 'proj_0170');
INSERT INTO project_folders (id, organization_id, scope, name, path) VALUES
  ('f1f1f1f1-0000-4000-8000-000000000170', 'org_0170', 'archiv', 'Normen', 'Normen');
INSERT INTO project_folders (id, organization_id, scope, parent_id, name, path) VALUES
  ('f2f2f2f2-0000-4000-8000-000000000170', 'org_0170', 'archiv', 'f1f1f1f1-0000-4000-8000-000000000170', 'OIB', 'Normen/OIB');
INSERT INTO project_folders (id, organization_id, project_id, name, path) VALUES
  ('f3f3f3f3-0000-4000-8000-000000000170', 'org_0170', 'aaaaaaaa-0000-4000-8000-000000000170', 'Plaene', 'Plaene');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, folder_id) VALUES
  ('d1d1d1d1-0000-4000-8000-000000000170', 'org_0170', 'user_1', 'norm.pdf', 'k/0170/norm', 'archiv_org_0170', 'completed', 'archiv', 'f2f2f2f2-0000-4000-8000-000000000170');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id) VALUES
  ('d2d2d2d2-0000-4000-8000-000000000170', 'org_0170', 'user_1', 'plan.pdf', 'k/0170/plan', 'proj_0170', 'completed', 'project', 'aaaaaaaa-0000-4000-8000-000000000170', 'f3f3f3f3-0000-4000-8000-000000000170');
INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES
  ('b1b1b1b1-0000-4000-8000-000000000170', 'org_0170', 'user_1', 'archiv', 1);
INSERT INTO proposed_changes (id, organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of)
VALUES ('c1c1c1c1-0000-4000-8000-000000000170', 'org_0170', NULL, 'archiv', 'file_operation',
        '{"operation":"move","operations":[{"document":"norm.pdf","source":"office","target_folder":"Normen"}]}', 'piloti', 'user_1');
INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name)
VALUES ('org_0170', 'u', 'download', 'archiv', 'd1d1d1d1-0000-4000-8000-000000000170', 'norm.pdf');
INSERT INTO document_quarantine_decisions (id, organization_id, document_id, job_id, scope, filename, uploaded_by)
VALUES ('e1e1e1e1-0000-4000-8000-000000000170', 'org_0170', 'd1d1d1d1-0000-4000-8000-000000000170', 'job-0170', 'archiv', 'norm.pdf', 'u');
SQL
SCOPES_0170="SELECT (SELECT string_agg(scope, ',' ORDER BY id) FROM project_folders) || '|' || (SELECT string_agg(scope, ',' ORDER BY id) FROM documents) || '|' || (SELECT scope FROM upload_batches) || '|' || (SELECT scope FROM proposed_changes)"
apply_in grid_shelfscope 0170_office_shelf_scope.sql
check_in grid_shelfscope "$SCOPES_0170" "office_shelf,office_shelf,project|office_shelf,project|office_shelf|office_shelf" "0170 renames the scope on folders, documents, the upload batch and the proposal"
check_in grid_shelfscope "SELECT folder_id FROM documents WHERE id = 'd1d1d1d1-0000-4000-8000-000000000170'" "f2f2f2f2-0000-4000-8000-000000000170" "0170 keeps a document in its folder"
check_in grid_shelfscope "SELECT count(*) FROM pg_constraint WHERE conname IN ('documents_folder_id_organization_id_scope_fkey','project_folders_parent_id_organization_id_scope_fkey','documents_folder_requires_project','project_folders_scope_check','upload_batches_scope','proposed_changes_scope_known') AND convalidated" "6" "0170 brings back the six constraints it dropped, validated"
check_in grid_shelfscope "SELECT scope FROM document_access_log" "archiv" "0170 does not rewrite the immutable access log"
check_in grid_shelfscope "SELECT scope FROM document_quarantine_decisions" "archiv" "0170 does not rewrite the immutable quarantine decisions"
refused_in grid_shelfscope "INSERT INTO project_folders (organization_id, scope, name, path) VALUES ('org_0170', 'archiv', 'Alt', 'Alt');" "project_folders_scope_check" "the old shelf value on a folder"
refused_in grid_shelfscope "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES (gen_random_uuid(), 'org_0170', 'u', 'archiv', 1);" "upload_batches_scope" "the old shelf value on an upload batch"
refused_in grid_shelfscope "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0170', NULL, 'archiv', 'file_operation', '{\"operation\":\"move\",\"operations\":[{\"document\":\"x.pdf\",\"source\":\"office\"}]}', 'piloti', 'user_1');" "proposed_changes_scope_known" "the old shelf value on a proposal"
refused_in grid_shelfscope "INSERT INTO proposed_changes (organization_id, project_id, scope, kind, payload, proposed_by_kind, on_behalf_of) VALUES ('org_0170', NULL, 'office_shelf', 'memory', '{}', 'piloti', 'user_1');" "proposed_changes_office_shelf_move" "a shelf proposal that is not a move still refused"
refused_in grid_shelfscope "UPDATE documents SET folder_id = 'f3f3f3f3-0000-4000-8000-000000000170' WHERE id = 'd1d1d1d1-0000-4000-8000-000000000170';" "documents_folder_id_organization_id_scope_fkey" "a shelf document in a project folder"
refused_in grid_shelfscope "INSERT INTO project_folders (organization_id, scope, parent_id, name, path) VALUES ('org_0170', 'office_shelf', 'f3f3f3f3-0000-4000-8000-000000000170', 'x', 'x');" "project_folders_parent_id_organization_id_scope_fkey" "a project folder as the parent of a shelf folder"
refused_in grid_shelfscope "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'office_shelf', gen_random_uuid(), 'x');" "document_access_log_scope_check" "the new shelf value in the log before 0171"
apply_in grid_shelfscope 0171_office_shelf_scope_logs.sql
sql_in grid_shelfscope <<<"INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'office_shelf', gen_random_uuid(), 'neu.pdf');"
check_in grid_shelfscope "SELECT string_agg(scope, ',' ORDER BY document_name) FROM document_access_log" "office_shelf,archiv" "0171: the log holds the old entry and takes a new one"
refused_in grid_shelfscope "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'regal', gen_random_uuid(), 'x');" "document_access_log_scope_check" "an unknown shelf value in the log"
sql_in grid_shelfscope <<<"INSERT INTO document_quarantine_decisions (organization_id, document_id, job_id, scope, filename, uploaded_by) VALUES ('org_0170', gen_random_uuid(), 'job-2', 'office_shelf', 'neu.pdf', 'u');"
apply_in grid_shelfscope 0171_office_shelf_scope_logs.sql
apply_in grid_shelfscope 0170_office_shelf_scope.sql
apply_in grid_shelfscope 0170_office_shelf_scope.sql
check_in grid_shelfscope "$SCOPES_0170" "office_shelf,office_shelf,project|office_shelf,project|office_shelf|office_shelf" "0170 re-applies, twice"
# The down of 0171 needs a log with no new-spelling row; the log is immutable, so it runs on a fresh database.
migrate_before grid_shelfscope_down 0171_office_shelf_scope_logs
apply_in grid_shelfscope_down 0171_office_shelf_scope_logs.sql
apply_in grid_shelfscope_down 0171_office_shelf_scope_logs.down.sql
refused_in grid_shelfscope_down "INSERT INTO document_access_log (organization_id, user_id, kind, scope, document_id, document_name) VALUES ('org_0170', 'u', 'download', 'office_shelf', gen_random_uuid(), 'x');" "document_access_log_scope_check" "0171 down takes the new value out of the log CHECK"
apply_in grid_shelfscope 0170_office_shelf_scope.down.sql
check_in grid_shelfscope "$(echo "$SCOPES_0170")" "archiv,archiv,project|archiv,project|archiv|archiv" "0170 down puts the old scope back on every mutable table"
refused_in grid_shelfscope "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES (gen_random_uuid(), 'org_0170', 'u', 'office_shelf', 1);" "upload_batches_scope" "down: the new shelf value on an upload batch"
apply_in grid_shelfscope 0170_office_shelf_scope.sql
check_in grid_shelfscope "$SCOPES_0170" "office_shelf,office_shelf,project|office_shelf,project|office_shelf|office_shelf" "0170 re-applies after its down"
echo "==> 0170/0171 office shelf scope and down migrations verified"

# ---------------------------------------------------------------------------
# Migration 0185: what settling an upload batch sets off, per batch, and the
# DOWN.
#
# On a database of its own, migrated to whatever precedes 0185, with one batch
# opened before it. 0185 gives that batch, and any batch opened without naming
# them, every effect of a person's upload; it refuses an unknown revision
# notice; it re-applies. The down drops the five columns and the CHECK; the up
# re-applies after it. What the columns do is upload-batches.integration.spec.ts's
# and the unit specs'.
# ---------------------------------------------------------------------------
echo "==> verifying the 0185 upload batch effects and its down migration on grid_batch_effects"
migrate_before grid_batch_effects 0185_upload_batch_effects
sql_in grid_batch_effects <<'SQL'
INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES
  ('b1b1b1b1-0000-4000-8000-000000000185', 'org_0185', 'user_1', 'office_shelf', 1);
SQL
EFFECTS_0185="SELECT string_agg(announces_completion::text || ',' || reviews_filing::text || ',' || starts_intake::text || ',' || revision_notice || ',' || runs_document_check::text, '|' ORDER BY id) FROM upload_batches"
COLUMNS_0185="SELECT count(*) FROM information_schema.columns WHERE table_name = 'upload_batches' AND column_name IN ('announces_completion', 'reviews_filing', 'starts_intake', 'revision_notice', 'runs_document_check')"
apply_in grid_batch_effects 0185_upload_batch_effects.sql
check_in grid_batch_effects "$EFFECTS_0185" "true,true,true,all,true" "0185 gives a batch opened before it every effect of a person's upload"
sql_in grid_batch_effects <<'SQL'
INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count) VALUES
  ('b2b2b2b2-0000-4000-8000-000000000185', 'org_0185', 'user_1', 'office_shelf', 1);
INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count, announces_completion, reviews_filing, starts_intake, revision_notice, runs_document_check) VALUES
  ('b3b3b3b3-0000-4000-8000-000000000185', 'org_0185', 'user_1', 'office_shelf', 1, false, false, false, 'marks_only', false);
SQL
check_in grid_batch_effects "$EFFECTS_0185" "true,true,true,all,true|true,true,true,all,true|false,false,false,marks_only,false" "0185: a batch that names no effect has all of them, a quiet one keeps what it set"
refused_in grid_batch_effects "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count, revision_notice) VALUES (gen_random_uuid(), 'org_0185', 'u', 'office_shelf', 1, 'nobody');" "upload_batches_revision_notice_known" "an unknown revision notice"
refused_in grid_batch_effects "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count, starts_intake) VALUES (gen_random_uuid(), 'org_0185', 'u', 'office_shelf', 1, NULL);" "starts_intake" "a batch with no answer to whether it starts an intake reading"
refused_in grid_batch_effects "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count, runs_document_check) VALUES (gen_random_uuid(), 'org_0185', 'u', 'office_shelf', 1, NULL);" "runs_document_check" "a batch with no answer to whether its documents are checked"
apply_in grid_batch_effects 0185_upload_batch_effects.sql
check_in grid_batch_effects "$EFFECTS_0185" "true,true,true,all,true|true,true,true,all,true|false,false,false,marks_only,false" "0185 re-applies and keeps what the batches hold"
apply_in grid_batch_effects 0185_upload_batch_effects.down.sql
check_in grid_batch_effects "$COLUMNS_0185" "0" "0185 down drops the five columns"
check_in grid_batch_effects "SELECT count(*) FROM pg_constraint WHERE conname = 'upload_batches_revision_notice_known'" "0" "0185 down drops the CHECK"
check_in grid_batch_effects "SELECT count(*) FROM upload_batches" "3" "0185 down keeps every batch"
apply_in grid_batch_effects 0185_upload_batch_effects.down.sql
apply_in grid_batch_effects 0185_upload_batch_effects.sql
check_in grid_batch_effects "$EFFECTS_0185" "true,true,true,all,true|true,true,true,all,true|true,true,true,all,true" "0185 re-applies after its down, every batch back to a person's upload"
refused_in grid_batch_effects "INSERT INTO upload_batches (id, organization_id, created_by, scope, expected_count, revision_notice) VALUES (gen_random_uuid(), 'org_0185', 'u', 'office_shelf', 1, 'nobody');" "upload_batches_revision_notice_known" "after the re-apply: an unknown revision notice"
echo "==> 0185 upload batch effects and its down migration verified"

# ---------------------------------------------------------------------------
# Migration 0186: inbound mail, mail threads and follows (ADR-0134), and the
# DOWN.
#
# On a database of its own, migrated through 0186, with two organizations and
# a third project of the first one that a legal hold will cover. Every refusal
# 0186 promises is a violating statement here, named by its constraint:
# nothing is filed without a person's file decision, a system actor never
# decides, a Piloti card and a follow carry no acknowledgement, a follow is the
# follower's own, nothing unscanned is shown or filed, a settled mail keeps no
# third party's data, every object key is the row's own. Then what the runtime
# role may do (its organization only, never a DELETE), what a decision may
# become (audited, once), what a hold stops, what deleting a document, a
# thread and a project takes along, and the down: refused while a row names an
# object, clean once none does, and 0186 applies again after it.
#
# What the repository, the jobs and the sweeps do with these rows is their own
# integration specs' (registered above); this section is what the database
# alone guarantees.
# ---------------------------------------------------------------------------
echo "==> verifying the 0186 inbound mail, threads and follows and their down migration on grid_inbound"
migrate_until grid_inbound 0186_inbound_mail
# People are WorkOS user ids: the tables refuse every other shape.
U184_A1="user_01J0MA1LUSERA00000000000A1"
U184_A2="user_01J0MA1LUSERA00000000000A2"
sql_in grid_inbound <<'SQL'
INSERT INTO projects (id, organization_id, name, created_by, collection_name) VALUES
  ('a0000000-0000-4000-8000-000000000184', 'org_0184_a', 'Mail A', 'user_01J0MA1LUSERA00000000000A1', 'proj_0184_a'),
  ('b0000000-0000-4000-8000-000000000184', 'org_0184_b', 'Mail B', 'user_01J0MA1LUSERB00000000000B1', 'proj_0184_b'),
  ('c0000000-0000-4000-8000-000000000184', 'org_0184_a', 'Mail held', 'user_01J0MA1LUSERA00000000000A1', 'proj_0184_h');
INSERT INTO documents (id, organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id) VALUES
  ('d1000000-0000-4000-8000-000000000184', 'org_0184_a', 'user_01J0MA1LUSERA00000000000A1', 'Verlauf.md', 'k/0186/a', 'proj_0184_a', 'completed', 'project', 'a0000000-0000-4000-8000-000000000184'),
  ('d3000000-0000-4000-8000-000000000184', 'org_0184_b', 'user_01J0MA1LUSERB00000000000B1', 'Plan.pdf', 'k/0186/b', 'proj_0184_b', 'completed', 'project', 'b0000000-0000-4000-8000-000000000184');
INSERT INTO inbound_mail_addresses (id, organization_id, project_id, token, slug, created_by) VALUES
  ('aa000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'aaaaaaaaaaaa', 'mail-a', 'user_01J0MA1LUSERA00000000000A1'),
  ('ab000000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'bbbbbbbbbbbb', 'mail-b', 'user_01J0MA1LUSERB00000000000B1'),
  ('ac000000-0000-4000-8000-000000000184', 'org_0184_a', 'c0000000-0000-4000-8000-000000000184', 'cccccccccccc', '', 'user_01J0MA1LUSERA00000000000A1');
INSERT INTO mail_threads (id, organization_id, project_id, document_id, base_subject, participant_domains, locale, created_by) VALUES
  ('ea000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'd1000000-0000-4000-8000-000000000184', 'Statik Dach', '{statik.at}', 'de', 'user_01J0MA1LUSERA00000000000A1'),
  ('eb000000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', NULL, 'Plan', '{}', 'en', 'user_01J0MA1LUSERB00000000000B1'),
  ('ec000000-0000-4000-8000-000000000184', 'org_0184_a', 'c0000000-0000-4000-8000-000000000184', NULL, 'Gehalten', '{}', 'de', 'user_01J0MA1LUSERA00000000000A1'),
  ('ed000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', NULL, 'Archiv', '{}', 'de', 'user_01J0MA1LUSERA00000000000A1');
INSERT INTO mail_thread_follows (id, organization_id, project_id, thread_id, user_id, expires_at) VALUES
  ('fa000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ea000000-0000-4000-8000-000000000184', 'user_01J0MA1LUSERA00000000000A1', now() + interval '60 days'),
  ('fb000000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'eb000000-0000-4000-8000-000000000184', 'user_01J0MA1LUSERB00000000000B1', now() + interval '60 days');
INSERT INTO mail_thread_entries (id, organization_id, project_id, thread_id, source, inbound_mail_id, message_id, sent_at, received_at, heading, sender_trust, own_text, filed_by, filed_via,
                                 original_bucket, original_storage_key, original_sha256, original_bytes, original_scan_status) VALUES
  ('e1000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ea000000-0000-4000-8000-000000000184', 'inbound', '1a000000-0000-4000-8000-000000000184', 'm1@statik.at', now() - interval '1 day', now(), '21.10.2026 09:00 · Huber (statik.at)', 'external_verified', 'Die Bewehrung passt.', 'user_01J0MA1LUSERA00000000000A1', 'app',
   'grid-org-a', 'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_mail-originals/e1000000-0000-4000-8000-000000000184.eml', repeat('a', 64), 2048, 'clean'),
  ('e3000000-0000-4000-8000-000000000184', 'org_0184_a', 'c0000000-0000-4000-8000-000000000184', 'ec000000-0000-4000-8000-000000000184', 'inbound', '1c000000-0000-4000-8000-000000000184', 'm3@statik.at', now() - interval '1 day', now(), '21.10.2026 09:00 · Huber (statik.at)', 'external_verified', 'Gehalten.', 'user_01J0MA1LUSERA00000000000A1', 'app',
   NULL, NULL, NULL, NULL, NULL),
  ('e4000000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'eb000000-0000-4000-8000-000000000184', 'inbound', '1b000000-0000-4000-8000-000000000184', 'm4@b.at', now() - interval '1 day', now(), '21.10.2026 09:00 · X (b.at, Domain nicht bestätigt)', 'external_unverified', 'B.', 'user_01J0MA1LUSERB00000000000B1', 'app',
   NULL, NULL, NULL, NULL, NULL);
INSERT INTO mail_thread_entries (id, organization_id, project_id, thread_id, source, mail_import_id, message_id, sent_at, received_at, heading, sender_trust, filed_by, filed_via) VALUES
  ('e2000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ea000000-0000-4000-8000-000000000184', 'archive', '9a000000-0000-4000-8000-000000000184', 'm0@buero.at', now() - interval '9 days', now() - interval '9 days', '12.10.2026 10:00 · Mayer (buero.at, aus dem Outlook-Archiv)', 'not_checked', 'user_01J0MA1LUSERA00000000000A1', 'archive_import');
INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state, entry_id) VALUES
  ('org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ea000000-0000-4000-8000-000000000184', 'm1@statik.at', 'received', 'e1000000-0000-4000-8000-000000000184'),
  ('org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ea000000-0000-4000-8000-000000000184', 'm0@buero.at', 'referenced', 'e1000000-0000-4000-8000-000000000184'),
  ('org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ea000000-0000-4000-8000-000000000184', 'm0@buero.at', 'received', 'e2000000-0000-4000-8000-000000000184'),
  ('org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'eb000000-0000-4000-8000-000000000184', 'm4@b.at', 'received', 'e4000000-0000-4000-8000-000000000184');
-- Three waiting mails: one per project, each scanned whole and checked.
INSERT INTO inbound_mails (id, organization_id, project_id, address_id, status, delivery_key, raw_size_bytes, staging_bucket, raw_storage_key, read_storage_key,
                           raw_scan_status, raw_scanned_at, message_id, sender_address, subject, sender_trust, sender_reason, signed_headers, expires_at) VALUES
  ('1a000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'aa000000-0000-4000-8000-000000000184', 'waiting', repeat('1', 64), 4096, 'grid-org-a',
   'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_inbound-mail/1a000000-0000-4000-8000-000000000184/raw.eml',
   'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_inbound-mail/1a000000-0000-4000-8000-000000000184/read.json',
   'clean', now(), 'm2@statik.at', 'huber@statik.at', 'AW: Statik Dach', 'external_verified', 'dkim_pass', '{from,subject,date,message-id,references}', now() + interval '30 days'),
  ('1b000000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'ab000000-0000-4000-8000-000000000184', 'waiting', repeat('2', 64), 4096, 'grid-org-b',
   NULL, NULL, 'clean', now(), NULL, 'x@b.at', 'Plan', 'external_unverified', 'dkim_none', '{}', now() + interval '30 days'),
  ('1c000000-0000-4000-8000-000000000184', 'org_0184_a', 'c0000000-0000-4000-8000-000000000184', 'ac000000-0000-4000-8000-000000000184', 'waiting', repeat('3', 64), 4096, 'grid-org-a',
   NULL, NULL, 'clean', now(), NULL, 'x@h.at', 'Held', 'external_unverified', 'dkim_none', '{}', now() + interval '30 days');
INSERT INTO inbound_mail_parts (id, organization_id, project_id, mail_id, position, kind, filename, content_type, size_bytes, sha256, storage_key, scan_status, scanned_at) VALUES
  ('2a000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', '1a000000-0000-4000-8000-000000000184', 0, 'message', NULL, 'text/plain', 120, repeat('a', 64), NULL, 'not_applicable', NULL),
  ('2b000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', '1a000000-0000-4000-8000-000000000184', 1, 'attachment', 'S-101.pdf', 'application/pdf', 2048, repeat('b', 64),
   'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_inbound-mail/1a000000-0000-4000-8000-000000000184/1', 'clean', now()),
  ('2c000000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', '1b000000-0000-4000-8000-000000000184', 0, 'message', NULL, 'text/plain', 10, repeat('c', 64), NULL, 'not_applicable', NULL),
  ('2d000000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', '1a000000-0000-4000-8000-000000000184', 2, 'attachment', 'Rechnung.docm', 'application/vnd.ms-word.document.macroEnabled.12', 512, repeat('d', 64),
   'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_inbound-mail/1a000000-0000-4000-8000-000000000184/2', 'pending', NULL);
INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by) VALUES
  ('org_0184_b', 'b0000000-0000-4000-8000-000000000184', '1b000000-0000-4000-8000-000000000184', '2c000000-0000-4000-8000-000000000184', 'dismiss', 'user_01J0MA1LUSERB00000000000B1');
SQL
check_in grid_inbound "SELECT count(*) FROM inbound_mail_parts WHERE state = 'waiting'" "4" "0186: parts wait for a person"

# Insert prefixes for the violating rows below. Each refusal names its rule; a
# trigger's refusal carries its rule as the error's constraint name, which psql
# prints only when verbose ($V184).
V184=$'\\set VERBOSITY verbose\n'
PA184="'org_0184_a', 'a0000000-0000-4000-8000-000000000184'"
ADDR184="INSERT INTO inbound_mail_addresses (organization_id, project_id, token, slug, created_by, revoked_at, revoked_by, revoked_reason) VALUES ($PA184"
MAIL184="INSERT INTO inbound_mails (organization_id, project_id, address_id, status, delivery_key, raw_size_bytes, staging_bucket, raw_scan_status, raw_scanned_at, sender_address, sender_trust, sender_user_id, sender_flags, authentication_results, dropped_reason, subject, expires_at, sender_reason) VALUES ($PA184, 'aa000000-0000-4000-8000-000000000184'"
PART184="INSERT INTO inbound_mail_parts (organization_id, project_id, mail_id, position, kind, filename, content_type, size_bytes, sha256, storage_key, scan_status, scanned_at, risk_flags, name_stop_terms) VALUES ($PA184, '1a000000-0000-4000-8000-000000000184'"
KEY184="'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_inbound-mail/1a000000-0000-4000-8000-000000000184"
DEC184="INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, via, proposal_id, follow_id, folder_path, thread_action, mail_thread_id, message_text, file_name, screening_release, acknowledged_sender, acknowledged_risk) VALUES ($PA184, '1a000000-0000-4000-8000-000000000184'"
THREAD184="INSERT INTO mail_threads (organization_id, project_id, document_id, base_subject, locale, created_by) VALUES ($PA184"
ENTRY184="INSERT INTO mail_thread_entries (organization_id, project_id, thread_id, source, inbound_mail_id, mail_import_id, sent_at, received_at, heading, sender_trust, filed_by, filed_via, authentication_results, original_bucket, original_storage_key, original_sha256, original_bytes, original_scan_status) VALUES ($PA184, 'ea000000-0000-4000-8000-000000000184'"
FOLLOW184="INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, created_at, expires_at, ended_at, ended_by, ended_reason) VALUES ($PA184, 'ea000000-0000-4000-8000-000000000184'"

# Addresses: the token's shape, global and never reused, one active per project.
refused_in grid_inbound "$ADDR184, 'AAAAAAAAAAAA', '', '$U184_A1', NULL, NULL, NULL)" "inbound_mail_addresses_token_shape" "a token that is not lowercase base32"
refused_in grid_inbound "$ADDR184, 'dddddddddddd', 'a.b', '$U184_A1', NULL, NULL, NULL)" "inbound_mail_addresses_slug_shape" "a slug with a dot"
refused_in grid_inbound "$ADDR184, 'dddddddddddd', '', '$U184_A1', now(), NULL, 'rotated')" "inbound_mail_addresses_revocation_attributed" "a revocation nobody made"
refused_in grid_inbound "$ADDR184, 'dddddddddddd', '', '$U184_A1', now(), '$U184_A1', 'lost')" "inbound_mail_addresses_revoked_reason_known" "an unknown revocation reason"
refused_in grid_inbound "$ADDR184, 'dddddddddddd', '', '$U184_A1', NULL, NULL, NULL)" "uniq_inbound_mail_addresses_active_project" "a second active address for a project"
sql_in grid_inbound <<<"UPDATE inbound_mail_addresses SET revoked_at = now(), revoked_by = '$U184_A1', revoked_reason = 'rotated' WHERE id = 'ac000000-0000-4000-8000-000000000184';"
refused_in grid_inbound "INSERT INTO inbound_mail_addresses (organization_id, project_id, token, created_by) VALUES ('org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'cccccccccccc', 'u')" "uniq_inbound_mail_addresses_token" "a revoked token minted again, even in another organization"
refused_in grid_inbound "INSERT INTO inbound_mail_addresses (organization_id, project_id, token, created_by) VALUES ('org_0184_b', 'c0000000-0000-4000-8000-000000000184', 'dddddddddddd', 'u')" "inbound_mail_addresses_project_fkey" "an address on another organization's project"

# Mails: idempotent per address, scanned before shown, the verdict's shape, the scrub.
refused_in grid_inbound "$MAIL184, 'waiting', repeat('1', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "uniq_inbound_mails_address_delivery" "the same delivery twice to one address"
refused_in grid_inbound "$MAIL184, 'queued', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_status_known" "an unknown status"
refused_in grid_inbound "$MAIL184, 'received', NULL, 1, 'b', 'pending', NULL, NULL, NULL, NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', NULL)" "inbound_mails_delivery_key_when_received" "a received mail without its delivery key"
refused_in grid_inbound "$MAIL184, 'receiving', 'ABC', NULL, 'b', 'pending', NULL, NULL, NULL, NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', NULL)" "inbound_mails_delivery_key_shape" "a delivery key that is not a sha256"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'pending', NULL, 'x@y.at', 'external_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_waiting_is_scanned" "a mail shown before its raw message was scanned"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'member_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_member_has_user" "a member's mail that names no member"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', '$U184_A1', '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_member_has_user" "an outsider's mail that names a member"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'member_unverified', 'system:inbound_mail', '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_none')" "inbound_mails_sender_user_is_person" "a member that is not a person's id"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{trusted}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_sender_flags_known" "an unknown sender flag"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{}', 'piloti.at; dkim=pass header.d=y.at; SPF=temperror', NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_authentication_results_shape" "a stored evidence line that carries spf= (RT-S18)"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_unverified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_maybe')" "inbound_mails_sender_reason_known" "an unknown sender reason"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_unverified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_reason_with_trust" "a DKIM pass labelled unverified"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_fail')" "inbound_mails_reason_with_trust" "a verified sender whose signature failed"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', NULL)" "inbound_mails_reason_with_trust" "a verdict that says no why"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'member_verified', '$U184_A1', '{bcc_own}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_bcc_own_paired" "a Bcc copy that is not also flagged as addressed elsewhere"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{not_addressed_to_project,bcc_own}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_bcc_own_paired" "an outsider's mail treated as a member's own Bcc copy"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), NULL, 'external_verified', NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', 'dkim_pass')" "inbound_mails_sender_while_open" "a waiting mail that says nobody wrote it"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', NULL, NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', NULL)" "inbound_mails_trust_when_shown" "a waiting mail nobody checked"
refused_in grid_inbound "$MAIL184, 'dropped', repeat('4', 64), 1, 'b', 'clean', now(), NULL, NULL, NULL, '{}', NULL, NULL, NULL, now() + interval '1 day', NULL)" "inbound_mails_dropped_with_reason" "a dropped mail without its reason"
refused_in grid_inbound "$MAIL184, 'settled', repeat('4', 64), 1, 'b', 'clean', now(), NULL, 'external_verified', NULL, '{}', NULL, NULL, 'Betreff', now() + interval '1 day', 'dkim_pass')" "inbound_mails_ended_is_scrubbed" "a settled mail that keeps its subject"
refused_in grid_inbound "$MAIL184, 'waiting', repeat('4', 64), 1, 'b', 'clean', now(), 'x@y.at', 'external_verified', NULL, '{}', NULL, NULL, NULL, now() - interval '1 day', 'dkim_pass')" "inbound_mails_expires_after_received" "a mail that expired before it arrived"
refused_in grid_inbound "INSERT INTO inbound_mails (organization_id, project_id, address_id, staging_bucket, expires_at) VALUES ('org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'ab000000-0000-4000-8000-000000000184', 'b', now() + interval '1 day')" "inbound_mails_address_fkey" "a mail on another organization's address"
refused_in grid_inbound "UPDATE inbound_mails SET raw_storage_key = 'org/org_0184_b/project/b0000000-0000-4000-8000-000000000184/_inbound-mail/1a000000-0000-4000-8000-000000000184/raw.eml' WHERE id = '1a000000-0000-4000-8000-000000000184'" "inbound_mails_staging_keys_shape" "a staged key outside the row's own project"
refused_in grid_inbound "UPDATE inbound_mails SET raw_storage_key = 'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/doc/x/raw.eml' WHERE id = '1a000000-0000-4000-8000-000000000184'" "inbound_mails_staging_keys_shape" "a staged key outside the reserved prefix"
refused_in grid_inbound "UPDATE inbound_mails SET signed_headers = '{From}' WHERE id = '1a000000-0000-4000-8000-000000000184'" "inbound_mails_signed_headers_shape" "a signed header that is not lowercase"
refused_in grid_inbound "UPDATE inbound_mails SET status = 'settled', settled_at = now(), sender_address = NULL, subject = NULL WHERE id = '1a000000-0000-4000-8000-000000000184'" "inbound_mails_ended_is_scrubbed" "a settled mail whose staged objects are still named"
sql_in grid_inbound <<<"UPDATE inbound_mails SET status = 'settled', settled_at = now(), sender_address = NULL, subject = NULL, raw_storage_key = NULL, read_storage_key = NULL, erasure_deferred_at = NULL WHERE id = '1c000000-0000-4000-8000-000000000184';"
sql_in grid_inbound <<<"UPDATE inbound_mails SET status = 'waiting', settled_at = NULL, sender_address = 'x@h.at', subject = 'Held' WHERE id = '1c000000-0000-4000-8000-000000000184';"

# Parts: their one key, scanned before filed, the flags they may carry.
refused_in grid_inbound "$PART184, 3, 'attachment', 'a.pdf', 'application/pdf', 1, repeat('e', 64), $KEY184/4', 'pending', NULL, '{}', '{}')" "inbound_mail_parts_storage_key_shape" "an attachment staged under another position's key"
refused_in grid_inbound "$PART184, 3, 'message', 'a.txt', 'text/plain', 1, repeat('e', 64), NULL, 'not_applicable', NULL, '{}', '{}')" "inbound_mail_parts_message_has_no_object" "a message part with a file name"
sql_in grid_inbound <<<"$PART184, 5, 'attachment', NULL, 'application/octet-stream', 1, repeat('e', 64), $KEY184/5', 'pending', NULL, '{}', '{}');"
check_in grid_inbound "SELECT count(*) FROM inbound_mail_parts WHERE filename IS NULL AND kind = 'attachment'" "1" "0186: a file that came without a name is staged, for the person to name"
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'dismissed', ended_at = now(), storage_key = NULL WHERE id = '2d000000-0000-4000-8000-000000000184'" "inbound_mail_parts_name_with_bytes" "a file name kept after its bytes were erased"
refused_in grid_inbound "$PART184, 3, 'attachment', NULL, 'application/pdf', 1, repeat('e', 64), NULL, 'pending', NULL, '{}', '{}')" "inbound_mail_parts_bytes_while_open" "a waiting attachment without bytes"
refused_in grid_inbound "$PART184, 3, 'message', NULL, 'text/plain', 1, repeat('e', 64), NULL, 'clean', now(), '{}', '{}')" "inbound_mail_parts_scan_applies" "the text scanned on its own"
refused_in grid_inbound "$PART184, 3, 'attachment', 'a.pdf', 'application/pdf', 1, repeat('e', 64), $KEY184/3', 'not_applicable', NULL, '{}', '{}')" "inbound_mail_parts_scan_applies" "an attachment exempt from the scan"
refused_in grid_inbound "$PART184, 3, 'attachment', 'a.pdf', 'application/pdf', 1, repeat('e', 64), $KEY184/3', 'pending', NULL, '{harmless}', '{}')" "inbound_mail_parts_risk_flags_known" "an unknown risk flag"
refused_in grid_inbound "$PART184, 3, 'attachment', 'a.pdf', 'application/pdf', 1, repeat('e', 64), $KEY184/3', 'pending', NULL, '{}', '{Gehalt}')" "inbound_mail_parts_name_stop_terms" "name-stop terms without the flag"
refused_in grid_inbound "$PART184, 1, 'attachment', 'a.pdf', 'application/pdf', 1, repeat('e', 64), $KEY184/1', 'pending', NULL, '{}', '{}')" "inbound_mail_parts_mail_position_key" "two parts at one position"
refused_in grid_inbound "INSERT INTO inbound_mail_parts (organization_id, project_id, mail_id, position, kind, content_type, size_bytes, sha256, scan_status) VALUES ('org_0184_a', 'a0000000-0000-4000-8000-000000000184', '1b000000-0000-4000-8000-000000000184', 9, 'message', 'text/plain', 1, repeat('e', 64), 'not_applicable')" "inbound_mail_parts_mail_fkey" "a part of another organization's mail"
refused_in grid_inbound "UPDATE inbound_mail_parts SET mail_thread_entry_id = 'e1000000-0000-4000-8000-000000000184' WHERE id = '2a000000-0000-4000-8000-000000000184'" "inbound_mail_parts_entry_only_for_filed_message" "a waiting text that names an entry"
refused_in grid_inbound "UPDATE inbound_mail_parts SET last_failure = 'gremlins' WHERE id = '2b000000-0000-4000-8000-000000000184'" "inbound_mail_parts_failure_known" "an unknown filing failure"
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'dismissed' WHERE id = '2b000000-0000-4000-8000-000000000184'" "inbound_mail_parts_ended_at" "a dismissed part that does not say when"

# Nothing is filed without a person's file decision about THAT part (RT-S7).
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'filing', claim_expires_at = now() + interval '5 minutes' WHERE id = '2b000000-0000-4000-8000-000000000184'" "inbound_mail_parts_decision_iff_filing" "a part claimed for filing with no decision"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', 'system:inbound_mail', 'app', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_decider_is_person" "a system actor deciding"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', 'user_1', 'app', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_decider_is_person" "a decider that is not a WorkOS user id"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'accept', '$U184_A1', 'app', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_action_known" "an unknown action"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'rule', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_via_known" "a decision that came by a rule"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'piloti_proposal', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_proposal_iff_card" "a Piloti card that names no proposal"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'piloti_proposal', gen_random_uuid(), NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, true)" "inbound_mail_decisions_piloti_cards_file_clean" "a Piloti card that acknowledges a risk (RT-S5)"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'piloti_proposal', gen_random_uuid(), NULL, 'Statik', NULL, NULL, NULL, NULL, true, false, false)" "inbound_mail_decisions_piloti_cards_file_clean" "a Piloti card that releases a stopped name (RT-S5)"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'app', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_destination_when_filing" "a filing with nowhere to go"
refused_in grid_inbound "$DEC184, '2b000000-0000-4000-8000-000000000184', 'dismiss', '$U184_A1', 'app', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_destination_when_filing" "a dismissal with a destination"
refused_in grid_inbound "${V184}$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'app', NULL, NULL, 'Statik', 'create', NULL, 'full', 'Statik', false, false, false)" "inbound_mail_decisions_thread_for_text" "an attachment filed into a thread"
refused_in grid_inbound "${V184}$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'app', NULL, NULL, 'Statik', NULL, NULL, NULL, NULL, false, false, false)" "inbound_mail_decisions_thread_for_text" "a mail text filed outside a thread"
refused_in grid_inbound "$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'app', NULL, NULL, NULL, 'append', NULL, 'full', NULL, false, false, false)" "inbound_mail_decisions_thread_named" "an append that names no thread"
refused_in grid_inbound "$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'app', NULL, NULL, NULL, 'append', 'ea000000-0000-4000-8000-000000000184', NULL, NULL, false, false, false)" "inbound_mail_decisions_message_text" "a filed text that says neither masked nor full"
# A follow decision: the follower's own, a text appended, nothing acknowledged (D31).
refused_in grid_inbound "$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A2', 'follow', NULL, 'fa000000-0000-4000-8000-000000000184', NULL, 'append', 'ea000000-0000-4000-8000-000000000184', 'full', NULL, false, false, false)" "inbound_mail_decisions_follower_fkey" "a follow decision by someone other than the follower"
refused_in grid_inbound "$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'follow', NULL, 'fb000000-0000-4000-8000-000000000184', NULL, 'append', 'eb000000-0000-4000-8000-000000000184', 'full', NULL, false, false, false)" "inbound_mail_decisions_follower_fkey" "a follow decision on another organization's follow"
refused_in grid_inbound "$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'follow', NULL, 'fa000000-0000-4000-8000-000000000184', NULL, 'append', 'ea000000-0000-4000-8000-000000000184', 'full', NULL, false, true, false)" "inbound_mail_decisions_follow_appends_text_only" "a follow that acknowledges a sender"
refused_in grid_inbound "$DEC184, '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'follow', NULL, 'fa000000-0000-4000-8000-000000000184', 'Statik', 'create', NULL, 'full', 'Neu', false, false, false)" "inbound_mail_decisions_follow_appends_text_only" "a follow that starts a new thread"
refused_in grid_inbound "${V184}$DEC184, '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'follow', NULL, 'fa000000-0000-4000-8000-000000000184', NULL, 'append', 'ea000000-0000-4000-8000-000000000184', 'full', NULL, false, false, false)" "inbound_mail_decisions_follow_files_text" "a follow that files an attachment"
refused_in grid_inbound "INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by) VALUES ('org_0184_a', 'a0000000-0000-4000-8000-000000000184', '1b000000-0000-4000-8000-000000000184', '2c000000-0000-4000-8000-000000000184', 'dismiss', '$U184_A1')" "inbound_mail_decisions_part_fkey" "a decision about another organization's part"

# The decisions a person makes, and the parts they move.
sql_in grid_inbound <<SQL
INSERT INTO inbound_mail_decisions (id, organization_id, project_id, mail_id, part_id, action, decided_by, via, folder_path) VALUES
  ('3a000000-0000-4000-8000-000000000184', $PA184, '1a000000-0000-4000-8000-000000000184', '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'app', 'Statik'),
  ('3b000000-0000-4000-8000-000000000184', $PA184, '1a000000-0000-4000-8000-000000000184', '2b000000-0000-4000-8000-000000000184', 'file', '$U184_A2', 'agent', 'Statik/Plaene');
INSERT INTO inbound_mail_decisions (id, organization_id, project_id, mail_id, part_id, action, decided_by) VALUES
  ('3c000000-0000-4000-8000-000000000184', $PA184, '1a000000-0000-4000-8000-000000000184', '2d000000-0000-4000-8000-000000000184', 'dismiss', '$U184_A1');
INSERT INTO inbound_mail_decisions (id, organization_id, project_id, mail_id, part_id, action, decided_by, via, proposal_id, folder_path) VALUES
  ('3e000000-0000-4000-8000-000000000184', $PA184, '1a000000-0000-4000-8000-000000000184', '2d000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'piloti_proposal', gen_random_uuid(), 'Rechnungen');
INSERT INTO inbound_mail_decisions (id, organization_id, project_id, mail_id, part_id, action, decided_by, via, follow_id, thread_action, mail_thread_id, message_text) VALUES
  ('3d000000-0000-4000-8000-000000000184', $PA184, '1a000000-0000-4000-8000-000000000184', '2a000000-0000-4000-8000-000000000184', 'file', '$U184_A1', 'follow', 'fa000000-0000-4000-8000-000000000184', 'append', 'ea000000-0000-4000-8000-000000000184', 'full');
SQL
refused_in grid_inbound "${V184}UPDATE inbound_mail_parts SET state = 'filing', decision_id = '3c000000-0000-4000-8000-000000000184', claim_expires_at = now() + interval '5 minutes' WHERE id = '2d000000-0000-4000-8000-000000000184'" "inbound_mail_parts_decision_files" "a part filed on a dismiss decision"
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'filing', decision_id = '3e000000-0000-4000-8000-000000000184', claim_expires_at = now() + interval '5 minutes' WHERE id = '2b000000-0000-4000-8000-000000000184'" "inbound_mail_parts_decision_fkey" "a part filed on another part's decision"
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'filing', decision_id = '3e000000-0000-4000-8000-000000000184', claim_expires_at = now() + interval '5 minutes' WHERE id = '2d000000-0000-4000-8000-000000000184'" "inbound_mail_parts_filed_is_clean" "a part filed before its scan said clean"
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'filing', decision_id = '3a000000-0000-4000-8000-000000000184' WHERE id = '2b000000-0000-4000-8000-000000000184'" "inbound_mail_parts_claim_while_filing" "a filing part with no claim"
# Two deciders: both decisions are kept, one compare-and-swap claims the part.
CAS184="UPDATE inbound_mail_parts SET state = 'filing', claim_expires_at = now() + interval '5 minutes', decision_id = '%s' WHERE id = '2b000000-0000-4000-8000-000000000184' AND state = 'waiting' RETURNING 1"
check_in grid_inbound "WITH c AS ($(printf "$CAS184" 3a000000-0000-4000-8000-000000000184)) SELECT count(*) FROM c" "1" "0186: the first decider claims the part"
check_in grid_inbound "WITH c AS ($(printf "$CAS184" 3b000000-0000-4000-8000-000000000184)) SELECT count(*) FROM c" "0" "0186: the second decider's claim finds the part taken"
check_in grid_inbound "SELECT decided_by FROM inbound_mail_decisions d JOIN inbound_mail_parts p ON p.decision_id = d.id WHERE p.id = '2b000000-0000-4000-8000-000000000184'" "$U184_A1" "0186: the part names the decider who claimed it"
refused_in grid_inbound "UPDATE inbound_mail_parts SET state = 'filed', claim_expires_at = NULL, filed_at = now() WHERE id = '2b000000-0000-4000-8000-000000000184'" "inbound_mail_parts_no_bytes_when_filed" "a filed part still holding its staged bytes"
sql_in grid_inbound <<'SQL'
UPDATE inbound_mail_parts SET state = 'filed', claim_expires_at = NULL, filed_at = now(), storage_key = NULL, filename = NULL,
       document_id = 'd1000000-0000-4000-8000-000000000184'
 WHERE id = '2b000000-0000-4000-8000-000000000184';
UPDATE inbound_mail_parts SET state = 'filed', decision_id = '3d000000-0000-4000-8000-000000000184', filed_at = now(),
       mail_thread_entry_id = 'e1000000-0000-4000-8000-000000000184'
 WHERE id = '2a000000-0000-4000-8000-000000000184';
UPDATE inbound_mail_parts SET state = 'dismissed', ended_at = now() WHERE id = '2d000000-0000-4000-8000-000000000184';
SQL
check_in grid_inbound "SELECT string_agg(state, ',' ORDER BY position) FROM inbound_mail_parts WHERE mail_id = '1a000000-0000-4000-8000-000000000184'" "filed,filed,dismissed,waiting" "0186: the text appended by the follower, the attachment filed, the macro file dismissed, the nameless file still waiting"
# A decision is append-only: it is marked audited once, and nothing else changes.
refused_in grid_inbound "${V184}UPDATE inbound_mail_decisions SET folder_path = 'Anderswo' WHERE id = '3a000000-0000-4000-8000-000000000184'" "inbound_mail_decisions_immutable" "a decision rewritten"
sql_in grid_inbound <<<"UPDATE inbound_mail_decisions SET audited_at = now() WHERE id = '3a000000-0000-4000-8000-000000000184';"
refused_in grid_inbound "${V184}UPDATE inbound_mail_decisions SET audited_at = now() + interval '1 hour' WHERE id = '3a000000-0000-4000-8000-000000000184'" "inbound_mail_decisions_immutable" "a decision audited twice"
refused_in grid_inbound "${V184}DELETE FROM inbound_mail_decisions WHERE id = '3b000000-0000-4000-8000-000000000184'" "inbound_mail_decisions_audited_before_delete" "a decision deleted before the audit trail took it, even by the owner (RT-S8)"

# A decision's Dokumentart is the shared vocabulary's, whose persisted keys are
# still German today (D6 renames them later): the code checks membership, the
# database bounds the value to one printable line.
sql_in grid_inbound <<<"$DEC184, '2d000000-0000-4000-8000-000000000184', 'dismiss', '$U184_A2', 'app', NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, false);"
sql_in grid_inbound <<<"INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, folder_path, document_type, audited_at) VALUES ($PA184, '1a000000-0000-4000-8000-000000000184', '2d000000-0000-4000-8000-000000000184', 'file', '$U184_A2', 'Normen', 'Norm/Richtlinie', now());"
refused_in grid_inbound "INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, folder_path, document_type) VALUES ($PA184, '1a000000-0000-4000-8000-000000000184', '2d000000-0000-4000-8000-000000000184', 'file', '$U184_A2', 'X', E'Bescheid\\nNorm')" "inbound_mail_decisions_lengths" "a Dokumentart that is not one printable line"
refused_in grid_inbound "INSERT INTO inbound_mail_decisions (organization_id, project_id, mail_id, part_id, action, decided_by, folder_path, document_type) VALUES ($PA184, '1a000000-0000-4000-8000-000000000184', '2d000000-0000-4000-8000-000000000184', 'file', '$U184_A2', 'X', repeat('x', 65))" "inbound_mail_decisions_lengths" "a Dokumentart past its bound"

# What came with a filed message (D36): one row per attachment, its document
# and Fassung the live half of the link, what the section prints frozen.
sql_in grid_inbound <<'SQL'
INSERT INTO document_versions (id, organization_id, document_id, project_id, version_number, state, storage_key, created_by) VALUES
  ('f1000000-0000-4000-8000-000000000184', 'org_0184_a', 'd1000000-0000-4000-8000-000000000184', 'a0000000-0000-4000-8000-000000000184', 1, 'superseded', 'k/0186/a', 'user_01J0MA1LUSERA00000000000A1');
INSERT INTO mail_thread_entry_attachments (id, organization_id, project_id, entry_id, position, filename, disposition, not_filed_reason, document_id, document_version_id, section_name, section_folder_path) VALUES
  ('fa100000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'e1000000-0000-4000-8000-000000000184', 1, 'S-101.pdf', 'filed', NULL, 'd1000000-0000-4000-8000-000000000184', 'f1000000-0000-4000-8000-000000000184', 'S-101.pdf', 'Statik'),
  ('fa200000-0000-4000-8000-000000000184', 'org_0184_a', 'a0000000-0000-4000-8000-000000000184', 'e1000000-0000-4000-8000-000000000184', 2, 'Rechnung.docm', 'not_filed', 'pending', NULL, NULL, NULL, NULL),
  ('fa300000-0000-4000-8000-000000000184', 'org_0184_a', 'c0000000-0000-4000-8000-000000000184', 'e3000000-0000-4000-8000-000000000184', 1, 'Gehalten.pdf', 'not_filed', 'dismissed', NULL, NULL, NULL, NULL),
  ('fa400000-0000-4000-8000-000000000184', 'org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'e4000000-0000-4000-8000-000000000184', 1, NULL, 'not_filed', 'size', NULL, NULL, NULL, NULL);
-- The filed part names the Fassung it became, as the filing job records it.
UPDATE inbound_mail_parts SET document_version_id = 'f1000000-0000-4000-8000-000000000184'
 WHERE id = '2b000000-0000-4000-8000-000000000184';
SQL
ATT184="INSERT INTO mail_thread_entry_attachments (organization_id, project_id, entry_id, position, disposition, not_filed_reason, document_id, document_version_id, section_name, section_folder_path) VALUES ($PA184, 'e1000000-0000-4000-8000-000000000184'"
refused_in grid_inbound "$ATT184, 1, 'not_filed', 'dismissed', NULL, NULL, NULL, NULL)" "mail_thread_entry_attachments_entry_position_key" "two rows for one attachment"
refused_in grid_inbound "$ATT184, 3, 'kept', NULL, NULL, NULL, NULL, NULL)" "mail_thread_entry_attachments_disposition_known" "an unknown disposition"
refused_in grid_inbound "$ATT184, 3, 'filed', 'dismissed', 'd1000000-0000-4000-8000-000000000184', NULL, NULL, NULL)" "mail_thread_entry_attachments_reason_iff_not_filed" "a filed attachment with a reason it was not filed"
refused_in grid_inbound "$ATT184, 3, 'not_filed', NULL, NULL, NULL, NULL, NULL)" "mail_thread_entry_attachments_reason_iff_not_filed" "an attachment not filed for no reason"
refused_in grid_inbound "$ATT184, 3, 'not_filed', 'forgotten', NULL, NULL, NULL, NULL)" "mail_thread_entry_attachments_reason_known" "an unknown reason"
refused_in grid_inbound "$ATT184, 3, 'not_filed', 'dismissed', 'd1000000-0000-4000-8000-000000000184', NULL, NULL, NULL)" "mail_thread_entry_attachments_not_filed_has_no_document" "an attachment not filed that names a document"
refused_in grid_inbound "$ATT184, 3, 'not_filed', 'dismissed', NULL, NULL, 'Gehaltsliste.xlsx', NULL)" "mail_thread_entry_attachments_section_named_when_filed" "a section that names an attachment nobody filed (RT-S13)"
refused_in grid_inbound "$ATT184, 3, 'filed', NULL, 'd1000000-0000-4000-8000-000000000184', NULL, NULL, 'Intern')" "mail_thread_entry_attachments_section_folder_with_name" "a section that names a folder and no file"
refused_in grid_inbound "$ATT184, 3, 'filed', NULL, 'd3000000-0000-4000-8000-000000000184', NULL, NULL, NULL)" "mail_thread_entry_attachments_document_fkey" "an attachment filed as another project's document"
refused_in grid_inbound "INSERT INTO mail_thread_entry_attachments (organization_id, project_id, entry_id, position, disposition, not_filed_reason) VALUES ('org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'e1000000-0000-4000-8000-000000000184', 5, 'not_filed', 'size')" "mail_thread_entry_attachments_entry_fkey" "an attachment row on another organization's entry"
refused_in grid_inbound "${V184}UPDATE mail_thread_entry_attachments SET section_name = 'Gehaltsliste.xlsx' WHERE id = 'fa100000-0000-4000-8000-000000000184'" "mail_thread_entry_attachments_frozen" "a section's frozen words rewritten (the superset invariant)"
refused_in grid_inbound "${V184}UPDATE mail_thread_entry_attachments SET disposition = 'not_filed', not_filed_reason = 'dismissed', document_id = NULL, document_version_id = NULL WHERE id = 'fa100000-0000-4000-8000-000000000184'" "mail_thread_entry_attachments_decided_once" "a filed attachment turned into one never filed"
sql_in grid_inbound <<<"UPDATE mail_thread_entry_attachments SET disposition = 'filed', not_filed_reason = NULL, document_id = 'd1000000-0000-4000-8000-000000000184' WHERE id = 'fa200000-0000-4000-8000-000000000184';"
check_in grid_inbound "SELECT disposition || ':' || coalesce(section_name, 'unnamed') FROM mail_thread_entry_attachments WHERE id = 'fa200000-0000-4000-8000-000000000184'" "filed:unnamed" "0186: an attachment that waited is filed later, and the section's words stay frozen"
refused_in grid_inbound "${V184}UPDATE mail_thread_entry_attachments SET document_id = 'd1000000-0000-4000-8000-000000000184', disposition = 'already_present' WHERE id = 'fa200000-0000-4000-8000-000000000184'" "mail_thread_entry_attachments_decided_once" "an attachment decided twice"
refused_in grid_inbound "UPDATE mail_threads SET render_lease_holder = gen_random_uuid() WHERE id = 'ea000000-0000-4000-8000-000000000184'" "mail_threads_render_lease_together" "a render lease without its end"

# Threads, entries, message ids and follows.
refused_in grid_inbound "$THREAD184, NULL, 'x', 'fr', '$U184_A1')" "mail_threads_locale_known" "a thread in a locale nobody renders"
refused_in grid_inbound "$THREAD184, NULL, 'x', 'de', 'system:archive')" "mail_threads_creator_is_person" "a thread nobody created"
refused_in grid_inbound "$THREAD184, 'd3000000-0000-4000-8000-000000000184', 'x', 'de', '$U184_A1')" "mail_threads_document_fkey" "a thread whose document is another project's"
refused_in grid_inbound "$THREAD184, 'd1000000-0000-4000-8000-000000000184', 'x', 'de', '$U184_A1')" "uniq_mail_threads_document" "a second thread on one document"
refused_in grid_inbound "UPDATE mail_threads SET entry_count = 201 WHERE id = 'ea000000-0000-4000-8000-000000000184'" "mail_threads_entry_count_bounded" "a thread past its entry cap"
refused_in grid_inbound "$ENTRY184, 'archive', NULL, gen_random_uuid(), now(), now(), 'h1', 'not_checked', '$U184_A1', 'archive_import', NULL, 'b', 'k', repeat('a', 64), 1, 'clean')" "mail_thread_entries_archive_has_no_original" "an archive entry with an original"
refused_in grid_inbound "$ENTRY184, 'archive', NULL, gen_random_uuid(), now(), now(), 'h1', 'external_verified', '$U184_A1', 'archive_import', NULL, NULL, NULL, NULL, NULL, NULL)" "mail_thread_entries_archive_not_checked" "an archive entry that claims a checked sender"
refused_in grid_inbound "$ENTRY184, 'inbound', gen_random_uuid(), NULL, now(), now(), 'h1', 'external_verified', '$U184_A1', 'archive_import', NULL, NULL, NULL, NULL, NULL, NULL)" "mail_thread_entries_archive_imported" "an inbound entry filed by an import"
refused_in grid_inbound "$ENTRY184, 'inbound', NULL, NULL, now(), now(), 'h1', 'external_verified', '$U184_A1', 'app', NULL, NULL, NULL, NULL, NULL, NULL)" "mail_thread_entries_provenance" "an inbound entry that names no mail"
refused_in grid_inbound "$ENTRY184, 'inbound', gen_random_uuid(), NULL, now(), now(), 'h1', 'external_verified', 'system:follow', 'follow', NULL, NULL, NULL, NULL, NULL, NULL)" "mail_thread_entries_filer_is_person" "an entry nobody filed"
refused_in grid_inbound "$ENTRY184, 'inbound', gen_random_uuid(), NULL, now(), now(), 'h1', 'external_verified', '$U184_A1', 'app', 'piloti.at; spf=pass', NULL, NULL, NULL, NULL, NULL)" "mail_thread_entries_authentication_results_shape" "an entry's evidence line with spf="
refused_in grid_inbound "$ENTRY184, 'inbound', gen_random_uuid(), NULL, now(), now(), 'h1', 'external_verified', '$U184_A1', 'app', NULL, 'b', NULL, repeat('a', 64), 1, 'clean')" "mail_thread_entries_original_together" "half an original"
refused_in grid_inbound "$ENTRY184, 'inbound', gen_random_uuid(), NULL, now(), now(), 'h1', 'external_verified', '$U184_A1', 'app', NULL, 'b', 'org/org_0184_a/project/a0000000-0000-4000-8000-000000000184/_mail-originals/e1000000-0000-4000-8000-000000000184.eml', repeat('a', 64), 1, 'clean')" "mail_thread_entries_original_key_shape" "an original under another entry's key"
refused_in grid_inbound "$ENTRY184, 'inbound', gen_random_uuid(), NULL, now(), now(), '21.10.2026 09:00 · Huber (statik.at)', 'external_verified', '$U184_A1', 'app', NULL, NULL, NULL, NULL, NULL, NULL)" "mail_thread_entries_heading_key" "two sections with one heading"
refused_in grid_inbound "INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state) VALUES ($PA184, 'ea000000-0000-4000-8000-000000000184', 'm9@x.at', 'received')" "mail_thread_message_ids_received_by_entry" "a received id with no entry"
refused_in grid_inbound "INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state, entry_id) VALUES ($PA184, 'eb000000-0000-4000-8000-000000000184', 'm1@statik.at', 'received', 'e1000000-0000-4000-8000-000000000184')" "mail_thread_message_ids_thread_fkey" "an id in another organization's thread"
refused_in grid_inbound "INSERT INTO mail_thread_message_ids (organization_id, project_id, thread_id, message_id, state, entry_id) VALUES ($PA184, 'ea000000-0000-4000-8000-000000000184', 'm1@statik.at', 'received', 'e1000000-0000-4000-8000-000000000184')" "mail_thread_message_ids_key" "the same id received twice by one entry"
refused_in grid_inbound "$FOLLOW184, 'system:follow', now(), now() + interval '1 day', NULL, NULL, NULL)" "mail_thread_follows_follower_is_person" "a follow nobody made"
refused_in grid_inbound "$FOLLOW184, '$U184_A2', now(), now() + interval '181 days', NULL, NULL, NULL)" "mail_thread_follows_window" "a follow past 180 days"
refused_in grid_inbound "$FOLLOW184, '$U184_A1', now(), now() + interval '60 days', NULL, NULL, NULL)" "uniq_mail_thread_follows_active" "a second active follow by one person"
refused_in grid_inbound "$FOLLOW184, '$U184_A2', now(), now() + interval '60 days', now(), NULL, NULL)" "mail_thread_follows_ended_with_reason" "a follow ended for no reason"
refused_in grid_inbound "$FOLLOW184, '$U184_A2', now(), now() + interval '60 days', now(), NULL, 'unfollowed')" "mail_thread_follows_person_reason_attributed" "an unfollow nobody made"
refused_in grid_inbound "$FOLLOW184, '$U184_A2', now(), now() + interval '60 days', now(), '$U184_A1', 'unfollowed')" "mail_thread_follows_person_reason_attributed" "an unfollow by someone else"
refused_in grid_inbound "$FOLLOW184, '$U184_A2', now(), now() + interval '60 days', now(), '$U184_A2', 'revoked_by_manager')" "mail_thread_follows_person_reason_attributed" "a manager revoking their own follow"
refused_in grid_inbound "$FOLLOW184, '$U184_A2', now(), now() + interval '60 days', now(), NULL, 'bored')" "mail_thread_follows_ended_reason_known" "an unknown end reason"
# A detach moves an entry; its message ids move with it.
sql_in grid_inbound <<<"UPDATE mail_thread_entries SET thread_id = 'ed000000-0000-4000-8000-000000000184' WHERE id = 'e2000000-0000-4000-8000-000000000184';"
check_in grid_inbound "SELECT string_agg(state || '@' || thread_id::text, ',' ORDER BY state) FROM mail_thread_message_ids WHERE message_id = 'm0@buero.at'" \
  "received@ed000000-0000-4000-8000-000000000184,referenced@ea000000-0000-4000-8000-000000000184" "0186: a detached entry's received id moves with it; another entry's reference stays"
refused_in grid_inbound "UPDATE mail_thread_message_ids SET thread_id = 'ec000000-0000-4000-8000-000000000184', project_id = 'c0000000-0000-4000-8000-000000000184' WHERE entry_id = 'e1000000-0000-4000-8000-000000000184'" "mail_thread_message_ids_entry_fkey" "an entry's id moved to a thread the entry is not in"

# The runtime role: its organization's rows only, in all nine tables, and no DELETE.
for table in inbound_mail_addresses inbound_mails inbound_mail_parts inbound_mail_decisions mail_threads mail_thread_entries mail_thread_entry_attachments mail_thread_message_ids mail_thread_follows; do
  seen=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_inbound -qtA \
    -c "SET grid.organization_id = 'org_0184_b'" \
    -c "SELECT coalesce(string_agg(DISTINCT organization_id, ','), '') FROM $table")
  if [ "$seen" != "org_0184_b" ]; then
    echo "MIGRATION ASSERTION FAILED on grid_inbound: the runtime role in org_0184_b saw $table rows of '$seen'" >&2
    exit 1
  fi
done
for table in inbound_mail_addresses inbound_mails inbound_mail_parts inbound_mail_decisions mail_threads mail_thread_entries mail_thread_entry_attachments mail_thread_follows; do
  if out=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_inbound -qtA -v ON_ERROR_STOP=1 \
      -c "SET grid.organization_id = 'org_0184_b'" -c "DELETE FROM $table WHERE organization_id = 'org_0184_b'" 2>&1); then
    echo "MIGRATION ASSERTION FAILED on grid_inbound: the runtime role deleted from $table" >&2
    exit 1
  fi
  if ! grep -q "permission denied" <<<"$out"; then
    echo "MIGRATION ASSERTION FAILED on grid_inbound: a runtime DELETE on $table was refused for another reason: $out" >&2
    exit 1
  fi
done
RWINS184=$(PGPASSWORD="$RUNTIME_PASSWORD" $PGBIN/psql -h 127.0.0.1 -p "$PORT" -U grid_app_rw -d grid_inbound -qtA \
  -c "SET grid.organization_id = 'org_0184_a'" \
  -c "INSERT INTO mail_thread_follows (organization_id, project_id, thread_id, user_id, expires_at) VALUES ('org_0184_b', 'b0000000-0000-4000-8000-000000000184', 'eb000000-0000-4000-8000-000000000184', '$U184_A1', now() + interval '1 day')" 2>&1 || true)
if ! grep -q "row-level security" <<<"$RWINS184"; then
  echo "MIGRATION ASSERTION FAILED on grid_inbound: the runtime role in org_0184_a wrote a follow into org_0184_b ($RWINS184)" >&2
  exit 1
fi

# Legal hold: a held project's mail and filed messages are not deleted.
sql_in grid_inbound <<<"INSERT INTO legal_holds (entity_type, entity_id, organization_id, reason, created_by) VALUES ('project', 'c0000000-0000-4000-8000-000000000184', 'org_0184_a', 'rls test', 'user_1');"
refused_in grid_inbound "DELETE FROM inbound_mails WHERE id = '1c000000-0000-4000-8000-000000000184'" "legal hold" "a held project's mail deleted"
refused_in grid_inbound "DELETE FROM mail_thread_entries WHERE id = 'e3000000-0000-4000-8000-000000000184'" "legal hold" "a held project's filed message deleted"
refused_in grid_inbound "DELETE FROM mail_thread_entry_attachments WHERE id = 'fa300000-0000-4000-8000-000000000184'" "legal hold" "what came with a held project's filed message deleted"
refused_in grid_inbound "DELETE FROM mail_threads WHERE id = 'ec000000-0000-4000-8000-000000000184'" "legal hold" "a held project's thread deleted with its entries"
sql_in grid_inbound <<<"UPDATE legal_holds SET released_at = now() WHERE entity_id = 'c0000000-0000-4000-8000-000000000184';"

# The document goes: the thread and the filed part lose it, the entries stay
# until the sweep deletes the thread.
sql_in grid_inbound <<<"DELETE FROM documents WHERE id = 'd1000000-0000-4000-8000-000000000184';"
# The part's Fassung goes too: once its document key has set `document_id`
# NULL, the composite key to the Fassung is no longer checked and its own SET
# NULL never fires, so the parts' guard clears the Fassung itself.
check_in grid_inbound "SELECT (SELECT coalesce(document_id::text, 'gone') FROM mail_threads WHERE id = 'ea000000-0000-4000-8000-000000000184') || ',' || (SELECT state || ':' || coalesce(document_id::text, 'gone') || ':' || coalesce(document_version_id::text, 'gone') FROM inbound_mail_parts WHERE id = '2b000000-0000-4000-8000-000000000184') || ',' || (SELECT count(*) FROM mail_thread_entries WHERE thread_id = 'ea000000-0000-4000-8000-000000000184')" \
  "gone,filed:gone:gone,1" "0186: deleting the document keeps the filed part, without its document or Fassung, and the entries until the sweep"
check_in grid_inbound "SELECT string_agg(position || ':' || disposition || ':' || coalesce(document_id::text, 'gone') || ':' || coalesce(document_version_id::text, 'gone') || ':' || coalesce(section_name, '-'), ',' ORDER BY position) FROM mail_thread_entry_attachments WHERE entry_id = 'e1000000-0000-4000-8000-000000000184'" \
  "1:filed:gone:gone:S-101.pdf,2:filed:gone:gone:-" "0186: deleting the document keeps the record that it came, and the section's words (D36)"
# Sweep 9 deletes the thread: it waits for the follower's decision to be audited (RT-S8) ...
refused_in grid_inbound "${V184}DELETE FROM mail_threads WHERE id = 'ea000000-0000-4000-8000-000000000184'" "inbound_mail_decisions_audited_before_delete" "a thread deleted while its follow's decision is owed to the trail"
sql_in grid_inbound <<<"UPDATE inbound_mail_decisions SET audited_at = now() WHERE id = '3d000000-0000-4000-8000-000000000184';"
# ... and then takes its entries, ids and follows, the follow's decision and the text it filed.
sql_in grid_inbound <<<"DELETE FROM mail_threads WHERE id = 'ea000000-0000-4000-8000-000000000184';"
check_in grid_inbound "SELECT (SELECT count(*) FROM mail_thread_entries WHERE thread_id = 'ea000000-0000-4000-8000-000000000184') || ',' || (SELECT count(*) FROM mail_thread_message_ids WHERE thread_id = 'ea000000-0000-4000-8000-000000000184') || ',' || (SELECT count(*) FROM mail_thread_follows WHERE thread_id = 'ea000000-0000-4000-8000-000000000184') || ',' || (SELECT count(*) FROM inbound_mail_decisions WHERE id = '3d000000-0000-4000-8000-000000000184') || ',' || (SELECT count(*) FROM inbound_mail_parts WHERE id = '2a000000-0000-4000-8000-000000000184') || ',' || (SELECT count(*) FROM mail_thread_entry_attachments WHERE entry_id = 'e1000000-0000-4000-8000-000000000184')" \
  "0,0,0,0,0,0" "0186: deleting a thread takes its entries, what came with them, ids, follows, the follow's decision and the text part it filed"
# Sweep 8 deletes a mail only once its decisions are audited.
refused_in grid_inbound "${V184}DELETE FROM inbound_mails WHERE id = '1a000000-0000-4000-8000-000000000184'" "inbound_mail_decisions_audited_before_delete" "a mail deleted while a decision about it is owed to the trail"
refused_in grid_inbound "DELETE FROM inbound_mail_addresses WHERE id = 'aa000000-0000-4000-8000-000000000184'" "inbound_mails_address_fkey" "an address deleted from under its mail"

# The purge: deleting the project takes all nine tables, unaudited decisions included.
sql_in grid_inbound <<<"DELETE FROM projects WHERE id = 'a0000000-0000-4000-8000-000000000184';"
check_in grid_inbound "SELECT (SELECT count(*) FROM inbound_mail_addresses WHERE project_id = 'a0000000-0000-4000-8000-000000000184') + (SELECT count(*) FROM inbound_mails WHERE project_id = 'a0000000-0000-4000-8000-000000000184') + (SELECT count(*) FROM inbound_mail_parts WHERE project_id = 'a0000000-0000-4000-8000-000000000184') + (SELECT count(*) FROM inbound_mail_decisions WHERE project_id = 'a0000000-0000-4000-8000-000000000184') + (SELECT count(*) FROM mail_threads WHERE project_id = 'a0000000-0000-4000-8000-000000000184')" \
  "0" "0186: a project purge takes its addresses, mails, parts, decisions and threads"
check_in grid_inbound "SELECT count(*) FROM inbound_mails WHERE organization_id = 'org_0184_b'" "1" "0186: and nothing of another project"

# Down: refused while a row names an object, clean once none does; 0186 applies again.
apply_in grid_inbound 0186_inbound_mail.sql
check_in grid_inbound "SELECT count(*) FROM inbound_mails" "2" "0186 re-applies and keeps the mail"
sql_in grid_inbound <<<"UPDATE inbound_mails SET raw_storage_key = 'org/org_0184_b/project/b0000000-0000-4000-8000-000000000184/_inbound-mail/1b000000-0000-4000-8000-000000000184/raw.eml' WHERE id = '1b000000-0000-4000-8000-000000000184';"
refused_in grid_inbound "$(cat drizzle/0186_inbound_mail.down.sql)" "reverse 0186 refused" "the down while a mail names its staged raw message"
check_in grid_inbound "SELECT count(*) FROM pg_tables WHERE tablename LIKE 'inbound\_mail%' OR tablename LIKE 'mail\_thread%'" "9" "the refused down dropped nothing"
sql_in grid_inbound <<'SQL'
INSERT INTO inbox_items (organization_id, recipient_user_id, type, resource_type, resource_id, group_key, actionable)
VALUES ('org_0184_b', 'u', 'inbound_mail.waiting', 'project', 'b0000000-0000-4000-8000-000000000184', 'inbound_mail.waiting:p', true),
       ('org_0184_b', 'u', 'document.new_revision', 'document', 'd3000000-0000-4000-8000-000000000184', 'document.new_revision:d', false);
UPDATE inbound_mails SET raw_storage_key = NULL;
SQL
apply_in grid_inbound 0186_inbound_mail.down.sql
check_in grid_inbound "SELECT count(*) FROM pg_tables WHERE tablename LIKE 'inbound\_mail%' OR tablename LIKE 'mail\_thread%'" "0" "0186 down drops the nine tables"
check_in grid_inbound "SELECT string_agg(type, ',') FROM inbox_items WHERE organization_id = 'org_0184_b'" "document.new_revision" "0186 down removes the mail notices and nothing else"
check_in grid_inbound "SELECT count(*) FROM pg_proc WHERE proname IN ('grid_inbound_mail_decisions_guard', 'grid_inbound_mail_parts_decision_guard', 'grid_inbound_mail_parts_document_guard', 'grid_refuse_held_project_row_delete', 'grid_mail_thread_entry_attachments_guard')" "0" "0186 down drops its functions"
check_in grid_inbound "SELECT count(*) FROM documents WHERE id = 'd3000000-0000-4000-8000-000000000184'" "1" "0186 down leaves the documents"
apply_in grid_inbound 0186_inbound_mail.sql
check_in grid_inbound "SELECT count(*) FROM pg_tables WHERE tablename LIKE 'inbound\_mail%' OR tablename LIKE 'mail\_thread%'" "9" "0186 applies again after its down"
echo "==> 0186 inbound mail, threads and follows and their down migration verified"
