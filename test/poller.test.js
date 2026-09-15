import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { Poller } from '../src/poller.js';
import { STATUS, makeEvent, makeResult } from '../src/carriers/normalize.js';

const testConfig = {
  poll: {
    intervalMinutes: 20,
    jitterSeconds: 0,
    concurrency: 2,
    deliveredRetentionHours: 48,
    unknownRetentionHours: 336,
    maxPerUser: 25,
  },
};

async function harness({ carrier, now = () => new Date() } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-poller-'));
  const store = await openStore(path.join(dir, 'tracker.json'));
  const notifications = [];
  const poller = new Poller({
    store,
    config: testConfig,
    now,
    notify: async (payload) => notifications.push(payload),
    resolveCarrier: () => carrier,
  });
  return { store, poller, notifications };
}

function fakeCarrier(results, { configured = true } = {}) {
  const queue = [...results];
  return {
    label: 'Fake',
    isConfigured: () => configured,
    track: async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function result(status, description, timestamp) {
  return makeResult({
    carrier: 'usps',
    trackingNumber: '9400111899223197428490',
    status,
    statusText: description,
    events: [makeEvent({ timestamp, description, location: 'BROOKLYN, NY' })],
  });
}

const sub = {
  carrier: 'usps',
  trackingNumber: '9400111899223197428490',
  channelId: 'chan-1',
  userId: 'user-1',
  label: 'keyboard',
};

test('the first successful poll records state without notifying', async () => {
  const carrier = fakeCarrier([result(STATUS.IN_TRANSIT, 'In Transit', '2026-09-14T10:00:00Z')]);
  const { store, poller, notifications } = await harness({ carrier });
  const { key } = await store.addSubscription(sub);

  const summary = await poller.runCycle();
  assert.equal(summary.checked, 1);
  assert.equal(notifications.length, 0);
  assert.equal(store.getShipment(key).lastStatus, STATUS.IN_TRANSIT);
  assert.ok(store.getShipment(key).lastFingerprint);
});

test('unchanged results stay silent, changes notify once', async () => {
  const early = result(STATUS.IN_TRANSIT, 'In Transit', '2026-09-14T10:00:00Z');
  const later = result(STATUS.OUT_FOR_DELIVERY, 'Out for Delivery', '2026-09-15T06:00:00Z');
  const carrier = fakeCarrier([early, early, later, later]);
  const { store, poller, notifications } = await harness({ carrier });
  await store.addSubscription(sub);

  await poller.runCycle(); // first sighting
  await poller.runCycle(); // identical
  assert.equal(notifications.length, 0);

  await poller.runCycle(); // status moved
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'update');
  assert.equal(notifications[0].previousStatus, STATUS.IN_TRANSIT);
  assert.equal(notifications[0].result.status, STATUS.OUT_FOR_DELIVERY);

  await poller.runCycle(); // identical again
  assert.equal(notifications.length, 1);
});

test('/track check can force a report even when nothing changed', async () => {
  const steady = result(STATUS.IN_TRANSIT, 'In Transit', '2026-09-14T10:00:00Z');
  const carrier = fakeCarrier([steady]);
  const { store, poller, notifications } = await harness({ carrier });
  const { key } = await store.addSubscription(sub);

  await poller.runCycle();
  const outcome = await poller.pollShipment(key, { force: true });
  assert.equal(outcome.failed, false);
  assert.equal(notifications.length, 1);
});

test('repeated failures are counted and alert once at the threshold', async () => {
  const carrier = fakeCarrier([new Error('carrier exploded')]);
  const { store, poller, notifications } = await harness({ carrier });
  const { key } = await store.addSubscription(sub);

  for (let i = 0; i < 5; i += 1) await poller.runCycle();

  assert.equal(store.getShipment(key).failureCount, 5);
  assert.equal(store.getShipment(key).lastError, 'carrier exploded');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'error');
  assert.equal(notifications[0].failureCount, 4);
});

test('a recovered lookup clears the failure counter', async () => {
  const carrier = fakeCarrier([new Error('boom'), result(STATUS.IN_TRANSIT, 'In Transit', '2026-09-14T10:00:00Z')]);
  const { store, poller } = await harness({ carrier });
  const { key } = await store.addSubscription(sub);

  await poller.runCycle();
  assert.equal(store.getShipment(key).failureCount, 1);
  await poller.runCycle();
  assert.equal(store.getShipment(key).failureCount, 0);
  assert.equal(store.getShipment(key).lastError, null);
});

test('shipments without carrier credentials are skipped, not failed', async () => {
  const carrier = fakeCarrier([result(STATUS.IN_TRANSIT, 'In Transit', '2026-09-14T10:00:00Z')], {
    configured: false,
  });
  const { store, poller, notifications } = await harness({ carrier });
  const { key } = await store.addSubscription(sub);

  const summary = await poller.runCycle();
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failures, 0);
  assert.equal(notifications.length, 0);
  assert.equal(store.getShipment(key).lastStatus, null);
});

test('delivered packages are pruned once the retention window passes', async () => {
  const delivered = result(STATUS.DELIVERED, 'Delivered, In/At Mailbox', '2026-09-10T15:00:00Z');
  const carrier = fakeCarrier([delivered]);
  let clock = new Date('2026-09-10T16:00:00Z');
  const { store, poller } = await harness({ carrier, now: () => clock });
  const { key } = await store.addSubscription(sub);

  await poller.runCycle();
  assert.ok(store.getShipment(key), 'still tracked right after delivery');

  clock = new Date('2026-09-13T16:00:00Z'); // > 48h later
  const summary = await poller.runCycle();
  assert.equal(summary.pruned, 1);
  assert.equal(store.getShipment(key), null);
});

test('a number the carrier never recognises is dropped after the stale window', async () => {
  const carrier = fakeCarrier([new Error('not found')]);
  let clock = new Date('2026-01-01T00:00:00Z');
  const { store, poller } = await harness({ carrier, now: () => clock });
  const { key } = await store.addSubscription(sub);
  await store.updateShipment(key, { createdAt: '2026-01-01T00:00:00Z' });

  await poller.runCycle();
  assert.ok(store.getShipment(key));

  clock = new Date('2026-02-01T00:00:00Z'); // > 14 days after createdAt
  await poller.runCycle();
  assert.equal(store.getShipment(key), null);
});

test('polling an unknown key is a no-op', async () => {
  const { poller } = await harness({ carrier: fakeCarrier([]) });
  const outcome = await poller.pollShipment('usps:nope');
  assert.deepEqual(outcome, { skipped: true, reason: 'missing' });
});

test('snapshot reports schedule state for /track status', async () => {
  const { poller } = await harness({ carrier: fakeCarrier([]) });
  const snapshot = poller.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.lastPollAt, null);
  assert.ok(snapshot.startedAt);
});
