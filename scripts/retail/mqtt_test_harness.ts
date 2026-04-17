/**
 * AAOS Smart Retail — MQTT Test Harness
 *
 * Publishes simulated retail sensor payloads to an MQTT broker so that
 * the AAOS retail agent stack can be validated end-to-end without physical hardware.
 *
 * Usage:
 *   npx ts-node scripts/retail/mqtt_test_harness.ts [--scenario <name>]
 *
 * Scenarios:
 *   low_stock  — publishes a shelf sensor payload with a critically low SKU
 *   congested  — publishes 6 checkout lanes with high queue depths
 *   ble        — publishes a BLE dwell event for a known member
 *   pos_anomaly — publishes a POS transaction with a weight mismatch
 *   all        — runs all four scenarios in sequence (default)
 */

import * as mqtt from 'mqtt';

// ── Configuration ──────────────────────────────────────────────────────────────

const BROKER_URL  = process.env.MQTT_BROKER_URL  || `mqtt://${process.env.MQTT_HOST || 'localhost'}:${process.env.MQTT_PORT || 1883}`;
const STORE_ID    = process.env.RETAIL_STORE_ID  || 'TW-001';
const DELAY_MS    = 2000; // 2-second delay between publishes

// ── Helpers ────────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString(); }

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function publish(client: mqtt.MqttClient, topic: string, payload: object): Promise<void> {
    return new Promise((resolve, reject) => {
        const message = JSON.stringify(payload);
        client.publish(topic, message, { qos: 1 }, (err) => {
            if (err) {
                console.error(`  ✗ Failed to publish to ${topic}: ${err.message}`);
                reject(err);
            } else {
                console.log(`  ✓ Published to ${topic}`);
                console.log(`    Payload: ${message}`);
                resolve();
            }
        });
    });
}

// ── Scenarios ──────────────────────────────────────────────────────────────────

/**
 * Scenario: low_stock
 * Publishes a shelf weight sensor reading where SKU-WATER-1L is critically low
 * (weight_kg = 0.8, threshold_kg = 5.0 → 16%, below the 20% HIGH threshold).
 */
async function scenario_low_stock(client: mqtt.MqttClient): Promise<void> {
    console.log('\n[Scenario: low_stock] Publishing shelf sensor payload (critically low SKU)...');
    const topic = `retail/${STORE_ID}/shelf/A3/sensors`;
    const payload = {
        sku:            'SKU-WATER-1L',
        weight_kg:      0.8,
        threshold_kg:   5.0,
        bay_id:         'A3-B2',
        last_restocked: '2025-04-15T08:00:00Z',
    };
    await publish(client, topic, payload);
    // Also publish a medium-risk SKU for completeness
    await sleep(500);
    await publish(client, topic, {
        sku:            'SKU-COLA-355',
        weight_kg:      1.6,
        threshold_kg:   4.0,
        bay_id:         'A3-C1',
        last_restocked: '2025-04-14T16:00:00Z',
    });
}

/**
 * Scenario: congested
 * Publishes 6 checkout lanes with high queue depths to trigger staff alert
 * (congestion_score will be > 4.0).
 */
async function scenario_congested(client: mqtt.MqttClient): Promise<void> {
    console.log('\n[Scenario: congested] Publishing checkout queue payloads (6 busy lanes)...');
    const topic = `retail/${STORE_ID}/checkout/queue`;
    const lanes = [
        { lane_id: 'L1', queue_depth: 7, avg_wait_sec: 210, is_open: true,  cashier_id: 'C-01' },
        { lane_id: 'L2', queue_depth: 5, avg_wait_sec: 180, is_open: true,  cashier_id: 'C-02' },
        { lane_id: 'L3', queue_depth: 6, avg_wait_sec: 195, is_open: true,  cashier_id: 'C-03' },
        { lane_id: 'L4', queue_depth: 4, avg_wait_sec: 150, is_open: true,  cashier_id: 'C-04' },
        { lane_id: 'L5', queue_depth: 3, avg_wait_sec: 120, is_open: true,  cashier_id: 'C-05' },
        { lane_id: 'L6', queue_depth: 0, avg_wait_sec: 0,   is_open: false, cashier_id: undefined },
    ];
    for (const lane of lanes) {
        await publish(client, topic, lane);
        await sleep(200);
    }
}

