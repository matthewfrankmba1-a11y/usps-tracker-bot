import { EmbedBuilder } from 'discord.js';
import { getCarrier } from '../carriers/index.js';
import { STATUS_COLOR, STATUS_EMOJI, STATUS_LABEL } from '../carriers/normalize.js';

/** Discord renders <t:unix:R> as a live "2 hours ago" that respects each viewer's locale. */
export function timeTag(iso, style = 'f') {
  if (!iso) return 'unknown';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export function statusBadge(status) {
  return `${STATUS_EMOJI[status] ?? STATUS_EMOJI.UNKNOWN} ${STATUS_LABEL[status] ?? status}`;
}

function carrierLabel(carrierId) {
  try {
    return getCarrier(carrierId).label;
  } catch {
    return String(carrierId).toUpperCase();
  }
}

/**
 * The embed posted when a package's status changes (and on first lookup).
 * `previousStatus` is shown only when it actually differs.
 */
export function trackingEmbed(result, { label = '', previousStatus = null, title = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(STATUS_COLOR[result.status] ?? STATUS_COLOR.UNKNOWN)
    .setTitle(title || `${statusBadge(result.status)} — ${label || result.trackingNumber}`)
    .setURL(result.trackingUrl || null)
    .setDescription(result.statusText || STATUS_LABEL[result.status])
    .addFields(
      { name: 'Carrier', value: carrierLabel(result.carrier), inline: true },
      { name: 'Tracking #', value: `\`${result.trackingNumber}\``, inline: true },
    )
    .setFooter({ text: 'Checked' })
    .setTimestamp(new Date(result.fetchedAt));

  if (result.service) {
    embed.addFields({ name: 'Service', value: result.service, inline: true });
  }
  if (previousStatus && previousStatus !== result.status) {
    embed.addFields({
      name: 'Changed',
      value: `${STATUS_LABEL[previousStatus] ?? previousStatus} → **${STATUS_LABEL[result.status] ?? result.status}**`,
      inline: false,
    });
  }
  if (result.lastEvent) {
    const parts = [result.lastEvent.description || '—'];
    if (result.lastEvent.location) parts.push(`📍 ${result.lastEvent.location}`);
    if (result.lastEvent.timestamp) parts.push(`🕒 ${timeTag(result.lastEvent.timestamp)}`);
    embed.addFields({ name: 'Latest scan', value: parts.join('\n') });
  }
  if (result.status === 'DELIVERED' && result.deliveredAt) {
    embed.addFields({ name: 'Delivered', value: timeTag(result.deliveredAt), inline: true });
  } else if (result.estimatedDelivery) {
    embed.addFields({ name: 'Estimated delivery', value: timeTag(result.estimatedDelivery, 'D'), inline: true });
  }

  const history = result.events.slice(1, 4);
  if (history.length) {
    embed.addFields({
      name: 'Earlier',
      value: history
        .map((e) => `• ${e.description}${e.location ? ` — ${e.location}` : ''} (${timeTag(e.timestamp, 'R')})`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  return embed;
}

/** One embed summarising every package tracked in a channel or by a user. */
export function listEmbed(rows, { scopeLabel }) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📦 Tracked packages — ${scopeLabel}`)
    .setTimestamp(new Date());

  if (!rows.length) {
    embed.setDescription('Nothing tracked yet. Add one with `/track add`.');
    return embed;
  }

  const lines = rows.slice(0, 25).map((row) => {
    const name = row.subscription.label || row.trackingNumber;
    const status = statusBadge(row.lastStatus || 'UNKNOWN');
    const checked = row.lastCheckedAt ? timeTag(row.lastCheckedAt, 'R') : 'not yet checked';
    return `**${name}** — ${status}\n\`${row.trackingNumber}\` · ${carrierLabel(row.carrier)} · checked ${checked}`;
  });

  embed.setDescription(lines.join('\n\n').slice(0, 4096));
  if (rows.length > 25) embed.setFooter({ text: `+${rows.length - 25} more` });
  return embed;
}

/** Health/diagnostics embed for /track status. */
export function statusEmbed({ stats, carrierStatus, intervalMinutes, nextPollAt, lastPollAt, startedAt }) {
  const carrierLines = Object.entries(carrierStatus)
    .map(([id, ok]) => `${ok ? '🟢' : '⚪'} ${carrierLabel(id)} — ${ok ? 'configured' : 'no credentials'}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🤖 Tracker status')
    .addFields(
      { name: 'Online since', value: timeTag(startedAt, 'R'), inline: true },
      { name: 'Poll interval', value: `${intervalMinutes} min`, inline: true },
      { name: 'Tracking', value: `${stats.shipments} package(s) · ${stats.subscriptions} subscription(s)`, inline: false },
      { name: 'Last poll', value: lastPollAt ? timeTag(lastPollAt, 'R') : 'not yet', inline: true },
      { name: 'Next poll', value: nextPollAt ? timeTag(nextPollAt, 'R') : 'unscheduled', inline: true },
      { name: 'Carriers', value: carrierLines || 'none' },
    )
    .setTimestamp(new Date());
}
