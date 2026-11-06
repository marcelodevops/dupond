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
 * Authentication middleware for mutating and executing endpoints.
 * Requires Authorization: Bearer <token> or X-Dupond-Token: <token>.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Allow read-only public endpoints (health check, static client bundle)
  if (req.method === 'GET' && !req.path.startsWith('/api/orchestrate/state') && !req.path.startsWith('/api/admin')) {
    return next();
  }

  // During automated unit tests where server is not booted with auth, allow opt-out with header or flag
  if (process.env.DUPOND_DISABLE_AUTH === 'true') {
    return next();
  }

  const header = req.header('Authorization') || req.header('X-Dupond-Token');
  if (!header || !validateAuthToken(header)) {
    res.status(401).json({
      error: 'Unauthorized: Valid authentication token required for mutation and execution endpoints.',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  next();
}
