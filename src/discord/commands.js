import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { CARRIER_IDS, carrierTransport, getCarrier, resolveShipment, shipmentKey } from '../carriers/index.js';
import { fingerprint } from '../carriers/normalize.js';

import { errorMeta, logger } from '../logger.js';
import { listEmbed, statusEmbed, trackingEmbed } from './embeds.js';

export const trackCommand = new SlashCommandBuilder()
  .setName('track')
  .setDescription('Track USPS, UPS and FedEx packages in this channel')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Start tracking a package; updates are posted here')
      .addStringOption((opt) =>
        opt
          .setName('tracking_number')
          .setDescription('The carrier tracking number')
          .setRequired(true)
          .setMinLength(8)
          .setMaxLength(40),
      )
      .addStringOption((opt) =>
        opt.setName('label').setDescription('A friendly name, e.g. "keyboard from Amazon"').setMaxLength(80),
      )
      .addStringOption((opt) =>
        opt
          .setName('carrier')
          .setDescription('Override carrier auto-detection')
          .addChoices(
            { name: 'USPS', value: 'usps' },
            { name: 'UPS', value: 'ups' },
            { name: 'FedEx', value: 'fedex' },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Stop tracking a package in this channel')
      .addStringOption((opt) =>
        opt
          .setName('tracking_number')
          .setDescription('Tracking number to stop watching')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('Show tracked packages')
      .addStringOption((opt) =>
        opt
          .setName('scope')
          .setDescription('This channel (default) or everything you track')
          .addChoices({ name: 'This channel', value: 'channel' }, { name: 'Mine everywhere', value: 'mine' }),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('check')
      .setDescription('Re-check a package right now instead of waiting for the next poll')
      .addStringOption((opt) =>
        opt
          .setName('tracking_number')
          .setDescription('Tracking number to refresh')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Bot health, poll schedule and carrier setup'));

export const commands = [trackCommand];

/** Router for chat-input interactions. */
export async function handleCommand(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'add':
      return handleAdd(interaction, ctx);
    case 'remove':
      return handleRemove(interaction, ctx);
    case 'list':
      return handleList(interaction, ctx);
    case 'check':
      return handleCheck(interaction, ctx);
    case 'status':
      return handleStatus(interaction, ctx);
    default:
      return interaction.reply({ content: `Unknown subcommand \`${sub}\`.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleAdd(interaction, { store, poller }) {
  const raw = interaction.options.getString('tracking_number', true);
  const label = interaction.options.getString('label') || '';
  const carrierOverride = interaction.options.getString('carrier');

  const resolved = resolveShipment(raw, carrierOverride);
  if (!resolved.ok) {
    return interaction.reply({ content: `❌ ${resolved.reason}`, flags: MessageFlags.Ephemeral });
  }

  const { carrier, trackingNumber } = resolved;
  const limit = poller.config.poll.maxPerUser;
  if (store.countForUser(interaction.user.id) >= limit) {
    return interaction.reply({
      content: `❌ You are already tracking ${limit} packages. Remove one with \`/track remove\` first.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  const { created, key } = await store.addSubscription({
    carrier,
    trackingNumber,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    guildId: interaction.guildId ?? null,
    label,
  });

  const carrierModule = getCarrier(carrier);
  if (!carrierModule.isConfigured()) {
    return interaction.editReply({
      content:
        `⚠️ Tracking **${label || trackingNumber}** (${carrierModule.label}) in this channel, but no ` +
        `tracking credentials are configured, so no updates can be fetched yet.\n` +
        `Set \`EASYPOST_API_KEY\` to cover every carrier with one key, or ` +
        `\`${carrier.toUpperCase()}_CLIENT_ID\` and \`${carrier.toUpperCase()}_CLIENT_SECRET\` to use ` +
        `${carrierModule.label} directly.`,
    });
  }

  try {
    const result = await carrierModule.track(trackingNumber);
    await store.updateShipment(key, {
      lastCheckedAt: new Date().toISOString(),
      lastFingerprint: fingerprint(result),
      lastStatus: result.status,
      lastSummary: result.statusText,
      lastEvent: result.lastEvent,
      estimatedDelivery: result.estimatedDelivery,
      deliveredAt: result.deliveredAt,
      failureCount: 0,
      lastError: null,
    });

    return interaction.editReply({
      content: created
        ? `✅ Now tracking in this channel — updates every ${poller.config.poll.intervalMinutes} minutes.`
        : 'ℹ️ Already tracked here; here is the current status.',
      embeds: [trackingEmbed(result, { label })],
    });
  } catch (err) {
    logger.warn('initial lookup failed', { carrier, trackingNumber, ...errorMeta(err) });
    return interaction.editReply({
      content:
        `✅ Tracking **${label || trackingNumber}** (${carrierModule.label}), but the first lookup failed: ` +
        `${err.message}\nCarriers often need a few hours before a new label is visible — I will keep checking.`,
    });
  }
}

async function handleRemove(interaction, { store }) {
  const raw = interaction.options.getString('tracking_number', true);
  const resolved = resolveShipment(raw);
  const candidates = resolved.ok
    ? [shipmentKey(resolved.carrier, resolved.trackingNumber)]
    : CARRIER_IDS.map((c) => shipmentKey(c, raw.toUpperCase().replace(/[\s-]/g, '')));

  for (const key of candidates) {
    const { removed } = await store.removeSubscription(key, {
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });
    if (removed) {
      return interaction.reply({ content: `🗑️ Stopped tracking \`${key.split(':')[1]}\` here.` });
    }
  }

  return interaction.reply({
    content: `❌ You are not tracking \`${raw}\` in this channel.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction, { store }) {
  const scope = interaction.options.getString('scope') || 'channel';
  const rows =
    scope === 'mine'
      ? store.list({ userId: interaction.user.id })
      : store.list({ channelId: interaction.channelId });

  return interaction.reply({
    embeds: [listEmbed(rows, { scopeLabel: scope === 'mine' ? 'yours' : '#this channel' })],
    flags: scope === 'mine' ? MessageFlags.Ephemeral : undefined,
  });
}

async function handleCheck(interaction, { store, poller }) {
  const raw = interaction.options.getString('tracking_number', true);
  const resolved = resolveShipment(raw);
  if (!resolved.ok) {
    return interaction.reply({ content: `❌ ${resolved.reason}`, flags: MessageFlags.Ephemeral });
  }
  const key = shipmentKey(resolved.carrier, resolved.trackingNumber);
  if (!store.getShipment(key)) {
    return interaction.reply({
      content: `❌ \`${resolved.trackingNumber}\` is not being tracked. Add it with \`/track add\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();
  const outcome = await poller.pollShipment(key);
  if (outcome.result) {
    const sub = store.subscribersOf(key).find((s) => s.userId === interaction.user.id);
    return interaction.editReply({ embeds: [trackingEmbed(outcome.result, { label: sub?.label || '' })] });
  }
  if (outcome.skipped) {
    return interaction.editReply(`⚠️ Could not check right now (${outcome.reason}).`);
  }
  return interaction.editReply(`⚠️ Lookup failed: ${outcome.error?.message ?? 'unknown error'}`);
}

async function handleStatus(interaction, { store, poller }) {
  const snapshot = poller.snapshot();
  const carrierStatus = Object.fromEntries(CARRIER_IDS.map((id) => [id, carrierTransport(id)]));

  return interaction.reply({
    embeds: [
      statusEmbed({
        stats: store.stats(),
        carrierStatus,
        intervalMinutes: poller.config.poll.intervalMinutes,
        nextPollAt: snapshot.nextPollAt,
        lastPollAt: snapshot.lastPollAt,
        startedAt: snapshot.startedAt,
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

/** Suggest the tracking numbers this user already watches in this channel. */
export async function handleAutocomplete(interaction, { store }) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'tracking_number') return interaction.respond([]);

  const query = String(focused.value || '').toUpperCase();
  const rows = store
    .list({ channelId: interaction.channelId, userId: interaction.user.id })
    .filter((row) => !query || row.trackingNumber.includes(query) || row.subscription.label?.toUpperCase().includes(query))
    .slice(0, 25)
    .map((row) => ({
      name: `${row.subscription.label ? `${row.subscription.label} — ` : ''}${row.trackingNumber}`.slice(0, 100),
      value: row.trackingNumber,
    }));

  return interaction.respond(rows);
}
