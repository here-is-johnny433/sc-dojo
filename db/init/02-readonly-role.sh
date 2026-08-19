#!/bin/sh
# Creates the read-only role used by the chat agent's query_db tool.
# Runs inside the postgres container entrypoint after 01-schema.sql.
# NOTE: /bin/sh, not bash — postgres:16-alpine has no bash.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dojo_readonly') THEN
      CREATE ROLE dojo_readonly LOGIN PASSWORD '${READONLY_DB_PASSWORD}';
    END IF;
  END
  \$\$;
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO dojo_readonly;
  GRANT USAGE ON SCHEMA public TO dojo_readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO dojo_readonly;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dojo_readonly;
EOSQL
