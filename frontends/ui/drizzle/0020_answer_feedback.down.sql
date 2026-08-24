-- Manual down migration (drizzle-kit has no down support; mirrors 0019's
-- convention). Drops the per-answer feedback table and its indexes.
DROP TABLE IF EXISTS "answer_feedback";
