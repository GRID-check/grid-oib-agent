-- Optional free-text on a down-vote. The reason chips are a closed set;
-- this is the sentence that does not fit a chip.
--
-- ADD COLUMN with no default and no constraint is catalog-only in Postgres
-- 11+ — no rewrite. RLS is untouched: a new column on a secured table stays
-- inside the tenant boundary.

ALTER TABLE "answer_feedback" ADD COLUMN IF NOT EXISTS "comment" text;
--> statement-breakpoint

COMMENT ON COLUMN "answer_feedback"."comment" IS
  'Optional free-text from a down-vote. NULL on up-votes and on down-votes that used only a reason chip.';
