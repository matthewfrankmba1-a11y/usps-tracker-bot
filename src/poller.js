import { setTimeout as delay } from 'node:timers/promises';
import { getCarrier, shipmentKey } from './carriers/index.js';
import { STATUS, fingerprint } from './carriers/normalize.js';
import { errorMeta, logger } from './logger.js';

const FAILURE_ALERT_THRESHOLD = 4;

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Polls every tracked shipment on a fixed interval and reports only real
 * changes. One timer, no overlapping cycles: the next run is scheduled after
 * the previous one finishes.
 */
export class Poller {
  #timer = null;
  #running = false;
  #stopped = false;

  constructor({ store, notify, config, now = () => new Date(), resolveCarrier = getCarrier }) {
    this.store = store;
    this.notify = notify;
    this.config = config;
    this.now = now;
    // Injectable so tests can drive the cycle without hitting a carrier API.
    this.resolveCarrier = resolveCarrier;
    this.startedAt = now().toISOString();
    this.lastPollAt = null;
    this.nextPollAt = null;
    this.lastCycle = null;
  }

  start({ immediate = true } = {}) {
    this.#stopped = false;
    if (immediate) {
      this.#schedule(5_000);
    } else {
      this.#schedule(this.#intervalMs());
    }
    logger.info('poller started', { intervalMinutes: this.config.poll.intervalMinutes });
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.nextPollAt = null;
  }

  #intervalMs() {
    const base = this.config.poll.intervalMinutes * 60_000;
    const jitter = Math.floor(Math.random() * this.config.poll.jitterSeconds * 1000);
    return base + jitter;
  }

  #schedule(ms) {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.nextPollAt = new Date(Date.now() + ms).toISOString();
    this.#timer = setTimeout(() => {
      this.runCycle()
        .catch((err) => logger.error('poll cycle failed', errorMeta(err)))
        .finally(() => this.#schedule(this.#intervalMs()));
    }, ms);
    this.#timer.unref?.();
  }

  /** One pass over every tracked shipment. Safe to call manually. */
  async runCycle() {
    if (this.#running) {
      logger.warn('poll cycle still running, skipping this tick');
      return this.lastCycle;
    }
    this.#running = true;
    const startedAt = Date.now();
    const summary = { checked: 0, updates: 0, failures: 0, pruned: 0, skipped: 0 };

    try {
      const shipments = this.store.shipments();
      const due = [];
      for (const shipment of shipments) {
        const prune = this.#pruneReason(shipment);
        if (prune) {
          await this.store.deleteShipment(shipment.key);
          summary.pruned += 1;
          logger.info('pruned shipment', { key: shipment.key, reason: prune });
          continue;
        }
        due.push(shipment);
      }

      await pool(due, this.config.poll.concurrency, async (shipment) => {
        const outcome = await this.pollShipment(shipment.key);
        summary.checked += 1;
        if (outcome.skipped) summary.skipped += 1;
        if (outcome.changed) summary.updates += 1;
        if (outcome.failed) summary.failures += 1;
        // Gentle spacing so a burst of packages does not trip carrier rate limits.
        await delay(250);
      });

      this.lastPollAt = new Date().toISOString();
      this.lastCycle = { ...summary, durationMs: Date.now() - startedAt, at: this.lastPollAt };
      logger.info('poll cycle complete', this.lastCycle);
      return this.lastCycle;
    } finally {
      this.#running = false;
    }
  }

  /** Fetch one shipment, diff it against what we last saw, notify on change. */
  async pollShipment(key, { force = false } = {}) {
    const shipment = this.store.getShipment(key);
    if (!shipment) return { skipped: true, reason: 'missing' };

    let carrier;
    try {
      carrier = this.resolveCarrier(shipment.carrier);
    } catch {
      return { skipped: true, reason: 'unknown-carrier' };
    }

    if (!carrier.isConfigured()) {
      logger.debug('carrier not configured, skipping', { key, carrier: shipment.carrier });
      return { skipped: true, reason: 'unconfigured' };
    }

    try {
      const result = await carrier.track(shipment.trackingNumber);
      const digest = fingerprint(result);
      const previousStatus = shipment.lastStatus;
      const changed = digest !== shipment.lastFingerprint;
      const first = !shipment.lastFingerprint;

      await this.store.updateShipment(key, {
        lastCheckedAt: new Date().toISOString(),
        lastFingerprint: digest,
        lastStatus: result.status,
        lastSummary: result.statusText,
        lastEvent: result.lastEvent,
        estimatedDelivery: result.estimatedDelivery,
        deliveredAt: result.deliveredAt,
        failureCount: 0,
        lastError: null,
      });

      if ((changed && !first) || force) {
        await this.#emit({ key, result, previousStatus, kind: 'update' });
      } else if (changed && first) {
        // First successful lookup after /track add: record it without pinging
        // the channel a second time (the command already replied with it).
        logger.debug('first fingerprint recorded', { key, status: result.status });
      }

      return { changed: changed && !first, failed: false, result };
    } catch (err) {
      const failureCount = (shipment.failureCount || 0) + 1;
      await this.store.updateShipment(key, {
        lastCheckedAt: new Date().toISOString(),
        failureCount,
        lastError: err.message,
      });
      logger.warn('tracking lookup failed', { key, failureCount, ...errorMeta(err) });

      if (failureCount === FAILURE_ALERT_THRESHOLD) {
        await this.#emit({ key, kind: 'error', error: err.message, failureCount });
      }
      return { changed: false, failed: true, error: err };
    }
  }

  async #emit(payload) {
    try {
      await this.notify(payload);
    } catch (err) {
      logger.error('failed to deliver notification', { key: payload.key, ...errorMeta(err) });
    }
  }

  /** Retention rules: stop paying for lookups on packages that are done. */
  #pruneReason(shipment) {
    const now = this.now().getTime();
    const hours = (iso) => (iso ? (now - new Date(iso).getTime()) / 3_600_000 : 0);

    if (shipment.lastStatus === STATUS.DELIVERED) {
      const since = shipment.deliveredAt || shipment.lastCheckedAt;
      if (hours(since) >= this.config.poll.deliveredRetentionHours) return 'delivered';
    }
    if (!shipment.lastStatus || shipment.lastStatus === STATUS.UNKNOWN) {
      if (hours(shipment.createdAt) >= this.config.poll.unknownRetentionHours) return 'stale-unknown';
    }
    return null;
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.nextPollAt,
      lastCycle: this.lastCycle,
      running: this.#running,
    };
  }
}

export { shipmentKey };
