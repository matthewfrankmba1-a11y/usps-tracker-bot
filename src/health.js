import http from 'node:http';
import { logger } from './logger.js';

/**
 * Minimal health endpoint. Uptime monitors (UptimeRobot, Fly checks, Railway,
 * Kubernetes probes) hit /healthz to confirm the bot is still alive, which is
 * also what keeps free-tier web hosts from idling the process.
 */
export function startHealthServer({ port, client, store, poller }) {
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

  server.listen(port, () => logger.info('health server listening', { port }));
  server.on('error', (err) => logger.error('health server error', { error: err.message }));
  return server;
}
