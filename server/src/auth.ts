import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from './env.js';

/**
 * Authentication helpers: password hashing, JWT sign/verify, and an Express
 * middleware that guards protected routes.
 *
 * Login-only: there is no public signup. Accounts are created out-of-band by the
 * seed script (`npm run seed`). The client logs in and receives a JWT, which it
 * sends on every subsequent request as `Authorization: Bearer <token>` (or, for
 * the SSE stream which cannot set headers, as `?access_token=<token>`).
 */

const BCRYPT_ROUNDS = 10;

export interface TokenPayload {
  sub: string; // user _id (lowercased username)
  username: string;
  name?: string | null;
}

/** Hash a plaintext password for storage. */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** Compare a plaintext password against a stored bcrypt hash. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Sign a login token for a user. */
export function signToken(payload: TokenPayload): string {
  // `expiresIn` accepts a string like "7d"; cast keeps TS happy across versions.
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/** Verify a token and return its payload, or null if invalid/expired. */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;
    const { sub, username, name } = decoded as jwt.JwtPayload & Partial<TokenPayload>;
    if (!sub || !username) return null;
    return { sub, username, name: name ?? null };
  } catch {
    return null;
  }
}

/** Pull a bearer token from the Authorization header or the access_token query. */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  // EventSource (SSE) cannot send headers, so allow a query-string token there.
  const q = req.query.access_token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

// Augment Express's Request so handlers can read `req.user`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

/** Express middleware: require a valid login token, else 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please log in.' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    return;
  }
  req.user = payload;
  next();
}
