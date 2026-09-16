import { config } from '../config.js';
import { CarrierError, requestJson } from './http.js';
import { STATUS, formatLocation, makeEvent, makeResult, statusFromText } from './normalize.js';

export const id = 'easypost';
export const label = 'EasyPost';

/**
 * EasyPost Tracking API — one key covers USPS, UPS and FedEx, which avoids
 * three separate carrier onboarding queues.
 * Docs: https://docs.easypost.com/docs/trackers
 *
 * EasyPost polls the carriers itself and keeps a Tracker object up to date, so
 * we look up the existing tracker for a code and only create one the first
 * time we see it.
 */

/** Carrier ids as EasyPost names them. */
const CARRIER_NAMES = { usps: 'USPS', ups: 'UPS', fedex: 'FedEx' };

/** EasyPost's status vocabulary mapped onto ours. */
const STATUS_MAP = {
  pre_transit: STATUS.PRE_TRANSIT,
  in_transit: STATUS.IN_TRANSIT,
  out_for_delivery: STATUS.OUT_FOR_DELIVERY,
  delivered: STATUS.DELIVERED,
  available_for_pickup: STATUS.AVAILABLE_FOR_PICKUP,
  return_to_sender: STATUS.RETURNED,
  failure: STATUS.EXCEPTION,
  cancelled: STATUS.EXCEPTION,
  error: STATUS.UNKNOWN,
  unknown: STATUS.UNKNOWN,
};

export function isConfigured() {
  return Boolean(config.easypost.apiKey);
}

/** EasyPost authenticates with the API key as the HTTP Basic username. */
function headers() {
  const key = config.easypost.apiKey;
  return {
    authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    accept: 'application/json',
  };
}

export function trackingUrl(trackingNumber) {
  return `https://track.easypost.com/?tracking_code=${encodeURIComponent(trackingNumber)}`;
}

export async function track(trackingNumber, carrierId = null) {
  if (!isConfigured()) throw new CarrierError('EASYPOST_API_KEY is not set', { carrier: id });
  const base = config.easypost.baseUrl;

  const found = await requestJson(
    `${base}/v2/trackers?tracking_code=${encodeURIComponent(trackingNumber)}&page_size=5`,
    { headers: headers() },
    { carrier: id },
  );

  const tracker = found.trackers?.[0] ?? (await createTracker(trackingNumber, carrierId));
  return parseTracker(tracker, carrierId);
}

async function createTracker(trackingNumber, carrierId) {
  const body = {
    tracker: {
      tracking_code: trackingNumber,
      ...(CARRIER_NAMES[carrierId] ? { carrier: CARRIER_NAMES[carrierId] } : {}),
    },
  };
  return requestJson(
    `${config.easypost.baseUrl}/v2/trackers`,
    {
      method: 'POST',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { carrier: id },
  );
}

/** Exported for tests: turns an EasyPost Tracker object into our shape. */
export function parseTracker(tracker, carrierId = null) {
  if (!tracker?.tracking_code) {
    throw new CarrierError('EasyPost returned no tracker', { carrier: id });
  }

  const events = (tracker.tracking_details || []).map((detail) =>
    makeEvent({
      timestamp: detail.datetime,
      description: detail.message || humanize(detail.status_detail || detail.status),
      location: formatLocation(
        detail.tracking_location?.city,
        detail.tracking_location?.state,
        detail.tracking_location?.country,
      ),
    }),
  );

  // status_detail is snake_case ("out_for_delivery"), so humanize it before
  // the text matcher sees it.
  const status =
    STATUS_MAP[String(tracker.status || '').toLowerCase()] ??
    statusFromText(humanize(tracker.status_detail) || events[0]?.description);

  const resolvedCarrier = carrierId || reverseCarrier(tracker.carrier) || 'usps';

  return makeResult({
    carrier: resolvedCarrier,
    trackingNumber: tracker.tracking_code,
    status,
    statusText: humanize(tracker.status_detail) || humanize(tracker.status) || events[0]?.description || '',
    estimatedDelivery: tracker.est_delivery_date || null,
    events,
    service: tracker.carrier_detail?.service || '',
    // EasyPost's hosted page shows the carrier's own scans and needs no key.
    trackingUrl: tracker.public_url || trackingUrl(tracker.tracking_code),
  });
}

function reverseCarrier(name) {
  const lower = String(name || '').toLowerCase();
  return Object.keys(CARRIER_NAMES).find((key) => lower.includes(key)) ?? null;
}

/** "out_for_delivery" -> "Out for delivery" */
function humanize(value) {
  if (!value) return '';
  const words = String(value).replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Present EasyPost as if it were the carrier itself: same id, label and
 * tracking URL, so shipments stay keyed by carrier and nothing downstream
 * needs to know which transport fetched the data.
 */
export function wrap(carrier) {
  return {
    id: carrier.id,
    label: carrier.label,
    via: id,
    isConfigured,
    trackingUrl: carrier.trackingUrl,
    track: (trackingNumber) => track(trackingNumber, carrier.id),
  };
}
