import http from 'node:http';
import { logger } from './logger.js';

/**
 * Minimal health endpoint. Uptime monitors (UptimeRobot, Fly checks, Railway,
 * Kubernetes probes) hit /healthz to confirm the bot is still alive, which is
 * also what keeps free-tier web hosts from idling the process.
 */
export function startHealthServer({ port, host = process.env.HOST || '::', client, store, poller }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz' || url.pathname === '/') {
      const snapshot = poller.snapshot();
      const ready = Boolean(client.isReady?.() && client.ws.status === 0);
      const body = {
        status: ready ? 'ok' : 'starting',
        uptimeSeconds: Math.round(process.uptime()),
        discord: {
          ready,
          wsPing: Math.round(client.ws.ping),
          guilds: client.guilds?.cache?.size ?? 0,
        },
        poller: snapshot,
        store: store.stats(),
      };
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  // Fly (and any IPv6-only private network) health-checks the machine over its
  // private IPv6 address, so bind dual-stack and fall back to IPv4 on hosts
  // that have no IPv6 at all.
  server.on('error', (err) => {
    if (host === '::' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(err.code)) {
      logger.warn('IPv6 unavailable, binding health server to 0.0.0.0', { code: err.code });
      host = '0.0.0.0';
      server.listen(port, host);
      return;
    }
    logger.error('health server error', { error: err.message, code: err.code });
  });
  server.listen(port, host, () => logger.info('health server listening', { port, host }));
  return server;
}
