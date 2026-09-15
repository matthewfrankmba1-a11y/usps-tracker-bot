const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

function emit(level, message, meta) {
  if (LEVELS[level] > threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta && Object.keys(meta).length ? { ...meta } : {}),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta),
};

/** Turn an unknown thrown value into something safe to put in a log line. */
export function errorMeta(err) {
  if (err instanceof Error) {
    return {
      error: err.message || err.name || 'unknown error',
      ...(err.name && err.name !== 'Error' ? { name: err.name } : {}),
      ...(err.code !== undefined ? { code: err.code } : {}),
      ...(err.cause ? { cause: String(err.cause) } : {}),
    };
  }
  return { error: String(err) };
}
