import { config } from '../config.js';
import { CarrierError, createTokenCache, requestJson } from './http.js';
import { STATUS, formatLocation, makeEvent, makeResult, statusFromText } from './normalize.js';

export const id = 'fedex';
export const label = 'FedEx';

/**
 * FedEx Track API v1. OAuth 2.0 client credentials.
 * Docs: https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html
 */
const getToken = createTokenCache(async () => {
  const { clientId, clientSecret, baseUrl } = config.carriers.fedex;
  const body = await requestJson(
    `${baseUrl}/oauth/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    },
    { carrier: id },
  );
  if (!body.access_token) throw new CarrierError('FedEx token response had no access_token', { carrier: id });
  return { accessToken: body.access_token, expiresIn: body.expires_in };
});

export function isConfigured() {
  const { clientId, clientSecret } = config.carriers.fedex;
  return Boolean(clientId && clientSecret);
}

export function trackingUrl(trackingNumber) {
  return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
}

export async function track(trackingNumber) {
  const token = await getToken();
  const body = await requestJson(
    `${config.carriers.fedex.baseUrl}/track/v1/trackingnumbers`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-locale': 'en_US',
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      }),
    },
    { carrier: id },
  );
  return parseFedexResponse(trackingNumber, body);
}

/** Exported for tests: turns a FedEx completeTrackResults payload into our shape. */
export function parseFedexResponse(trackingNumber, body) {
  const result = body?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!result) {
    throw new CarrierError(`FedEx returned no track results for ${trackingNumber}`, { carrier: id });
  }
  const error = result.error;
  if (error && !result.latestStatusDetail) {
    throw new CarrierError(`FedEx: ${error.message || error.code || 'tracking number not found'}`, {
      carrier: id,
    });
  }

  const events = (result.scanEvents || []).map((scan) =>
    makeEvent({
      timestamp: scan.date,
      description: scan.eventDescription || scan.derivedStatus || scan.eventType || '',
      location: formatLocation(
        scan.scanLocation?.city,
        scan.scanLocation?.stateOrProvinceCode,
        scan.scanLocation?.countryCode,
      ),
    }),
  );

  const latest = result.latestStatusDetail || {};
  const statusText = latest.statusByLocale || latest.description || '';
  let status = statusFromText(statusText || events[0]?.description);
  // FedEx derived codes: DL=delivered, OD=out for delivery, PU/IT/DP/AR=in transit,
  // OC=order created/label, DE=delivery exception, RS=return to shipper, HL=hold at location.
  const code = String(latest.code || '').toUpperCase();
  if (code === 'DL') status = STATUS.DELIVERED;
  else if (code === 'OD') status = STATUS.OUT_FOR_DELIVERY;
  else if (code === 'OC') status = STATUS.PRE_TRANSIT;
  else if (code === 'DE') status = STATUS.EXCEPTION;
  else if (code === 'RS') status = STATUS.RETURNED;
  else if (code === 'HL') status = STATUS.AVAILABLE_FOR_PICKUP;
  else if (['PU', 'IT', 'DP', 'AR', 'AF'].includes(code) && status === STATUS.UNKNOWN) status = STATUS.IN_TRANSIT;

  const dates = result.dateAndTimes || [];
  const estimated = dates.find((d) => /ESTIMATED_DELIVERY|ANTICIPATED_TENDER/.test(d.type || ''));
  const actual = dates.find((d) => d.type === 'ACTUAL_DELIVERY');

  return makeResult({
    carrier: id,
    trackingNumber,
    status,
    statusText,
    estimatedDelivery: estimated?.dateTime || null,
    deliveredAt: actual?.dateTime || null,
    events,
    service: result.serviceDetail?.description || result.serviceDetail?.shortDescription || '',
    trackingUrl: trackingUrl(trackingNumber),
  });
}
