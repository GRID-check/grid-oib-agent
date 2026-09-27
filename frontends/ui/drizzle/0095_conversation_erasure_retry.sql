-- 0095: queue the chats that are stuck in the deleting state.
--
-- A chat is erased in its delete request: marked `deleted_at`, then its
-- attachments, its `s_` collection and its row. When the agent service was down
-- the request answered 502 and stopped after the mark, and nothing ever came
-- back for it: the chat stayed hidden, half-erased, until someone deleted it
-- again.
--
-- From this release the mark writes a `deletion_queue` row
-- (`entity_type = 'conversation'`) in the same transaction, and the purger
-- retries it through the BFF's own erasure (`purger/purge-conversation.js`).
-- The chats stuck BEFORE this release have no row, so they get one here.
--
-- `purge_after` is fifteen minutes out rather than now: migrations run before
-- the new purger image is rolled out, and a purger from the previous release
-- has no handler for 'conversation' and fails such a row permanently on sight.
-- `ON CONFLICT DO NOTHING` meets `deletion_queue_active_entity_idx` (one
-- pending/purging row per entity). No tenant scope is needed: migrations run as
-- the table owner, which row-level security does not restrict.

INSERT INTO "deletion_queue"
  ("entity_type", "entity_id", "display_name", "organization_id", "requested_by", "purge_after", "payload")
SELECT
  'conversation',
  c."id",
  COALESCE(NULLIF(btrim(c."title"), ''), 'Chat'),
  c."organization_id",
  c."created_by",
  now() + interval '15 minutes',
  '{"source":"0095_backfill"}'::jsonb
FROM "conversations" c
WHERE c."deleted_at" IS NOT NULL
ON CONFLICT DO NOTHING;
