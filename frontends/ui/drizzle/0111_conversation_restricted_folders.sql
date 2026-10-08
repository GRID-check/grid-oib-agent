-- 0110: conversation_restricted_folders — the folders not every project member
-- can read whose content a conversation actually drew on, one row per folder
-- (ADR-0086, ADR-0087).
--
-- ## Per folder, and per use
--
-- A conversation is restricted only by what it USED, and per person, because
-- different people may read different folders: a mark per conversation would
-- lock every chat of a cleared member out of sharing from its first message.
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
-- Not to `conversations`: the first turn of a new chat runs before its row
-- exists; `deleteConversationInOrg` deletes the rows with it. Not to
-- `project_folders`: deleting a folder must not quietly open what was drawn
-- from it.
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
  'A folder not every project member can read whose content this conversation drew on (ADR-0087). Written when the BFF admits that use; who may read the conversation is decided at read time from the folder''s current access.';
--> statement-breakpoint
SELECT grid_secure_table('conversation_restricted_folders', 'organization_id = grid_current_org()');
