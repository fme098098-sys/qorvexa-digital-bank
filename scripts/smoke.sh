#!/usr/bin/env bash
# End-to-end smoke test against a running server. Usage: BASE=http://localhost:3000 bash scripts/smoke.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
U=${SMOKE_USER:-amara}; P=${SMOKE_PASS:-Qorvexa#2026}
A=${SMOKE_ADMIN:-qadmin}; AP=${SMOKE_ADMIN_PASS:-AdminQorvexa#2026}
JAR=$(mktemp); AJAR=$(mktemp)
csrf() { curl -s -b "$1" -c "$1" "$BASE$2" | grep -o 'name="csrf-token" content="[^"]*"' | head -1 | sed 's/.*content="//;s/"//'; }
code() { curl -s -o /dev/null -w '%{http_code}' -b "$1" -c "$1" "$BASE$2"; }
check() { local got=$1 want=$2 label=$3; if [ "$got" = "$want" ]; then echo "PASS $label ($got)"; else echo "FAIL $label (got $got want $want)"; FAILED=1; fi; }
FAILED=0
for p in / /about /contact /login /register /forgot-password /admin/login; do check "$(code "$JAR" $p)" 200 "GET $p"; done
T=$(csrf "$JAR" /login)
check "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -d "_csrf=$T&identifier=$U&password=$P" "$BASE/login")" 302 "POST /login"
for p in /dashboard /transfer /deposit /withdraw /transactions /statements /profile /notifications /beneficiaries /support; do check "$(code "$JAR" $p)" 200 "GET $p"; done
T=$(csrf "$JAR" /transfer)
REVIEW=$(curl -s -b "$JAR" -c "$JAR" --data-urlencode "_csrf=$T" -d "recipient=daniel.mercer&amount=12.34&description=Smoke+test" "$BASE/transfer/review")
KEY=$(echo "$REVIEW" | grep -o 'name="idempotencyKey" value="[^"]*"' | sed 's/.*value="//;s/"//')
echo "$REVIEW" | grep -q "Daniel Mercer" && echo "PASS review shows recipient name" || { echo "FAIL review"; FAILED=1; }
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" -c "$JAR" --data-urlencode "_csrf=$T" -d "idempotencyKey=$KEY&confirmName=1" "$BASE/transfer/confirm")
REF=$(echo "$LOC" | sed -E 's#.*/transactions/([A-Z0-9]+).*#\1#')
echo "Transfer reference: $REF"
LOC2=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" -c "$JAR" --data-urlencode "_csrf=$T" -d "idempotencyKey=$KEY&confirmName=1" "$BASE/transfer/confirm")
[[ "$LOC2" == *"$REF"* ]] && echo "PASS duplicate submit returns original transfer" || { echo "FAIL duplicate ($LOC2)"; FAILED=1; }
check "$(code "$JAR" "/transactions/$REF?receipt=1")" 200 "GET receipt page"
check "$(curl -s -o /tmp/receipt.pdf -w '%{content_type}' -b "$JAR" "$BASE/transactions/$REF/receipt.pdf")" "application/pdf" "receipt PDF"
check "$(curl -s -o /tmp/statement.pdf -w '%{content_type}' -b "$JAR" "$BASE/statements/download")" "application/pdf" "statement PDF"
check "$(code "$JAR" /transactions/export.csv)" 200 "CSV export"
check "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -d "identifier=x&password=y" "$BASE/profile")" 403 "POST without CSRF rejected"
check "$(code "$JAR" /admin)" 302 "customer cannot open admin"
T=$(csrf "$AJAR" /admin/login)
check "$(curl -s -o /dev/null -w '%{http_code}' -b "$AJAR" -c "$AJAR" --data-urlencode "_csrf=$T" -d "identifier=$A" --data-urlencode "password=$AP" "$BASE/admin/login")" 302 "POST /admin/login"
for p in /admin /admin/users /admin/users/new /admin/transactions "/admin/transactions/$REF" /admin/deposits "/admin/deposits?status=all" /admin/support /admin/audit-logs /admin/settings; do check "$(code "$AJAR" "$p")" 200 "GET $p"; done
rm -f "$JAR" "$AJAR"
[ "$FAILED" = 0 ] && echo "SMOKE TEST PASSED" || { echo "SMOKE TEST FAILED"; exit 1; }
