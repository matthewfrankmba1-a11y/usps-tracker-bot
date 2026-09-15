import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, openStore } from '../src/store.js';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-store-'));
  return { store: await openStore(path.join(dir, 'tracker.json')), dir };
}

const pkg = {
  carrier: 'usps',
  trackingNumber: '9400111899223197428490',
  channelId: 'chan-1',
  userId: 'user-1',
  guildId: 'guild-1',
  label: 'keyboard',
};

test('adds a subscription and creates the shipment once', async () => {
  const { store } = await tempStore();
  const first = await store.addSubscription(pkg);
  assert.equal(first.created, true);
  assert.equal(first.key, 'usps:9400111899223197428490');

  // Same user, same channel: idempotent.
  const again = await store.addSubscription({ ...pkg, label: 'mechanical keyboard' });
  assert.equal(again.created, false);
  assert.equal(store.shipments().length, 1);
  assert.equal(store.subscribersOf(first.key)[0].label, 'mechanical keyboard');

  // A second person in another channel shares the same shipment record.
  await store.addSubscription({ ...pkg, channelId: 'chan-2', userId: 'user-2' });
  assert.equal(store.shipments().length, 1);
  assert.equal(store.subscribersOf(first.key).length, 2);
});

test('removing the last subscriber drops the shipment', async () => {
  const { store } = await tempStore();
  const { key } = await store.addSubscription(pkg);
  await store.addSubscription({ ...pkg, userId: 'user-2' });

  await store.removeSubscription(key, { channelId: 'chan-1', userId: 'user-1' });
  assert.equal(store.subscribersOf(key).length, 1);
  assert.equal(store.shipments().length, 1);

  await store.removeSubscription(key, { channelId: 'chan-1', userId: 'user-2' });
  assert.equal(store.shipments().length, 0);
  assert.equal(store.getShipment(key), null);
});

test('removing something untracked reports it', async () => {
  const { store } = await tempStore();
  const result = await store.removeSubscription('usps:000', { channelId: 'c', userId: 'u' });
  assert.equal(result.removed, false);
});

test('lists by channel and by user, and counts per user', async () => {
  const { store } = await tempStore();
  await store.addSubscription(pkg);
  await store.addSubscription({ ...pkg, trackingNumber: '1Z999AA10123456784', carrier: 'ups', channelId: 'chan-2' });

  assert.equal(store.list({ channelId: 'chan-1' }).length, 1);
  assert.equal(store.list({ userId: 'user-1' }).length, 2);
  assert.equal(store.countForUser('user-1'), 2);
  assert.equal(store.countForUser('nobody'), 0);
  assert.deepEqual(store.stats(), {
    shipments: 2,
    subscriptions: 2,
    byCarrier: { usps: 1, ups: 1 },
  });
});

test('state survives a restart', async () => {
  const { store, dir } = await tempStore();
  const { key } = await store.addSubscription(pkg);
  await store.updateShipment(key, { lastStatus: 'IN_TRANSIT', lastFingerprint: 'abc123' });

  const reopened = await openStore(path.join(dir, 'tracker.json'));
  const shipment = reopened.getShipment(key);
  assert.equal(shipment.lastStatus, 'IN_TRANSIT');
  assert.equal(shipment.lastFingerprint, 'abc123');
  assert.equal(reopened.subscribersOf(key)[0].label, 'keyboard');
});

test('concurrent saves converge on the final state', async () => {
  const { store, dir } = await tempStore();
  const { key } = await store.addSubscription(pkg);
  await Promise.all([
    store.updateShipment(key, { lastStatus: 'A' }),
    store.updateShipment(key, { lastStatus: 'B' }),
    store.updateShipment(key, { lastStatus: 'C' }),
  ]);
  await store.save();

  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'tracker.json'), 'utf8'));
  assert.equal(onDisk.shipments[key].lastStatus, 'C');
  const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('updateShipment on a missing key is a no-op', async () => {
  const { store } = await tempStore();
  assert.equal(await store.updateShipment('usps:missing', { lastStatus: 'X' }), null);
});

test('a brand new store file is created on first load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-store-'));
  const file = path.join(dir, 'nested', 'tracker.json');
  const store = new Store(file);
  await store.load();
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(raw, { version: 1, shipments: {}, subscriptions: {} });
});
