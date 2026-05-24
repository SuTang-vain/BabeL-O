type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const LEVEL_WEIGHT: Record<Exclude<LogLevel, 'silent'>, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

function currentLevel(): LogLevel {
  const raw = (process.env.NEXUS_LOG_LEVEL ?? 'warn').toLowerCase()
  if (raw === 'silent' || raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
    return raw
  }
  return 'warn'
}

function shouldLog(level: Exclude<LogLevel, 'silent'>): boolean {
  const configured = currentLevel()
  if (configured === 'silent') return false
  return LEVEL_WEIGHT[level] <= LEVEL_WEIGHT[configured]
}

function serializeMeta(meta: unknown): unknown {
  if (meta instanceof Error) {
    return {
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    }
  }
  return meta
}

export const logger = {
  error(message: string, meta?: unknown): void {
    writeLog('error', message, meta)
  },
  warn(message: string, meta?: unknown): void {
    writeLog('warn', message, meta)
  },
  info(message: string, meta?: unknown): void {
    writeLog('info', message, meta)
  },
  debug(message: string, meta?: unknown): void {
    writeLog('debug', message, meta)
  },
}

function writeLog(level: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(meta === undefined ? {} : { meta: serializeMeta(meta) }),
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}
