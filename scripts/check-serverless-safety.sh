#!/usr/bin/env bash
# Spec §3.1: no setInterval-based scheduling, no in-process background
# jobs, in server code that will run on Netlify's serverless runtime.
# Background work must be cron-triggered HTTP endpoints instead.
#
# Scope: apps/api/src only. apps/web is a browser SPA — setTimeout there
# (e.g. debounce, toast auto-dismiss) is normal and not what §3.1 warns
# about, so it's intentionally excluded.
set -euo pipefail

API_SRC="apps/api/src"
fail=0

echo "Checking $API_SRC for setInterval usage (banned outright)…"
if grep -rn "setInterval(" "$API_SRC" --include="*.ts" 2>/dev/null; then
  echo "FAIL: setInterval found in $API_SRC — background jobs must be cron-triggered HTTP endpoints (spec §3.1)."
  fail=1
else
  echo "OK: no setInterval in $API_SRC"
fi

echo "Checking $API_SRC for setTimeout usage (needs manual review — flag, don't auto-fail)…"
if grep -rn "setTimeout(" "$API_SRC" --include="*.ts" 2>/dev/null; then
  echo "NOTE: setTimeout found above — confirm none of these are simulating a recurring job."
else
  echo "OK: no setTimeout in $API_SRC"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "Serverless-safety grep passed."
