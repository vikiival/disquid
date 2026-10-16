# Local commands for the RPC token-discovery squid.
set dotenv-load

default:
    @just --list

# Install the versions recorded in pnpm-lock.yaml.
install:
    pnpm install --frozen-lockfile

# Start local PostgreSQL.
up:
    docker compose up -d db

# Stop PostgreSQL without removing its container and indexed data.
down:
    docker compose stop db

pull:
    docker compose pull db

status:
    docker compose ps

psql:
    docker compose exec db psql -U postgres -d squid

# Generate TypeORM models from schema.graphql.
codegen:
    pnpm exec squid-typeorm-codegen

# Regenerate ABI accessors from abi/*.json, using commands.json.
typegen:
    sqd typegen

build:
    pnpm run build

# Apply checked-in migrations to the local database.
migrate:
    sqd migration:apply

# Generate a new migration without deleting the existing migration history.
migration-generate: build
    pnpm exec squid-typeorm-migration generate

# Start the processor or GraphQL server in separate terminals.
process:
    sqd process

serve:
    sqd serve

# Prepare the database and launch both squid services.
run: up build migrate
    sqd run .

test:
    pnpm test

check: test

# Deploy the manifest in this repository when SQD Cloud is configured.
deploy:
    sqd deploy -m squid.yaml .
