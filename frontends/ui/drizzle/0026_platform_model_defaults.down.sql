-- Reverses 0026_platform_model_defaults.sql. Every group falls back to the
-- workflow YAML default again for organizations without an org override;
-- per-org overrides are untouched and still win.
DROP TABLE IF EXISTS "platform_model_defaults";
