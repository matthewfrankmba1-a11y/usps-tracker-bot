import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { carrierTransport, getCarrier } from '../src/carriers/index.js';
import * as easypost from '../src/carriers/easypost.js';
import * as usps from '../src/carriers/usps.js';
import { STATUS } from '../src/carriers/normalize.js';

const tracker = () => JSON.parse(readFileSync(new URL('./fixtures/easypost.json', import.meta.url), 'utf8'));

/** Run `fn` with the config temporarily patched, then put it back. */
async function withConfig(patch, fn) {
  const before = {
    provider: config.provider,
    apiKey: config.easypost.apiKey,
    usps: { ...config.carriers.usps },
  };
  config.provider = patch.provider ?? before.provider;
  config.easypost.apiKey = patch.apiKey ?? '';
  config.carriers.usps.clientId = patch.uspsClientId ?? '';
  config.carriers.usps.clientSecret = patch.uspsClientSecret ?? '';
  try {
    return await fn();
  } finally {
    config.provider = before.provider;
    config.easypost.apiKey = before.apiKey;
    Object.assign(config.carriers.usps, before.usps);
  }
}

test('parses an EasyPost tracker into the shared shape', () => {
  const result = easypost.parseTracker(tracker());
  assert.equal(result.carrier, 'usps', 'carrier read back from the tracker');
  assert.equal(result.trackingNumber, '9434908106245562362229');
  assert.equal(result.status, STATUS.IN_TRANSIT);
  assert.equal(result.statusText, 'Arrived at facility');
  assert.equal(result.service, 'First-Class Package Service');
  assert.equal(result.estimatedDelivery, '2026-09-17T00:00:00.000Z');
  assert.equal(result.trackingUrl, 'https://track.easypost.com/djE6dHJrXzlmOGU3ZDZjNWI0YQ');
  assert.equal(result.lastEvent.description, 'Arrived at USPS Regional Origin Facility');
  assert.equal(result.lastEvent.location, 'DALLAS, TX');
  assert.equal(result.events.length, 2);
});

test('maps every EasyPost status onto our vocabulary', () => {
  const cases = {
    pre_transit: STATUS.PRE_TRANSIT,
    in_transit: STATUS.IN_TRANSIT,
    out_for_delivery: STATUS.OUT_FOR_DELIVERY,
    delivered: STATUS.DELIVERED,
    available_for_pickup: STATUS.AVAILABLE_FOR_PICKUP,
    return_to_sender: STATUS.RETURNED,
    failure: STATUS.EXCEPTION,
    cancelled: STATUS.EXCEPTION,
    unknown: STATUS.UNKNOWN,
  };
  for (const [easypostStatus, expected] of Object.entries(cases)) {
    const result = easypost.parseTracker({ ...tracker(), status: easypostStatus });
    assert.equal(result.status, expected, `${easypostStatus} -> ${expected}`);
  }
});

test('an unrecognised status falls back to reading the text', () => {
  const result = easypost.parseTracker({ ...tracker(), status: 'weird_new_status', status_detail: 'out_for_delivery' });
  assert.equal(result.status, STATUS.OUT_FOR_DELIVERY);
});

test('an explicit carrier hint wins over the tracker field', () => {
  const result = easypost.parseTracker({ ...tracker(), carrier: 'USPS' }, 'ups');
  assert.equal(result.carrier, 'ups');
});

test('an empty tracker is an error, not an empty result', () => {
  assert.throws(() => easypost.parseTracker({}), /no tracker/);
  assert.throws(() => easypost.parseTracker(null), /no tracker/);
});

test('looks up an existing tracker before creating one', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    return new Response(JSON.stringify({ trackers: [tracker()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await withConfig({ apiKey: 'EZAK_test' }, async () => {
      const result = await easypost.track('9434908106245562362229', 'usps');
      assert.equal(result.status, STATUS.IN_TRANSIT);
    });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 1, 'no tracker created when one already exists');
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/v2\/trackers\?tracking_code=9434908106245562362229/);
});

test('creates a tracker, with the carrier hint, when none exists yet', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    const body = options.method === 'POST' ? tracker() : { trackers: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await withConfig({ apiKey: 'EZAK_test' }, async () => {
      await easypost.track('9434908106245562362229', 'fedex');
    });
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), {
    tracker: { tracking_code: '9434908106245562362229', carrier: 'FedEx' },
  });
});

test('track() refuses to call out without an API key', async () => {
  await withConfig({ apiKey: '' }, async () => {
    await assert.rejects(() => easypost.track('9434908106245562362229'), /EASYPOST_API_KEY is not set/);
  });
});

test('transport selection follows credentials and TRACKING_PROVIDER', async () => {
  await withConfig({}, () => assert.equal(carrierTransport('usps'), null));
  await withConfig({ apiKey: 'EZAK_test' }, () => assert.equal(carrierTransport('usps'), 'easypost'));
  await withConfig({ uspsClientId: 'a', uspsClientSecret: 'b' }, () =>
    assert.equal(carrierTransport('usps'), 'direct'),
  );
  // A carrier's own API wins once it has credentials, so approval takes over.
  await withConfig({ apiKey: 'EZAK_test', uspsClientId: 'a', uspsClientSecret: 'b' }, () =>
    assert.equal(carrierTransport('usps'), 'direct'),
  );
  await withConfig({ provider: 'easypost', apiKey: 'EZAK_test', uspsClientId: 'a', uspsClientSecret: 'b' }, () =>
    assert.equal(carrierTransport('usps'), 'easypost'),
  );
  await withConfig({ provider: 'direct', apiKey: 'EZAK_test' }, () =>
    assert.equal(carrierTransport('usps'), null),
  );
});

test('the EasyPost wrapper still looks like the carrier itself', async () => {
  await withConfig({ apiKey: 'EZAK_test' }, () => {
    const carrier = getCarrier('usps');
    assert.equal(carrier.id, 'usps');
    assert.equal(carrier.label, 'USPS');
    assert.equal(carrier.via, 'easypost');
    assert.equal(carrier.isConfigured(), true);
    // Links still point at the carrier's own site, not EasyPost's.
    assert.equal(carrier.trackingUrl('9434908106245562362229'), usps.trackingUrl('9434908106245562362229'));
  });
});
