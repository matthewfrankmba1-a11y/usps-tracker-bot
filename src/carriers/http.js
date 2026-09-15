import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class CarrierError extends Error {
  constructor(message, { status = null, retryable = false, carrier = null } = {}) {
    super(message);
    this.name = 'CarrierError';
    this.status = status;
    this.retryable = retryable;
    this.carrier = carrier;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * fetch() with a timeout, bounded retries and JSON parsing.
 * Retries on network errors and on the transient status codes above.
 */
export async function requestJson(url, options = {}, { carrier = null, retries = config.http.retries } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoffMs = Math.min(8_000, 500 * 2 ** (attempt - 1));
      await delay(backoffMs);
      logger.debug('retrying carrier request', { carrier, url, attempt });
    }

    let response;
    try {
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(config.http.timeoutMs),
      });
    } catch (err) {
      lastError = new CarrierError(`network error calling ${url}: ${err.message}`, {
        retryable: true,
        carrier,
      });
      continue;
    }

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (response.ok) return body;

    const retryable = RETRYABLE_STATUS.has(response.status);
    lastError = new CarrierError(
      `${carrier ?? 'carrier'} responded ${response.status}: ${summarise(body, text)}`,
      { status: response.status, retryable, carrier },
    );
    if (!retryable) break;
  }

  throw lastError;
}

function summarise(body, text) {
  const candidate =
    body?.error?.message ||
    body?.error_description ||
    body?.errors?.[0]?.message ||
    body?.response?.errors?.[0]?.message ||
    body?.message;
  if (candidate) return String(candidate).slice(0, 300);
  return (text || '').replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Caches an OAuth client-credentials token until shortly before it expires.
 * Concurrent callers share one in-flight refresh.
 */
export function createTokenCache(fetchToken, { skewSeconds = 60 } = {}) {
  let token = null;
  let expiresAt = 0;
  let inFlight = null;

  return async function getToken() {
    if (token && Date.now() < expiresAt) return token;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const result = await fetchToken();
        token = result.accessToken;
        const ttl = Math.max(30, Number(result.expiresIn) || 3600);
        expiresAt = Date.now() + (ttl - skewSeconds) * 1000;
        return token;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };
}
