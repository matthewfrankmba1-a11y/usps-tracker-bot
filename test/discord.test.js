import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseUspsResponse } from '../src/carriers/usps.js';
import { parseUpsResponse } from '../src/carriers/ups.js';
import { STATUS } from '../src/carriers/normalize.js';
import { listEmbed, statusEmbed, timeTag, trackingEmbed } from '../src/discord/embeds.js';
import { commands, trackCommand } from '../src/discord/commands.js';
import { startHealthServer } from '../src/health.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('slash command definition serialises with every subcommand', () => {
  const json = trackCommand.toJSON();
  assert.equal(json.name, 'track');
  assert.deepEqual(
    json.options.map((o) => o.name).sort(),
    ['add', 'check', 'list', 'remove', 'status'],
  );
  assert.equal(commands.length, 1);

  const add = json.options.find((o) => o.name === 'add');
  assert.equal(add.options[0].required, true);
  assert.deepEqual(
    add.options.find((o) => o.name === 'carrier').choices.map((c) => c.value),
    ['usps', 'ups', 'fedex'],
  );
});

test('tracking embed renders status, scan history and a carrier link', () => {
  const result = parseUspsResponse('9400111899223197428490', fixture('usps'));
  const json = trackingEmbed(result, { label: 'keyboard', previousStatus: STATUS.IN_TRANSIT }).toJSON();

  assert.match(json.title, /Out for delivery — keyboard/);
  assert.match(json.url, /tools\.usps\.com/);
  const fields = Object.fromEntries(json.fields.map((f) => [f.name, f.value]));
  assert.equal(fields['Tracking #'], '`9400111899223197428490`');
  assert.equal(fields.Carrier, 'USPS');
  assert.match(fields.Changed, /In transit → \*\*Out for delivery\*\*/);
  assert.match(fields['Latest scan'], /BROOKLYN, NY/);
  assert.ok(fields.Earlier.includes('Arrived at Post Office'));
});

test('delivered packages show a delivery time instead of an estimate', () => {
  const result = parseUpsResponse('1Z999AA10123456784', fixture('ups'));
  const fields = Object.fromEntries(trackingEmbed(result).toJSON().fields.map((f) => [f.name, f.value]));
  assert.ok(fields.Delivered, 'delivered field present');
  assert.equal(fields['Estimated delivery'], undefined);
});

test('every embed field stays inside Discord limits', () => {
  const payload = fixture('usps');
  // 40 scans with long descriptions: the "Earlier" field must not overflow 1024.
  payload.trackingEvents = Array.from({ length: 40 }, (_, i) => ({
    eventType: `Departed USPS Regional Facility ${'x'.repeat(80)} ${i}`,
    eventTimestamp: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
    eventCity: 'BROOKLYN',
    eventState: 'NY',
  }));
  const json = trackingEmbed(parseUspsResponse('9400111899223197428490', payload), {
    label: 'x'.repeat(80),
  }).toJSON();

  assert.ok(json.title.length <= 256, 'title within 256');
  for (const field of json.fields) {
    assert.ok(field.value.length <= 1024, `${field.name} within 1024`);
  }
});

test('list embed handles empty and populated scopes', () => {
  const empty = listEmbed([], { scopeLabel: '#this channel' }).toJSON();
  assert.match(empty.description, /Nothing tracked yet/);

  const rows = [
    {
      carrier: 'ups',
      trackingNumber: '1Z999AA10123456784',
      lastStatus: STATUS.IN_TRANSIT,
      lastCheckedAt: '2026-09-15T12:00:00Z',
      subscription: { label: 'monitor' },
    },
  ];
  const filled = listEmbed(rows, { scopeLabel: 'yours' }).toJSON();
  assert.match(filled.description, /monitor/);
  assert.match(filled.description, /UPS/);
  assert.ok(filled.description.length <= 4096);
});

test('status embed reports carrier configuration', () => {
  const json = statusEmbed({
    stats: { shipments: 3, subscriptions: 4 },
    carrierStatus: { usps: true, ups: false, fedex: false },
    intervalMinutes: 20,
    nextPollAt: '2026-09-15T12:20:00Z',
    lastPollAt: '2026-09-15T12:00:00Z',
    startedAt: '2026-09-15T08:00:00Z',
  }).toJSON();
  const fields = Object.fromEntries(json.fields.map((f) => [f.name, f.value]));
  assert.equal(fields['Poll interval'], '20 min');
  assert.match(fields.Carriers, /🟢 USPS — configured/);
  assert.match(fields.Carriers, /⚪ UPS — no credentials/);
});

test('timeTag emits Discord timestamps and tolerates junk', () => {
  assert.equal(timeTag('2026-09-15T12:00:00Z', 'R'), '<t:1789473600:R>');
  assert.equal(timeTag(null), 'unknown');
  assert.equal(timeTag('not-a-date'), 'unknown');
});

test('health endpoint reports 503 until the gateway is ready', async () => {
  const client = { isReady: () => false, ws: { status: 1, ping: -1 }, guilds: { cache: { size: 0 } } };
  const store = { stats: () => ({ shipments: 0, subscriptions: 0, byCarrier: {} }) };
  const poller = { snapshot: () => ({ startedAt: '2026-09-15T08:00:00Z', lastPollAt: null }) };
  const server = startHealthServer({ port: 0, client, store, poller });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const notReady = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(notReady.status, 503);
    assert.equal((await notReady.json()).status, 'starting');

    client.isReady = () => true;
    client.ws.status = 0;
    const ready = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(ready.status, 200);
    const body = await ready.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.discord.ready, true);

    const missing = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
