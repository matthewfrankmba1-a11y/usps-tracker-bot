import fs from 'node:fs/promises';
import path from 'node:path';
import { shipmentKey } from './carriers/index.js';
import { logger, errorMeta } from './logger.js';

const VERSION = 1;

/**
 * Tiny JSON-file store. Shipments are deduplicated by carrier + tracking
 * number so two people watching the same package cost one API call, while
 * subscriptions record who to notify and where.
 */
export class Store {
  #file;
  #state = { version: VERSION, shipments: {}, subscriptions: {} };
  #writing = null;
  #dirty = false;

  constructor(file) {
    this.#file = file;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      this.#state = {
        version: parsed.version ?? VERSION,
        shipments: parsed.shipments ?? {},
        subscriptions: parsed.subscriptions ?? {},
      };
      logger.info('store loaded', {
        file: this.#file,
        shipments: Object.keys(this.#state.shipments).length,
      });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await this.save();
      logger.info('store created', { file: this.#file });
    }
    return this;
  }

  /** Atomic write: temp file then rename, so a crash never truncates the store. */
  async save() {
    if (this.#writing) {
      this.#dirty = true;
      return this.#writing;
    }
    this.#writing = (async () => {
      try {
        await fs.mkdir(path.dirname(this.#file), { recursive: true });
        const tmp = `${this.#file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
        await fs.rename(tmp, this.#file);
      } finally {
        this.#writing = null;
      }
      if (this.#dirty) {
        this.#dirty = false;
        await this.save();
      }
    })();
    return this.#writing;
  }

  shipments() {
    return Object.values(this.#state.shipments);
  }

  getShipment(key) {
    return this.#state.shipments[key] ?? null;
  }

  subscribersOf(key) {
    return this.#state.subscriptions[key] ?? [];
  }

  countForUser(userId) {
    return Object.values(this.#state.subscriptions)
      .flat()
      .filter((sub) => sub.userId === userId).length;
  }

  /**
   * Add (or refresh) a subscription. Returns { created, shipment, subscription }
   * where created=false means this channel was already watching the package.
   */
  async addSubscription({ carrier, trackingNumber, channelId, userId, guildId = null, label = '' }) {
    const key = shipmentKey(carrier, trackingNumber);
    const now = new Date().toISOString();

    if (!this.#state.shipments[key]) {
      this.#state.shipments[key] = {
        key,
        carrier,
        trackingNumber,
        createdAt: now,
        lastCheckedAt: null,
        lastFingerprint: null,
        lastStatus: null,
        lastSummary: null,
        lastEvent: null,
        estimatedDelivery: null,
        deliveredAt: null,
        failureCount: 0,
        lastError: null,
      };
    }

    const subs = (this.#state.subscriptions[key] ??= []);
    const existing = subs.find((s) => s.channelId === channelId && s.userId === userId);
    if (existing) {
      if (label) existing.label = label;
      await this.save();
      return { created: false, key, shipment: this.#state.shipments[key], subscription: existing };
    }

    const subscription = { channelId, userId, guildId, label, createdAt: now };
    subs.push(subscription);
    await this.save();
    return { created: true, key, shipment: this.#state.shipments[key], subscription };
  }

  /**
   * Remove one user's subscription in one channel. The shipment itself is
   * dropped once nobody is watching it.
   */
  async removeSubscription(key, { channelId, userId }) {
    const subs = this.#state.subscriptions[key];
    if (!subs?.length) return { removed: false };

    const before = subs.length;
    this.#state.subscriptions[key] = subs.filter(
      (s) => !(s.userId === userId && (!channelId || s.channelId === channelId)),
    );
    const removed = this.#state.subscriptions[key].length < before;

    if (!this.#state.subscriptions[key].length) {
      delete this.#state.subscriptions[key];
      delete this.#state.shipments[key];
    }
    await this.save();
    return { removed };
  }

  /** Drop a shipment and every subscription to it (used by retention pruning). */
  async deleteShipment(key) {
    delete this.#state.shipments[key];
    delete this.#state.subscriptions[key];
    await this.save();
  }

  /** Subscriptions visible in a channel, or everything a user tracks anywhere. */
  list({ channelId = null, userId = null } = {}) {
    const rows = [];
    for (const [key, subs] of Object.entries(this.#state.subscriptions)) {
      for (const sub of subs) {
        if (channelId && sub.channelId !== channelId) continue;
        if (userId && sub.userId !== userId) continue;
        const shipment = this.#state.shipments[key];
        if (shipment) rows.push({ ...shipment, subscription: sub });
      }
    }
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async updateShipment(key, patch) {
    const shipment = this.#state.shipments[key];
    if (!shipment) return null;
    Object.assign(shipment, patch);
    await this.save();
    return shipment;
  }

  stats() {
    const shipments = this.shipments();
    const byCarrier = {};
    for (const shipment of shipments) {
      byCarrier[shipment.carrier] = (byCarrier[shipment.carrier] || 0) + 1;
    }
    return {
      shipments: shipments.length,
      subscriptions: Object.values(this.#state.subscriptions).flat().length,
      byCarrier,
    };
  }
}

export async function openStore(file) {
  const store = new Store(file);
  try {
    return await store.load();
  } catch (err) {
    logger.error('failed to load store', { file, ...errorMeta(err) });
    throw err;
  }
}
