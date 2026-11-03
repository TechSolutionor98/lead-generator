import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { users } from '../mongo.js';
import { DbNotConfiguredError } from '../mongo.js';
import { requireAuth, signToken, verifyPassword } from '../auth.js';

export const authRouter = Router();

/** Same async wrapper used elsewhere: turn rejections into clean JSON. */
function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof DbNotConfiguredError) {
        if (!res.headersSent) res.status(503).json({ error: err.message });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[auth]', err);
      if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
    });
  };
}

const loginSchema = z.object({
  username: z.string().min(1, 'username is required').trim(),
  password: z.string().min(1, 'password is required'),
});

/** POST /api/auth/login — exchange username + password for a JWT. */
authRouter.post(
  '/auth/login',
  wrap(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
      return;
    }
    const { username, password } = parsed.data;

    const col = await users();
    const user = await col.findOne({ _id: username.toLowerCase() });

    // Always run a comparison-shaped path and return the same message so we don't
    // leak whether a username exists.
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    await col.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date().toISOString() } });

    const token = signToken({ sub: user._id, username: user.username, name: user.name ?? null });
    res.json({ token, user: { username: user.username, name: user.name ?? null } });
  }),
);

/** GET /api/auth/me — who am I (validates the token). */
authRouter.get(
  '/auth/me',
  requireAuth,
  (req: Request, res: Response) => {
    res.json({ user: { username: req.user!.username, name: req.user!.name ?? null } });
  },
);
