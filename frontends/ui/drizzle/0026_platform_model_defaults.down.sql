-- Reverses 0026_platform_model_defaults.sql. Every group falls back to the
-- workflow YAML default again; per-org overrides are untouched.
DROP TABLE IF EXISTS "platform_model_defaults";
