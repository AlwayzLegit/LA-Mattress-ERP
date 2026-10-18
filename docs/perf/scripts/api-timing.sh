#!/usr/bin/env bash
# Single-request latency + payload size per hot endpoint, warm (2nd of 3 calls reported as median of 3).
API=${API:-http://localhost:4000}
JAR=$(mktemp)
curl -s -c "$JAR" -H 'Content-Type: application/json' -H "Origin: http://localhost:3102" \
  -d '{"email":"owner@acme.local","password":"ChangeMe!2024"}' "$API/api/auth/sign-in/email" -o /dev/null
printf "%-70s %8s %8s %8s %9s %6s\n" endpoint ms_p50 ms_min ms_max bytes gzip
for ep in "$@"; do
  times=(); size=0; gz=0
  for i in 1 2 3; do
    out=$(curl -s -b "$JAR" -H "Origin: http://localhost:3102" -o /tmp/body.bin -w "%{time_total} %{size_download} %{http_code}" "$API$ep")
    t=$(echo "$out" | awk '{printf "%d", $1*1000}'); size=$(echo "$out" | awk '{print $2}'); code=$(echo "$out" | awk '{print $3}')
    times+=("$t")
  done
  gz=$(curl -s -b "$JAR" -H "Origin: http://localhost:3102" -H 'Accept-Encoding: gzip' -o /dev/null -w "%{size_download}" "$API$ep")
  sorted=($(printf "%s\n" "${times[@]}" | sort -n))
  printf "%-70s %8s %8s %8s %9s %6s %s\n" "$ep" "${sorted[1]}" "${sorted[0]}" "${sorted[2]}" "$size" "$gz" "$code"
done
rm -f "$JAR"
