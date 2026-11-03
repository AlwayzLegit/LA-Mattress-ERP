#!/usr/bin/env bash
# autocannon: 10 connections x 10s per endpoint, direct to the API (no proxy), with a real session cookie.
API=${API:-http://localhost:4000}
JAR=$(mktemp)
curl -s -c "$JAR" -H 'Content-Type: application/json' -H "Origin: http://localhost:3102" -d '{"email":"owner@acme.local","password":"ChangeMe!2024"}' "$API/api/auth/sign-in/email" -o /dev/null
COOKIE=$(sed 's/^#HttpOnly_//' "$JAR" | awk '!/^#/ && NF>=7 {printf "%s=%s; ", $6, $7}')
for ep in "$@"; do
  echo "=== $ep"
  npx -y autocannon@8 -c 10 -d 10 -H "Cookie=$COOKIE" -H "Origin=http://localhost:3102" "$API$ep" 2>&1 | grep -E "Latency|Req/Sec|Bytes/Sec|requests in|errors|non 2xx" 
done
rm -f "$JAR"
