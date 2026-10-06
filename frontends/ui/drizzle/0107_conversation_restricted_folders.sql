-- 0107: conversation_restricted_folders — the folders not every project member
-- can read whose content a conversation actually drew on, one row per folder
-- (ADR-0078, ADR-0079).
--
-- ## Why it replaces 0105
--
-- 0105 marked a conversation at the start of every turn whose signed scope
-- held a restricted folder's collection. A cleared member's socket is signed
-- every restricted collection they are cleared for, so every chat of an
-- organization admin in a project with one restricted folder was marked from
-- its first message: it could not be shared, escalated, tasked or filed. The
-- product owner's rule (2026-10-02): a conversation is restricted only by what
-- it USED, and per person, because different people may read different folders.
--
-- A folder is used when content from it enters the model's context: a
-- retrieval hit, an opened document, a restricted memory line the digest
-- served. Listing is not use. The BFF writes a row when it ADMITS that use
-- (`lib/conversations/restricted-use.ts`), under a per-conversation advisory
-- lock it shares with every widening of the conversation's audience, after
-- checking that the asker and everyone the conversation is shared with may read
-- the folder.
--
-- ## The source folder, decided at read time
--
-- The row names the SOURCE FOLDER (the folder whose retrieval collection the
-- content came from), never a collection name or a list of roles. Who may read
-- the conversation is computed when someone asks, from the folder's access as
-- it is THEN: a loosened folder opens what was derived from it, a tightened one
-- closes it, and nothing here is rewritten. A folder id that no longer exists
-- is read as a folder nobody may read.
--
-- ## No foreign keys
--
-- Not to `conversations`, as in 0105: the first turn of a new chat runs before
-- its row exists; `deleteConversationInOrg` deletes the rows with it. Not to
-- `project_folders`: deleting a folder must not quietly open what was drawn
-- from it.
--
-- ## Backfill, in the safe direction
--
-- A 0105 mark recorded that a restricted turn ran, not which folders it could
-- see, so it becomes a row for every restricted folder of the conversation's
-- project. A stored answer that cited or read a restricted collection adds that
-- collection's folder. A mark for a conversation that never got a row recorded
-- nothing anyone can read, and goes.
CREATE TABLE IF NOT EXISTS "conversation_restricted_folders" (
  "organization_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "folder_id" uuid NOT NULL,
  "first_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_restricted_folders_pk" PRIMARY KEY ("organization_id", "conversation_id", "folder_id"),
  CONSTRAINT "conversation_restricted_folders_order" CHECK ("last_at" >= "first_at")
);
--> statement-breakpoint
COMMENT ON TABLE "conversation_restricted_folders" IS
  'A folder not every project member can read whose content this conversation drew on (ADR-0079). Written when the BFF admits that use; who may read the conversation is decided at read time from the folder''s current access.';
--> statement-breakpoint
SELECT grid_secure_table('conversation_restricted_folders', 'organization_id = grid_current_org()');
--> statement-breakpoint
INSERT INTO "conversation_restricted_folders" ("organization_id", "conversation_id", "folder_id", "first_at", "last_at")
SELECT t."organization_id", t."conversation_id", f."id", t."first_at", t."last_at"
FROM "conversation_restricted_turns" t
JOIN "conversations" c ON c."id" = t."conversation_id" AND c."organization_id" = t."organization_id"
JOIN "projects" p ON p."id" = c."project_id"
JOIN "project_folders" f ON f."project_id" = p."id" AND f."restricted_roles" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "conversation_restricted_folders" ("organization_id", "conversation_id", "folder_id")
SELECT DISTINCT m."organization_id", m."conversation_id", f."id"
FROM "messages" m
CROSS JOIN LATERAL (
  SELECT value #>> '{}' AS collection
  FROM jsonb_path_query(
    jsonb_build_array(m."metadata" -> 'citations', m."metadata" -> 'readSources'),
    'lax $[*].sources[*].collection ? (@ like_regex "_r[0-9a-f]{12}$")'
  ) AS value
) AS named
JOIN "conversations" c ON c."id" = m."conversation_id" AND c."organization_id" = m."organization_id"
JOIN "projects" p ON p."id" = c."project_id"
JOIN "project_folders" f ON f."project_id" = p."id" AND f."restricted_roles" IS NOT NULL
  AND named.collection = p."collection_name" || '_r' || lower(left(replace(f."id"::text, '-', ''), 12))
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_restricted_turns";
