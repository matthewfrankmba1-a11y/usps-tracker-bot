import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectCarrier, detectCarriers, normalizeTrackingNumber, resolveShipment } from '../src/carriers/index.js';
import { parseUspsResponse } from '../src/carriers/usps.js';
import { parseUpsResponse, parseUpsDateTime } from '../src/carriers/ups.js';
import { parseFedexResponse } from '../src/carriers/fedex.js';
import { STATUS, fingerprint, statusFromText } from '../src/carriers/normalize.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('normalizes user-pasted tracking numbers', () => {
  assert.equal(normalizeTrackingNumber(' 1z999aa1-0123456784 '), '1Z999AA10123456784');
});

test('detects carriers from tracking number shape', () => {
  assert.equal(detectCarrier('1Z999AA10123456784'), 'ups');
  assert.equal(detectCarrier('9400111899223197428490'), 'usps');
  assert.equal(detectCarrier('LZ123456789US'), 'usps');
  assert.equal(detectCarrier('7012 3456 7891 2345 6789'), 'usps');
  assert.equal(detectCarrier('123456789012'), 'fedex');
  assert.equal(detectCarrier('9611020987654312345672'), 'fedex');
  assert.equal(detectCarrier('nope'), null);
});

test('strips the 420+ZIP IMpb routing prefix USPS labels carry', () => {
  const resolved = resolveShipment('420902109405511899223197428490');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.carrier, 'usps');
  assert.equal(resolved.trackingNumber, '9405511899223197428490');
});

test('detectCarriers never returns duplicates', () => {
  const matches = detectCarriers('9400111899223197428490');
  assert.deepEqual(matches, [...new Set(matches)]);
});

test('an explicit carrier overrides detection', () => {
  const resolved = resolveShipment('123456789012', 'usps');
  assert.deepEqual(resolved, {
    ok: true,
    carrier: 'usps',
    trackingNumber: '123456789012',
    detected: false,
  });
});

test('rejects junk and unknown carriers', () => {
  assert.equal(resolveShipment('hi').ok, false);
  assert.equal(resolveShipment('123456789012', 'dhl').ok, false);
  assert.match(resolveShipment('12345678901234567890123456789012345678').reason, /does not look like/);
});

test('maps carrier wording onto shared statuses', () => {
  assert.equal(statusFromText('Delivered, In/At Mailbox'), STATUS.DELIVERED);
  assert.equal(statusFromText('Out for Delivery'), STATUS.OUT_FOR_DELIVERY);
  assert.equal(statusFromText('Shipping Label Created, USPS Awaiting Item'), STATUS.PRE_TRANSIT);
  assert.equal(statusFromText('Return to Sender'), STATUS.RETURNED);
  assert.equal(statusFromText('Delivery Exception: weather delay'), STATUS.EXCEPTION);
  assert.equal(statusFromText(''), STATUS.UNKNOWN);
});

test('parses a USPS tracking payload', () => {
  const result = parseUspsResponse('9400111899223197428490', fixture('usps'));
  assert.equal(result.carrier, 'usps');
  assert.equal(result.status, STATUS.OUT_FOR_DELIVERY);
  assert.equal(result.events.length, 3);
  assert.equal(result.lastEvent.location, 'BROOKLYN, NY');
  assert.equal(result.lastEvent.timestamp, '2026-09-15T06:41:00.000Z');
  assert.match(result.trackingUrl, /tools\.usps\.com/);
});

test('parses a UPS tracking payload and its YYYYMMDD timestamps', () => {
  const result = parseUpsResponse('1Z999AA10123456784', fixture('ups'));
  assert.equal(result.status, STATUS.DELIVERED);
  assert.equal(result.service, 'UPS Ground');
  assert.equal(result.lastEvent.description, 'Delivered');
  assert.equal(result.deliveredAt, '2026-09-14T14:35:12.000Z');
  assert.equal(parseUpsDateTime('20260914', '143512'), '2026-09-14T14:35:12Z');
  assert.equal(parseUpsDateTime('20260914'), '2026-09-14T00:00:00Z');
  assert.equal(parseUpsDateTime('bad', '143512'), null);
});

test('parses a FedEx tracking payload', () => {
  const result = parseFedexResponse('123456789012', fixture('fedex'));
  assert.equal(result.status, STATUS.IN_TRANSIT);
  assert.equal(result.statusText, 'In transit');
  assert.equal(result.service, 'FedEx Express Saver');
  assert.equal(result.estimatedDelivery, '2026-09-17T01:00:00.000Z');
  assert.equal(result.events[0].description, 'Departed FedEx location');
});

test('FedEx errors surface instead of parsing as empty', () => {
  assert.throws(
    () =>
      parseFedexResponse('123456789012', {
        output: {
          completeTrackResults: [
            { trackResults: [{ error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: 'Not found' } }] },
          ],
        },
      }),
    /Not found/,
  );
});

test('events are sorted newest first regardless of carrier order', () => {
  const result = parseFedexResponse('123456789012', fixture('fedex'));
  const times = result.events.map((e) => new Date(e.timestamp).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('fingerprint changes only when something user-visible changes', () => {
  const base = parseUspsResponse('9400111899223197428490', fixture('usps'));
  const same = parseUspsResponse('9400111899223197428490', fixture('usps'));
  assert.equal(fingerprint(base), fingerprint(same));

  const moved = fixture('usps');
  moved.trackingEvents.unshift({
    eventType: 'Delivered, In/At Mailbox',
    eventTimestamp: '2026-09-15T15:20:00Z',
    eventCity: 'BROOKLYN',
    eventState: 'NY',
    eventCountry: 'US',
  });
  moved.statusSummary = 'Delivered, In/At Mailbox';
  moved.statusCategory = 'Delivered';
  const after = parseUspsResponse('9400111899223197428490', moved);
  assert.equal(after.status, STATUS.DELIVERED);
  assert.notEqual(fingerprint(base), fingerprint(after));
});
