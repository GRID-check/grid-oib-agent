-- Answer feedback: what a good answer would have contained.
--
-- A down-vote says the answer was wrong; this says what the right one holds.
-- That is the half an answer-suite test case needs, and the only half the voter
-- can supply cheaply. Optional free text, nullable, no default: every existing
-- row simply has none. Nothing reads it in a hot path, so no index.
--
-- No new table, so no `grid_secure_table`: the column rides the table's
-- existing row-level-security policy.
ALTER TABLE "answer_feedback" ADD COLUMN IF NOT EXISTS "expected_answer" text;
