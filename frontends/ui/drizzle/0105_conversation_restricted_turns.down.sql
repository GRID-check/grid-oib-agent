-- Reverse 0105. ORDER: roll the frontend back first; the newer build writes
-- and reads the table. Lossy and widening: a conversation that ran a restricted
-- turn but cited nothing from it becomes shareable again, because the older
-- build only reads the stored sources.
DROP TABLE IF EXISTS "conversation_restricted_turns";
