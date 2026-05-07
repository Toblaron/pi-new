const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function resolveLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVELS) return raw as Level;
  return "info";
}

function emit(level: Level, msg: string, data?: unknown): void {
  const minLevel = LEVELS[resolveLevel()];
  if (LEVELS[level] < minLevel) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;

  if (data !== undefined) {
    const dataStr = typeof data === "object" && data !== null
      ? JSON.stringify(data)
      : String(data);
    const line = `${prefix} ${msg} ${dataStr}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } else {
    const line = `${prefix} ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

const log = {
  info(msg: string, data?: unknown): void { emit("info", msg, data); },
  warn(msg: string, data?: unknown): void { emit("warn", msg, data); },
  error(msg: string, data?: unknown): void { emit("error", msg, data); },
  debug(msg: string, data?: unknown): void { emit("debug", msg, data); },
};

export default log;
