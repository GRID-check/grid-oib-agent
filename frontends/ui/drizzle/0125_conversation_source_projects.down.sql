-- Reverse 0125. ORDER: roll the frontend back first; the newer build writes and
-- reads `conversation_source_projects`.
--
-- In the safe direction: a conversation that drew on another project must not
-- become shareable because the record went. Each one gets a row in
-- `conversation_restricted_folders` under the nil folder id, which the older
-- build reads as a folder nobody may read: the conversation stays locked for
-- everyone, its creator included, until it is deleted. A loss, never a leak.
INSERT INTO "conversation_restricted_folders" ("organization_id", "conversation_id", "folder_id", "first_at", "last_at")
SELECT "organization_id", "conversation_id", '00000000-0000-0000-0000-000000000000'::uuid, min("first_at"), max("last_at")
FROM "conversation_source_projects"
GROUP BY "organization_id", "conversation_id"
ON CONFLICT DO NOTHING;
DROP TABLE IF EXISTS "conversation_source_projects";
