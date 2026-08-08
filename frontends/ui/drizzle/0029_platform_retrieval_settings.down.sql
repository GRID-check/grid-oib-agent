-- Reverses 0029_platform_retrieval_settings.sql. Every retrieval count falls
-- back to the workflow YAML / tool-constant default (the backend fails open).
DROP TABLE IF EXISTS "platform_retrieval_settings";
