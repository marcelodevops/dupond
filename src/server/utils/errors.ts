import { EgressBlockedError } from '../egress';

/**
 * Error whose message is intentionally operator-facing (e.g. quality-gate
 * rejections, lifecycle guards, path-boundary violations). These messages are
 * part of the operator contract and are safe to return in API responses.
 * Any other error is treated as an internal failure and never forwarded.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function toClientMessage(error: unknown, fallback: string): string {
  if (error instanceof DomainError) return error.message;
  if (error instanceof EgressBlockedError) return error.message;
  console.error('Internal error (not exposed to client):', error);
  return fallback;
}
