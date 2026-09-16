import * as usps from './usps.js';
import * as ups from './ups.js';
import * as fedex from './fedex.js';
import * as easypost from './easypost.js';
import { config } from '../config.js';

export const carriers = { usps, ups, fedex };
export const CARRIER_IDS = Object.keys(carriers);
export { easypost };

/**
 * Which transport will serve a carrier right now:
 *   'direct'   — the carrier's own API (it has credentials)
 *   'easypost' — EasyPost, which covers all three with one key
 *   null       — nothing configured, so lookups are skipped
 * TRACKING_PROVIDER forces one or the other; the default prefers a carrier's
 * own API when it has credentials, so approval later takes over by itself.
 */
export function carrierTransport(id, cfg = config) {
  const direct = carriers[String(id || '').toLowerCase()];
  if (!direct) return null;

  if (cfg.provider === 'direct') return direct.isConfigured() ? 'direct' : null;
  if (cfg.provider === 'easypost') return easypost.isConfigured() ? 'easypost' : null;

  if (direct.isConfigured()) return 'direct';
  if (easypost.isConfigured()) return 'easypost';
  return null;
}

/**
 * The module that fetches for a carrier. When EasyPost is the transport this
 * is a wrapper that keeps the carrier's own id, label and tracking URL, so
 * shipments stay keyed by carrier and nothing downstream changes.
 */
export function getCarrier(id) {
  const carrier = carriers[String(id || '').toLowerCase()];
  if (!carrier) throw new Error(`Unknown carrier "${id}"`);
  return carrierTransport(id) === 'easypost' ? easypost.wrap(carrier) : carrier;
}

/** Uppercase, strip spaces and dashes — how every carrier's own site normalises input. */
export function normalizeTrackingNumber(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

/**
 * USPS IMpb labels are often scanned with a leading 420 + destination ZIP
 * routing prefix. Strip it so the carrier API sees the real barcode.
 */
function stripImpbRoutingPrefix(number) {
  const match = /^420\d{5}(\d{4})?((92|93|94|95)\d{18,20})$/.exec(number);
  return match ? match[2] : number;
}

const RULES = [
  { carrier: 'ups', test: (n) => /^1Z[0-9A-Z]{16}$/.test(n) },
  { carrier: 'ups', test: (n) => /^T\d{10}$/.test(n) },
  // FedEx SmartPost / Ground 96-prefixed barcodes (20 or 22 digits).
  { carrier: 'fedex', test: (n) => /^96\d{18}$/.test(n) || /^96\d{20}$/.test(n) },
  // USPS IMpb: 20 or 22 digits starting with a service-code pair.
  { carrier: 'usps', test: (n) => /^(92|93|94|95)\d{18}$/.test(n) || /^(92|93|94|95)\d{20}$/.test(n) },
  // USPS legacy domestic (certified, signature confirmation, etc.).
  { carrier: 'usps', test: (n) => /^(70|71|72|73|77|81|82|91)\d{18}$/.test(n) },
  // USPS international / UPU S10 format, e.g. LZ123456789US.
  { carrier: 'usps', test: (n) => /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n) },
  { carrier: 'fedex', test: (n) => /^\d{12}$/.test(n) },
  { carrier: 'fedex', test: (n) => /^\d{15}$/.test(n) },
  { carrier: 'fedex', test: (n) => /^\d{22}$/.test(n) },
];

/**
 * Guess the carrier from the tracking number's shape.
 * Returns every plausible carrier, best guess first; empty when nothing matches.
 */
export function detectCarriers(rawNumber) {
  const number = stripImpbRoutingPrefix(normalizeTrackingNumber(rawNumber));
  const matches = [];
  for (const rule of RULES) {
    if (rule.test(number) && !matches.includes(rule.carrier)) matches.push(rule.carrier);
  }
  return matches;
}

export function detectCarrier(rawNumber) {
  return detectCarriers(rawNumber)[0] ?? null;
}

/** Normalised number plus resolved carrier, or a human-readable reason why not. */
export function resolveShipment(rawNumber, explicitCarrier = null) {
  const number = stripImpbRoutingPrefix(normalizeTrackingNumber(rawNumber));
  if (!number) return { ok: false, reason: 'No tracking number provided.' };
  if (!/^[A-Z0-9]{8,35}$/.test(number)) {
    return { ok: false, reason: `"${rawNumber}" does not look like a tracking number.` };
  }

  if (explicitCarrier) {
    const id = String(explicitCarrier).toLowerCase();
    if (!carriers[id]) return { ok: false, reason: `Unknown carrier "${explicitCarrier}".` };
    return { ok: true, carrier: id, trackingNumber: number, detected: false };
  }

  const detected = detectCarrier(number);
  if (!detected) {
    return {
      ok: false,
      reason: `Could not tell which carrier ${number} belongs to. Re-run with the \`carrier\` option.`,
    };
  }
  return { ok: true, carrier: detected, trackingNumber: number, detected: true };
}

export function shipmentKey(carrier, trackingNumber) {
  return `${carrier}:${trackingNumber}`;
}
