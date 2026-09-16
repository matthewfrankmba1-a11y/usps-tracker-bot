import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { assertRuntimeConfig, config } from './config.js';
import { CARRIER_IDS, carrierTransport, getCarrier } from './carriers/index.js';
import { STATUS_LABEL } from './carriers/normalize.js';
import { errorMeta, logger } from './logger.js';
import { openStore } from './store.js';
import { Poller } from './poller.js';
import { startHealthServer } from './health.js';
import { handleAutocomplete, handleCommand } from './discord/commands.js';
import { registerCommands } from './discord/register.js';
import { trackingEmbed } from './discord/embeds.js';

// Discord error codes that mean "this destination is gone for good".
const DEAD_CHANNEL_CODES = new Set([10003 /* Unknown Channel */, 50001 /* Missing Access */, 50013 /* Missing Permissions */]);

async function main() {
  assertRuntimeConfig();

  const store = await openStore(config.storage.file);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  const poller = new Poller({
    store,
    config,
    notify: (payload) => deliver(payload, { client, store }),
  });

  client.once(Events.ClientReady, async (ready) => {
    logger.info('discord connected', {
      user: ready.user.tag,
      guilds: ready.guilds.cache.size,
      // e.g. { usps: 'easypost', ups: 'easypost', fedex: null }
      carriers: Object.fromEntries(CARRIER_IDS.map((id) => [id, carrierTransport(id)])),
    });
    ready.user.setPresence({
      status: 'online',
      activities: [{ name: 'for package updates', type: ActivityType.Watching }],
    });

    if (process.env.SKIP_COMMAND_REGISTRATION !== '1') {
      try {
        await registerCommands();
      } catch (err) {
        logger.error('command registration failed', errorMeta(err));
      }
    }
    poller.start({ immediate: true });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) return await handleAutocomplete(interaction, { store, poller, client });
      if (!interaction.isChatInputCommand()) return undefined;
      if (interaction.commandName !== 'track') return undefined;
      return await handleCommand(interaction, { store, poller, client });
    } catch (err) {
      logger.error('interaction handler failed', {
        command: interaction.commandName,
        ...errorMeta(err),
      });
      const message = { content: '⚠️ Something went wrong handling that command.', flags: MessageFlags.Ephemeral };
      if (interaction.isRepliable()) {
        return interaction.deferred || interaction.replied
          ? interaction.editReply(message).catch(() => {})
          : interaction.reply(message).catch(() => {});
      }
      return undefined;
    }
  });

  client.on(Events.Error, (err) => logger.error('discord client error', errorMeta(err)));
  client.on(Events.ShardDisconnect, (event, id) =>
    logger.warn('shard disconnected', { shard: id, code: event?.code }),
  );
  client.on(Events.ShardReconnecting, (id) => logger.warn('shard reconnecting', { shard: id }));
  client.on(Events.ShardResume, (id) => logger.info('shard resumed', { shard: id }));

  const healthServer = config.health.enabled
    ? startHealthServer({ port: config.health.port, client, store, poller })
    : null;

  try {
    await client.login(config.discord.token);
  } catch (err) {
    throw new Error(`Discord login failed — check DISCORD_TOKEN (${err.message || err.name})`, { cause: err });
  }

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    poller.stop();
    healthServer?.close();
    await store.save().catch(() => {});
    await client.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Never let a stray rejection kill a bot that is supposed to stay online.
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', errorMeta(reason)));
  process.on('uncaughtException', (err) => logger.error('uncaught exception', errorMeta(err)));
}

/**
 * Fan a poller event out to every subscriber, one message per channel so a
 * package watched by three people in one channel posts a single embed.
 */
async function deliver({ key, result, previousStatus, kind, error, failureCount }, { client, store }) {
  const subscribers = store.subscribersOf(key);
  if (!subscribers.length) return;

  const byChannel = new Map();
  for (const sub of subscribers) {
    const group = byChannel.get(sub.channelId) ?? [];
    group.push(sub);
    byChannel.set(sub.channelId, group);
  }

  for (const [channelId, subs] of byChannel) {
    const mentions = [...new Set(subs.map((s) => `<@${s.userId}>`))].join(' ');
    const label = subs.find((s) => s.label)?.label || '';

    const payload =
      kind === 'error'
        ? {
            content:
              `${mentions} ⚠️ I have failed to refresh \`${key.split(':')[1]}\` ${failureCount} times in a row.\n` +
              `Last error: ${String(error).slice(0, 300)}`,
          }
        : {
            content: `${mentions} ${headline(result, previousStatus)}`,
            embeds: [trackingEmbed(result, { label, previousStatus })],
          };

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) continue;
      await channel.send(payload);
    } catch (err) {
      if (DEAD_CHANNEL_CODES.has(err.code)) {
        logger.warn('dropping subscriptions for unreachable channel', { channelId, code: err.code });
        for (const sub of subs) {
          await store.removeSubscription(key, { channelId, userId: sub.userId });
        }
        continue;
      }
      logger.error('failed to send update', { channelId, ...errorMeta(err) });
    }
  }
}

function headline(result, previousStatus) {
  const carrierLabel = safeCarrierLabel(result.carrier);
  if (result.status === 'DELIVERED') return `📬 Your ${carrierLabel} package was **delivered**.`;
  if (result.status === 'OUT_FOR_DELIVERY') return `🚚 Your ${carrierLabel} package is **out for delivery**.`;
  if (result.status === 'EXCEPTION') return `⚠️ Your ${carrierLabel} package hit a **delivery exception**.`;
  if (result.status === 'RETURNED') return `↩️ Your ${carrierLabel} package is being **returned to sender**.`;
  if (result.status === 'AVAILABLE_FOR_PICKUP') return `🏤 Your ${carrierLabel} package is **ready for pickup**.`;
  if (previousStatus && previousStatus !== result.status) {
    return `📦 ${carrierLabel} update: **${STATUS_LABEL[result.status] ?? result.status}**.`;
  }
  return `📦 New ${carrierLabel} scan.`;
}

function safeCarrierLabel(carrierId) {
  try {
    return getCarrier(carrierId).label;
  } catch {
    return String(carrierId).toUpperCase();
  }
}

main().catch((err) => {
  logger.error('fatal startup error', errorMeta(err));
  process.exit(1);
});