/**
 * Scenario: ble
 * Publishes a BLE dwell event for a known loyalty member (MBR-042)
 * who has dwelled 25 seconds in the frozen-aisle zone (above the 10s threshold).
 */
async function scenario_ble(client: mqtt.MqttClient): Promise<void> {
    console.log('\n[Scenario: ble] Publishing BLE dwell event (known member, frozen-aisle)...');
    const topic = `retail/${STORE_ID}/ble/frozen-aisle/events`;
    const payload = {
        device_id: 'BLE-001',
        rssi:      -65,
        dwell_sec: 25,
        member_id: 'MBR-042',
        timestamp: now(),
    };
    await publish(client, topic, payload);
    // Also publish an anonymous dwell event
    await sleep(500);
    await publish(client, topic, {
        device_id: 'BLE-009',
        rssi:      -72,
        dwell_sec: 18,
        timestamp: now(),
    });
}

/**
 * Scenario: pos_anomaly
 * Publishes a POS transaction where item_count != scanned_count (weight mismatch)
 * which should trigger a loss prevention WEIGHT_MISMATCH alert.
 */
async function scenario_pos_anomaly(client: mqtt.MqttClient): Promise<void> {
    console.log('\n[Scenario: pos_anomaly] Publishing POS transaction with weight mismatch...');
    const topic = `retail/${STORE_ID}/pos/transactions`;
    const payload = {
        transaction_id:    'T9999',
        cashier_id:        'C-07',
        item_count:        12,
        scanned_count:     10,
        transaction_value: 280.00,
        timestamp:         now(),
    };
    await publish(client, topic, payload);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args     = process.argv.slice(2);
    const flagIdx  = args.indexOf('--scenario');
    const scenario = flagIdx >= 0 ? args[flagIdx + 1] : 'all';

    const validScenarios = ['low_stock', 'congested', 'ble', 'pos_anomaly', 'all'];
    if (!validScenarios.includes(scenario)) {
        console.error(`Unknown scenario "${scenario}". Valid options: ${validScenarios.join(', ')}`);
        process.exit(1);
    }

    console.log(`AAOS Smart Retail — MQTT Test Harness`);
    console.log(`Broker : ${BROKER_URL}`);
    console.log(`Store  : ${STORE_ID}`);
    console.log(`Scenario: ${scenario}`);
    console.log(`Connecting...`);

    const client = mqtt.connect(BROKER_URL, { reconnectPeriod: 0 });

    await new Promise<void>((resolve, reject) => {
        client.once('connect', resolve);
        client.once('error',   reject);
    });

    console.log('Connected to MQTT broker.\n');

    try {
        if (scenario === 'low_stock' || scenario === 'all') {
            await scenario_low_stock(client);
            if (scenario === 'all') await sleep(DELAY_MS);
        }
        if (scenario === 'congested' || scenario === 'all') {
            await scenario_congested(client);
            if (scenario === 'all') await sleep(DELAY_MS);
        }
        if (scenario === 'ble' || scenario === 'all') {
            await scenario_ble(client);
            if (scenario === 'all') await sleep(DELAY_MS);
        }
        if (scenario === 'pos_anomaly' || scenario === 'all') {
            await scenario_pos_anomaly(client);
        }

        console.log('\nAll payloads published successfully.');
        console.log('Run verify_responses.sh to assert agent responses within 60 seconds.');
    } catch (err: any) {
        console.error(`\nTest harness failed: ${err.message}`);
        process.exit(1);
    } finally {
        client.end();
    }
}

main();
