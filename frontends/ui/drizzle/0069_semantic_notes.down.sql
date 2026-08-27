-- Rollback for 0069_semantic_notes.
DROP INDEX IF EXISTS "idx_answer_feedback_created";
DROP INDEX IF EXISTS "idx_answer_feedback_holdout_created";
ALTER TABLE "answer_feedback" DROP COLUMN IF EXISTS "lessons_holdout";
ALTER TABLE "platform_lessons"
  DROP COLUMN IF EXISTS "helpful_votes",
  DROP COLUMN IF EXISTS "harmful_votes",
  DROP COLUMN IF EXISTS "embedding",
  DROP COLUMN IF EXISTS "embedding_model",
  DROP COLUMN IF EXISTS "embedded_at";
ALTER TABLE "project_memory"
  DROP COLUMN IF EXISTS "recall_count",
  DROP COLUMN IF EXISTS "embedding",
  DROP COLUMN IF EXISTS "embedding_model",
  DROP COLUMN IF EXISTS "embedded_at";
DROP FUNCTION IF EXISTS grid_cosine_similarity(real[], real[]);
