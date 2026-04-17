#!/usr/bin/env bash
# AAOS Smart Retail — Agent Response Verifier
#
# Subscribes to expected output MQTT topics and asserts that each receives
# a message within 60 seconds of the test harness running.
#
# Usage:
#   bash scripts/retail/verify_responses.sh [store_id]
#
# Requirements:
#   - mosquitto_sub must be installed (brew install mosquitto / apt install mosquitto-clients)
#   - MQTT broker must be reachable at MQTT_BROKER_URL (default: localhost:1883)

set -euo pipefail

STORE_ID="${1:-${RETAIL_STORE_ID:-TW-001}}"
BROKER_HOST="${MQTT_HOST:-localhost}"
BROKER_PORT="${MQTT_PORT:-1883}"
TIMEOUT=60

PASS=0
FAIL=0

# Colour codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "AAOS Smart Retail — Response Verifier"
echo "Store   : ${STORE_ID}"
echo "Broker  : ${BROKER_HOST}:${BROKER_PORT}"
echo "Timeout : ${TIMEOUT}s per topic"
echo ""

# Check mosquitto_sub is available
if ! command -v mosquitto_sub &>/dev/null; then
    echo -e "${RED}✗ mosquitto_sub not found. Install: brew install mosquitto | apt install mosquitto-clients${NC}"
    exit 1
fi

assert_topic() {
    local label="$1"
    local topic="$2"

    echo -n "  Waiting for ${label} (${topic})... "

    local msg
    msg=$(mosquitto_sub \
        -h "${BROKER_HOST}" \
        -p "${BROKER_PORT}" \
        -t "${topic}" \
        -C 1 \
        -W "${TIMEOUT}" 2>/dev/null || true)

    if [[ -n "${msg}" ]]; then
        echo -e "${GREEN}✓ RECEIVED${NC}"
        echo "    Payload: ${msg:0:120}"
        ((PASS++))
    else
        echo -e "${RED}✗ TIMEOUT (no message in ${TIMEOUT}s)${NC}"
        ((FAIL++))
    fi
}

echo "Asserting agent output topics..."
echo ""

assert_topic "Restock task"            "retail/${STORE_ID}/tasks/restock"
assert_topic "Open lane task"          "retail/${STORE_ID}/tasks/open_lane"
assert_topic "BLE zone offer"          "retail/${STORE_ID}/display/frozen-aisle/offer"
assert_topic "LP alert"                "retail/${STORE_ID}/alerts/lp"

echo ""
echo "─────────────────────────────────────────"
echo "Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}"

if [[ "${FAIL}" -eq 0 ]]; then
    echo -e "${GREEN}All expected agent responses received.${NC}"
    exit 0
else
    echo -e "${RED}${FAIL} topic(s) did not receive a response within ${TIMEOUT}s.${NC}"
    echo -e "${YELLOW}Check AAOS agent logs and ensure the test harness ran first:${NC}"
    echo "  npx ts-node scripts/retail/mqtt_test_harness.ts --scenario all"
    exit 1
fi
