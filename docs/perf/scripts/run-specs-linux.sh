#!/usr/bin/env bash
# usage: run-specs-linux.sh <git ref> <vitest file filters...>
set -u
REF=$1; shift
cd "$(git rev-parse --show-toplevel)"
ENVS=$(grep -E '^\s+[A-Z_]+_TEST_DATABASE_URL: ' .github/workflows/ci.yml | sed -E 's/^\s+([A-Z_]+): (.*)$/-e \1=\2/; s/localhost:5432/host.docker.internal:55432/' | tr '\n' ' ')
SHA=$(git rev-parse "$REF")
echo "== $REF ($SHA) specs: $*"
MSYS_NO_PATHCONV=1 docker run --rm --name "jetnine-specs-$$" \
  -v "$(git rev-parse --show-toplevel)/.git:/src.git:ro" \
  -e CI=1 -e NODE_ENV=test -e REDIS_URL=redis://host.docker.internal:56379 \
  -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:55432/jetnine_test \
  -e TEST_DATABASE_URL=postgres://postgres:postgres@host.docker.internal:55432/jetnine_test \
  -e COMPETITIONS_TEST_DATABASE_URL=postgres://postgres:postgres@host.docker.internal:55432/jetnine_competitions \
  $ENVS node:22-bookworm bash -lc "
    set -e
    git clone -q /src.git /work && cd /work && git checkout -q $SHA
    corepack enable && corepack prepare pnpm@9.15.9 --activate >/dev/null 2>&1
    pnpm install --frozen-lockfile >/dev/null 2>&1
    pnpm --filter @jetnine/shared --filter @jetnine/db build >/dev/null
    cd apps/api && pnpm exec vitest run $* --reporter=dot 2>&1 | tail -40
  "
echo "container exit=$? $(date)"
