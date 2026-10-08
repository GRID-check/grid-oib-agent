-- Reverse 0110. ORDER: roll the frontend back first; the newer build writes and
-- reads `conversation_restricted_folders`. Lossy and widening: a conversation
-- that drew on a folder not every member may read becomes shareable again,
-- because the older build knows no such folders.
DROP TABLE IF EXISTS "conversation_restricted_folders";
