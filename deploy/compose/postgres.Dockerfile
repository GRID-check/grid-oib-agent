# Postgres image with the Grid DB-bootstrap script baked in.
#
# Why a custom image instead of a bind mount:
# Coolify pre-creates every bind-mount *source* path as a directory before it
# runs `docker compose up`. That turns a single-file mount
# (./init-db.sql -> /docker-entrypoint-initdb.d/init-db.sql) into an empty
# directory, so psql fails with "could not read from input file: Is a
# directory" and the aiq_checkpoints + grid_app databases are never created.
# Baking the script into the image removes the host bind mount entirely.
#
# Build context is deploy/compose/ (see docker-compose.coolify.yaml), so
# init-db.sql sits next to this Dockerfile.
FROM postgres:16-alpine
COPY init-db.sql /docker-entrypoint-initdb.d/init-db.sql
