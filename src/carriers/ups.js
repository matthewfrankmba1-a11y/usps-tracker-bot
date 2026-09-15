import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { CarrierError, createTokenCache, requestJson } from './http.js';
import { STATUS, formatLocation, makeEvent, makeResult, statusFromText } from './normalize.js';

export const id = 'ups';
export const label = 'UPS';

/**
 * UPS Tracking API. OAuth 2.0 client credentials with HTTP Basic auth on the
 * token endpoint. Docs: https://developer.ups.com/api/reference?loc=en_US#operation/getSingleTrackResponseUsingGET
 */
const getToken = createTokenCache(async () => {
  const { clientId, clientSecret, baseUrl } = config.carriers.ups;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = await requestJson(
    `${baseUrl}/security/v1/oauth/token`,
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    },
    { carrier: id },
  );
  if (!body.access_token) throw new CarrierError('UPS token response had no access_token', { carrier: id });
  return { accessToken: body.access_token, expiresIn: body.expires_in };
});

export function isConfigured() {
  const { clientId, clientSecret } = config.carriers.ups;
  return Boolean(clientId && clientSecret);
}

export function trackingUrl(trackingNumber) {
  return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
}

export async function track(trackingNumber) {
  const token = await getToken();
  const url = `${config.carriers.ups.baseUrl}/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US&returnSignature=false`;
  const body = await requestJson(
    url,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        transId: randomUUID(),
        transactionSrc: 'usps-tracker-bot',
      },
    },
    { carrier: id },
  );
  return parseUpsResponse(trackingNumber, body);
}

/** Exported for tests: turns a UPS trackResponse payload into our normalised shape. */
export function parseUpsResponse(trackingNumber, body) {
  const shipment = body?.trackResponse?.shipment?.[0];
  const pkg = shipment?.package?.[0];
  if (!pkg) {
    throw new CarrierError(`UPS returned no package data for ${trackingNumber}`, { carrier: id });
  }

  const events = (pkg.activity || []).map((activity) =>
    makeEvent({
      timestamp: parseUpsDateTime(activity.date, activity.time),
      description: activity.status?.description || activity.status?.type || '',
      location: formatLocation(
        activity.location?.address?.city,
        activity.location?.address?.stateProvince,
        activity.location?.address?.countryCode,
      ),
    }),
  );

  const latest = pkg.activity?.[0]?.status;
  const statusText = pkg.currentStatus?.description || latest?.description || '';
  let status = statusFromText(statusText);
  // UPS status types: D=delivered, I=in transit, M=manifest/label, X=exception, P=pickup, RS=return
  const type = (pkg.currentStatus?.type || latest?.type || '').toUpperCase();
  if (type === 'D') status = STATUS.DELIVERED;
  else if (type === 'M') status = STATUS.PRE_TRANSIT;
  else if (type === 'X') status = STATUS.EXCEPTION;
  else if (type === 'RS') status = STATUS.RETURNED;
  else if (type === 'P' && status === STATUS.UNKNOWN) status = STATUS.AVAILABLE_FOR_PICKUP;
  else if (type === 'I' && status === STATUS.UNKNOWN) status = STATUS.IN_TRANSIT;

  const scheduled = (pkg.deliveryDate || []).find((d) => d.type === 'SDD') || (pkg.deliveryDate || [])[0];

  return makeResult({
    carrier: id,
    trackingNumber,
    status,
    statusText,
    estimatedDelivery: scheduled ? parseUpsDateTime(scheduled.date, pkg.deliveryTime?.endTime) : null,
    events,
    service: pkg.service?.description || '',
    trackingUrl: trackingUrl(trackingNumber),
  });
}

/** UPS dates are YYYYMMDD and times HHMMSS, in the local time of the scan. */
export function parseUpsDateTime(date, time) {
  if (!date || !/^\d{8}$/.test(String(date))) return null;
  const d = String(date);
  const t = /^\d{6}$/.test(String(time || '')) ? String(time) : '000000';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}
