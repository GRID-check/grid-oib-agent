-- Reverses 0030_platform_reasoning_efforts.sql. Every agent group falls back to
-- the `reasoning_effort` in the workflow YAML for its role (the backend fails
-- open to exactly that when no row is readable), so dropping the table restores
-- pre-0030 behaviour with no further action.
DROP TABLE IF EXISTS "platform_reasoning_efforts";
