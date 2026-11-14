import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const AUTH_TOKEN_FILE = path.resolve(DATA_DIR, '.dupond_auth_token');

let cachedToken: string | null = null;

export function getExpectedToken(): string {
  if (process.env.DUPOND_API_KEY && process.env.DUPOND_API_KEY.trim()) {
    return process.env.DUPOND_API_KEY.trim();
  }
  if (process.env.DUPOND_AUTH_TOKEN && process.env.DUPOND_AUTH_TOKEN.trim()) {
    return process.env.DUPOND_AUTH_TOKEN.trim();
  }

  if (cachedToken) return cachedToken;

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      cachedToken = fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
      if (cachedToken) return cachedToken;
    }
  } catch (err) {
    // Fall back to generated in-memory token
  }

  const generated = `dp_${crypto.randomBytes(24).toString('hex')}`;
  try {
    fs.writeFileSync(AUTH_TOKEN_FILE, generated, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // If unwritable, keep in-memory
  }
  cachedToken = generated;
  return generated;
}

export function validateAuthToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expected = getExpectedToken();
  const clean = token.replace(/^Bearer\s+/i, '').trim();
  if (clean.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(expected));
}

/**
 * Distinct operator approval credential. The API token grants execution; only
 * this token (when configured) may grant delivery approval, so the approval
 * recorded on the audit trail is backed by a capability the execution callers
 * do not hold.
 */
export function getApprovalToken(): string | null {
  const token = process.env.DUPOND_APPROVAL_TOKEN;
  return token && token.trim() ? token.trim() : null;
}

export function validateApprovalToken(token: string | undefined | null): boolean {
  const expected = getApprovalToken();
  if (!expected || !token) return false;
  const clean = token.replace(/^Bearer\s+/i, '').trim();
  if (clean.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(expected));
}

/**
 * Middleware for delivery-dispatch endpoints: requests that attempt to approve
 * a delivery (isApproved: true) must present the operator approval credential
 * via X-Dupond-Approval-Token. Fails closed when no approval credential is
 * configured; unapproved dispatches are unaffected.
 */
export function requireApprovalCredential(req: Request, res: Response, next: NextFunction): void {
  const body = (req.body || {}) as { isApproved?: unknown };
  if (body.isApproved !== true) return next();

  if (!getApprovalToken()) {
    res.status(503).json({
      error: 'Approval credential not configured: set DUPOND_APPROVAL_TOKEN to enable operator approval via the API.',
      code: 'APPROVAL_CREDENTIAL_UNCONFIGURED',
    });
    return;
  }

  const header = req.header('X-Dupond-Approval-Token') || req.header('Authorization');
  if (!header || !validateApprovalToken(header)) {
    res.status(403).json({
      error: 'Forbidden: approving a delivery requires the operator approval credential via X-Dupond-Approval-Token.',
      code: 'APPROVAL_CREDENTIAL_REQUIRED',
    });
    return;
  }

  next();
}

/**
 * Authentication middleware for mutating and executing endpoints.
 * Requires Authorization: Bearer <token> or X-Dupond-Token: <token>.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Static assets and public health check do not require authentication
  if (!req.path.startsWith('/api') || req.path === '/api/health') {
    return next();
  }

  // During automated unit tests where server is not booted with auth, allow opt-out with header or flag
  if (process.env.DUPOND_DISABLE_AUTH === 'true') {
    return next();
  }

  const header = req.header('Authorization') || req.header('X-Dupond-Token');
  if (!header || !validateAuthToken(header)) {
    res.status(401).json({
      error: 'Unauthorized: Valid authentication token required for API access.',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  next();
}
