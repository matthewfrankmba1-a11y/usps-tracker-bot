import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Push slash command definitions to Discord.
 * Guild-scoped registration (DISCORD_GUILD_ID) shows up instantly and is the
 * right choice while developing; global registration can take up to an hour.
 */
export async function registerCommands({
  token = config.discord.token,
  clientId = config.discord.clientId,
  guildId = config.discord.guildId,
} = {}) {
  if (!token || !clientId) throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required to register commands');

  const rest = new REST({ version: '10' }).setToken(token);
  const body = commands.map((command) => command.toJSON());
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  const result = await rest.put(route, { body });
  logger.info('slash commands registered', {
    scope: guildId ? `guild:${guildId}` : 'global',
    count: Array.isArray(result) ? result.length : body.length,
  });
  return result;
}

// `npm run register` runs this file directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  registerCommands()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('command registration failed', { error: err.message });
      process.exit(1);
    });
}
