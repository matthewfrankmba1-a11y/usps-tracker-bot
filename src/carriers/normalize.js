import { createHash } from 'node:crypto';

/** Carrier-independent shipment states, ordered from earliest to terminal. */
export const STATUS = {
  UNKNOWN: 'UNKNOWN',
  PRE_TRANSIT: 'PRE_TRANSIT',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  AVAILABLE_FOR_PICKUP: 'AVAILABLE_FOR_PICKUP',
  EXCEPTION: 'EXCEPTION',
  RETURNED: 'RETURNED',
};

export const STATUS_LABEL = {
  UNKNOWN: 'Unknown',
  PRE_TRANSIT: 'Label created',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  AVAILABLE_FOR_PICKUP: 'Available for pickup',
  EXCEPTION: 'Exception',
  RETURNED: 'Returned to sender',
};

export const STATUS_EMOJI = {
  UNKNOWN: '❔',
  PRE_TRANSIT: '🏷️',
  IN_TRANSIT: '🚚',
  OUT_FOR_DELIVERY: '📦',
  DELIVERED: '✅',
  AVAILABLE_FOR_PICKUP: '🏤',
  EXCEPTION: '⚠️',
  RETURNED: '↩️',
};

export const STATUS_COLOR = {
  UNKNOWN: 0x99aab5,
  PRE_TRANSIT: 0x95a5a6,
  IN_TRANSIT: 0x3498db,
  OUT_FOR_DELIVERY: 0xf1c40f,
  DELIVERED: 0x2ecc71,
  AVAILABLE_FOR_PICKUP: 0x9b59b6,
  EXCEPTION: 0xe67e22,
  RETURNED: 0xe74c3c,
};

/**
 * Best-effort mapping from free-text carrier wording to our vocabulary.
 * Carriers each have their own codes, but the phrasing is remarkably consistent.
 */
export function statusFromText(text = '') {
  const t = String(text).toLowerCase();
  if (!t) return STATUS.UNKNOWN;
  if (/(return(ed|ing)? to (sender|shipper))|undeliverable as addressed/.test(t)) return STATUS.RETURNED;
  if (/delivered|left with individual|picked up by (the )?(customer|recipient)/.test(t)) return STATUS.DELIVERED;
  if (/out for delivery|with (the )?(delivery )?(courier|driver)|on (the )?vehicle for delivery/.test(t)) {
    return STATUS.OUT_FOR_DELIVERY;
  }
  if (/available for pickup|ready for pickup|held at|available at|retail unit/.test(t)) {
    return STATUS.AVAILABLE_FOR_PICKUP;
  }
  if (/exception|delay|delayed|damage|held in customs|attempted|no access|refused|weather/.test(t)) {
    return STATUS.EXCEPTION;
  }
  if (/label (created|printed)|shipment information (sent|received)|pre-?shipment|order processed|awaiting item/.test(t)) {
    return STATUS.PRE_TRANSIT;
  }
  if (/in transit|departed|arrived|accepted|picked up|processed|shipped|on its way|tendered|origin|destination|sorting/.test(t)) {
    return STATUS.IN_TRANSIT;
  }
  return STATUS.UNKNOWN;
}

/** Normalised event: { timestamp (ISO|null), description, location } */
export function makeEvent({ timestamp = null, description = '', location = '' }) {
  return {
    timestamp: timestamp ? toIso(timestamp) : null,
    description: String(description || '').trim(),
    location: String(location || '').trim(),
  };
}

export function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Join city / state / country parts, skipping blanks. */
export function formatLocation(...parts) {
  const city = (parts[0] || '').trim();
  const region = (parts[1] || '').trim();
  const country = (parts[2] || '').trim();
  const local = [city, region].filter(Boolean).join(', ');
  if (local && country && country.toUpperCase() !== 'US') return `${local}, ${country}`;
  return local || country || '';
}

/**
 * Build the normalised tracking result every carrier module returns.
 * Events are sorted newest first; the newest one drives the summary.
 */
export function makeResult({
  carrier,
  trackingNumber,
  status,
  statusText = '',
  estimatedDelivery = null,
  deliveredAt = null,
  events = [],
  service = '',
  trackingUrl = '',
}) {
  const sorted = [...events]
    .filter(Boolean)
    .sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp));
  const lastEvent = sorted[0] || null;
  const resolvedStatus = status || statusFromText(statusText || lastEvent?.description) || STATUS.UNKNOWN;

  return {
    carrier,
    trackingNumber,
    status: resolvedStatus,
    statusText: statusText || lastEvent?.description || STATUS_LABEL[resolvedStatus],
    estimatedDelivery: toIso(estimatedDelivery),
    deliveredAt: toIso(deliveredAt) || (resolvedStatus === STATUS.DELIVERED ? lastEvent?.timestamp ?? null : null),
    events: sorted,
    lastEvent,
    service: String(service || '').trim(),
    trackingUrl,
    fetchedAt: new Date().toISOString(),
  };
}

function timeValue(iso) {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Stable digest of "everything a user would care about seeing again".
 * The poller notifies only when this changes, so re-polls are silent.
 */
export function fingerprint(result) {
  const payload = [
    result.status,
    result.statusText,
    result.lastEvent?.timestamp ?? '',
    result.lastEvent?.description ?? '',
    result.lastEvent?.location ?? '',
    result.estimatedDelivery ?? '',
  ].join('|');
  return createHash('sha1').update(payload).digest('hex').slice(0, 16);
}
