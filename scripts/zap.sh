#!/usr/bin/env bash
# Run the OWASP ZAP baseline scan locally against an already-running app.
#
#   npm run dev            # in one terminal (app on :3000)
#   npm run zap            # in another  -> HTML report at ./zap-report.html
# Point at another port/host with ZAP_TARGET=http://host.docker.internal:3001
#
# Uses the official ZAP Docker image, so Docker must be running. This is the
# same scan the CI workflow (.github/workflows/zap.yml) runs on a schedule.
set -euo pipefail

TARGET="${ZAP_TARGET:-http://host.docker.internal:3000}"
OUT="${ZAP_REPORT:-zap-report.html}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running. Start Docker/OrbStack, or run the CI workflow instead." >&2
  exit 1
fi

# Verify the target actually SERVES THE APP before scanning it.
#
# Without this the scan is worse than useless: a dev server with a stale .next
# cache answers / with a 500, ZAP happily spiders the error page, and you get
# "FAIL-NEW: 0  PASS: 55" — a clean bill of health for a site it never reached.
# That exact false pass is why this check exists. Fail loudly instead.
#
# Curl from the host, so translate the container-facing hostname back.
PROBE="${TARGET/host.docker.internal/localhost}"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE" || echo 000)"
if [ "$CODE" != "200" ]; then
  echo "Target $PROBE returned HTTP $CODE, expected 200 — refusing to scan." >&2
  echo "A scan of an error page reports no findings and means nothing." >&2
  echo "Start the app first (npm run dev, or npm run build && npm start)." >&2
  echo "If / legitimately does not return 200, set ZAP_TARGET to a path that does." >&2
  exit 1
fi
echo "Target $PROBE responds 200 — proceeding."

echo "ZAP baseline scan against $TARGET (report -> $OUT)"
docker run --rm -t \
  -v "$(pwd):/zap/wrk:rw" \
  ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py \
    -t "$TARGET" \
    -c .zap/rules.tsv \
    -r "$OUT" \
    -a || true   # baseline warns; never hard-fail the local run

echo "Done. Open $OUT"
