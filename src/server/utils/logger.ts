export interface LogContext {
  taskId?: string;
  taskKey?: string;
  runId?: string;
  attemptId?: string;
  actor?: string;
  [key: string]: any;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function redactSecrets(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    return data
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/([a-zA-Z0-9_-]*(?:token|secret|key|password)[a-zA-Z0-9_-]*=)[^\s&]+/gi, '$1[REDACTED]')
      .replace(/(hooks\.slack\.com\/services\/)[A-Za-z0-9/]+/gi, '$1[REDACTED_WEBHOOK]');
  }
  if (Array.isArray(data)) {
    return data.map(redactSecrets);
  }
  if (typeof data === 'object') {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (/token|secret|key|password|credential/i.test(k)) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = redactSecrets(v);
      }
    }
    return clean;
  }
  return data;
}

export class StructuredLogger {
  private baseContext: LogContext;

  constructor(baseContext: LogContext = {}) {
    this.baseContext = baseContext;
  }

  public child(context: LogContext): StructuredLogger {
    return new StructuredLogger({ ...this.baseContext, ...context });
  }

  private log(level: LogLevel, message: string, extra?: Record<string, any>): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactSecrets(message),
      ...redactSecrets({ ...this.baseContext, ...(extra || {}) }),
    };

    const serialized = JSON.stringify(entry);
    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  public info(message: string, extra?: Record<string, any>): void {
    this.log('info', message, extra);
  }

  public warn(message: string, extra?: Record<string, any>): void {
    this.log('warn', message, extra);
  }

  public error(message: string, extra?: Record<string, any>): void {
    this.log('error', message, extra);
  }

  public debug(message: string, extra?: Record<string, any>): void {
    this.log('debug', message, extra);
  }
}

export const logger = new StructuredLogger();
