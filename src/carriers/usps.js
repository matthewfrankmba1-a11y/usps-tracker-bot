import { config } from '../config.js';
import { CarrierError, createTokenCache, requestJson } from './http.js';
import { STATUS, formatLocation, makeEvent, makeResult, statusFromText } from './normalize.js';

export const id = 'usps';
export const label = 'USPS';

/**
 * USPS APIs (apis.usps.com) use OAuth 2.0 client credentials.
 * Docs: https://developer.usps.com/ — Tracking 3.0.
 */
const getToken = createTokenCache(async () => {
  const { clientId, clientSecret, baseUrl } = config.carriers.usps;
  const body = await requestJson(
    `${baseUrl}/oauth2/v3/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
    { carrier: id },
  );
  if (!body.access_token) throw new CarrierError('USPS token response had no access_token', { carrier: id });
  return { accessToken: body.access_token, expiresIn: body.expires_in };
});

export function isConfigured() {
  const { clientId, clientSecret } = config.carriers.usps;
  return Boolean(clientId && clientSecret);
}

export function trackingUrl(trackingNumber) {
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
}

export async function track(trackingNumber) {
  const token = await getToken();
  const url = `${config.carriers.usps.baseUrl}/tracking/v3/tracking/${encodeURIComponent(trackingNumber)}?expand=DETAIL`;
  const body = await requestJson(
    url,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
    { carrier: id },
  );
  return parseUspsResponse(trackingNumber, body);
}

/** Exported for tests: turns a USPS tracking payload into our normalised shape. */
export function parseUspsResponse(trackingNumber, body) {
  const events = (body.trackingEvents || []).map((event) =>
    makeEvent({
      timestamp: event.eventTimestamp,
      description: [event.eventType, event.eventStatus].filter(Boolean).join(' — ') || event.eventType,
      location: formatLocation(event.eventCity, event.eventState, event.eventCountry),
    }),
  );

  const summary = body.statusSummary || body.status || '';
  const category = String(body.statusCategory || '').toLowerCase();
  let status = statusFromText(summary || events[0]?.description);
  if (category.includes('deliver') && !category.includes('out for')) status = STATUS.DELIVERED;
  if (category.includes('out for delivery')) status = STATUS.OUT_FOR_DELIVERY;

  return makeResult({
    carrier: id,
    trackingNumber,
    status,
    statusText: summary,
    estimatedDelivery: body.expectedDeliveryDate || body.predictedDeliveryDate || null,
    events,
    service: body.mailClass || body.serviceTypeDescription || '',
    trackingUrl: trackingUrl(trackingNumber),
  });
}
