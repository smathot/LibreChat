import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { runAsSystem } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type { SubscriptionStateUser } from './state';
import { isSubscriptionActive } from './state';

/** MongoDB ObjectId as stored in the users collection. */
const USER_ID_PATTERN = /^[a-f\d]{24}$/i;
const IDENTIFIER_FIELDS = ['email', 'userId'] as const;

/**
 * Hand-written rather than `z.infer<...>`: `--isolatedDeclarations` requires exported
 * declarations to be typable without inference, and a Zod chain is exactly the kind of
 * deeply-inferred type that rule rejects (TS9010). Annotating the schema below with
 * this type also rules out `z.infer<typeof schema>`, which would be circular.
 * Keep this in sync with the object shape; the schema stays the runtime source of truth.
 */
export interface SubscriptionSyncBody {
  /** Stored lowercase; `findUser` normalizes the lookup criteria. */
  email?: string;
  userId?: string;
  /** Instant the subscription runs until (ISO 8601, UTC `Z`). `null` deactivates. */
  expiresAt: string | null;
  /** Informational provider status, e.g. 'active' or 'past_due'. */
  status?: string;
  /** Informational plan name. */
  plan?: string;
}

/** Annotated (widened to `z.ZodType`) so the declaration can be emitted under `--isolatedDeclarations`. */
export const subscriptionSyncBodySchema: z.ZodType<SubscriptionSyncBody> = z
  .object({
    /** Stored lowercase; `findUser` normalizes the lookup criteria. */
    email: z.string().trim().min(3).max(320).email().optional(),
    userId: z.string().trim().regex(USER_ID_PATTERN).optional(),
    /** Instant the subscription runs until (ISO 8601, UTC `Z`). `null` deactivates. */
    expiresAt: z.string().datetime().nullable(),
    /** Informational provider status, e.g. 'active' or 'past_due'. */
    status: z.string().trim().min(1).max(64).optional(),
    /** Informational plan name. */
    plan: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((body) => IDENTIFIER_FIELDS.filter((field) => body[field] != null).length === 1, {
    message: 'Exactly one of email or userId must be provided',
  });

type SyncUser = { _id: { toString(): string } | string };

export interface SubscriptionSyncDeps {
  findUser: (criteria: { email: string }) => Promise<SyncUser | null>;
  getUserById: (userId: string) => Promise<SyncUser | null>;
  updateUser: (
    userId: string,
    updateData: Record<string, unknown>,
    expectedState?: Record<string, unknown>,
    options?: { preserveExpiresAt?: boolean },
  ) => Promise<SubscriptionStateUser | null>;
}

export type SubscriptionSyncResult =
  | { ok: true; value: { userId: string; active: boolean; expiresAt: string | null } }
  | { ok: false; error: { code: 'invalid_body' | 'user_not_found'; status: 400 | 404 } };

const resolveUserId = (user: SyncUser | null): string | null => {
  const id = user?._id;
  if (id == null) {
    return null;
  }
  return typeof id === 'string' ? id : id.toString();
};

/**
 * Writes one user's externally-owned subscription state.
 *
 * `expiresAt` is the source of truth: the account suspends itself once the instant
 * passes, even if no further sync arrives. `status` and `plan` are informational and
 * are replaced wholesale by each sync that names them. The write passes
 * `preserveExpiresAt` because the user-level `expiresAt` is a different field — the
 * pending-account TTL — and the data-schemas `updateUser` would otherwise clear it.
 * `updateUser` also evicts the auth user document cache for the user.
 */
export async function syncSubscription(
  deps: SubscriptionSyncDeps,
  body: unknown,
): Promise<SubscriptionSyncResult> {
  const parsed = subscriptionSyncBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_body', status: 400 } };
  }
  const { email, userId, expiresAt, status, plan } = parsed.data;

  const user =
    email != null
      ? await runAsSystem(() => deps.findUser({ email }))
      : await runAsSystem(() => deps.getUserById(userId as string));
  const resolvedId = resolveUserId(user);
  if (resolvedId == null) {
    return { ok: false, error: { code: 'user_not_found', status: 404 } };
  }

  const expiresAtDate = expiresAt == null ? null : new Date(expiresAt);
  const subscription: Record<string, unknown> = {
    expiresAt: expiresAtDate,
    syncedAt: new Date(),
  };
  if (status != null) {
    subscription.status = status;
  }
  if (plan != null) {
    subscription.plan = plan;
  }

  const updated = await runAsSystem(() =>
    deps.updateUser(resolvedId, { subscription }, {}, { preserveExpiresAt: true }),
  );
  /** A user deleted between the lookup and the write reports as not found. */
  if (updated == null) {
    return { ok: false, error: { code: 'user_not_found', status: 404 } };
  }
  return {
    ok: true,
    value: {
      userId: resolvedId,
      active: isSubscriptionActive(updated),
      expiresAt: expiresAtDate != null ? expiresAtDate.toISOString() : null,
    },
  };
}

export interface SubscriptionSyncAuthDeps {
  getSecret: () => string | undefined;
  warn?: (message: string) => void;
}

const bearerPattern = /^bearer\s+(.+)$/i;

/**
 * Shared-secret bearer auth for the sync endpoint, following the METRICS_SECRET
 * pattern. SHA-256 digests are compared with `timingSafeEqual`, so the comparison
 * leaks neither the secret's value nor its length. Without a configured secret the
 * endpoint answers 404, so the feature is fully off rather than half-open.
 */
export function createSubscriptionSyncAuth(
  deps: SubscriptionSyncAuthDeps,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const secret = deps.getSecret();
    if (!secret) {
      res.status(404).json({ code: 'subscription_sync_disabled' });
      return;
    }
    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string' ? authorization.match(bearerPattern) : null;
    if (match == null) {
      deps.warn?.(`[subscriptionSync] missing bearer from ${req.ip ?? 'unknown ip'}`);
      res.status(401).json({ code: 'invalid_secret' });
      return;
    }
    const expected = createHash('sha256').update(secret).digest();
    const actual = createHash('sha256').update(match[1]).digest();
    if (!timingSafeEqual(expected, actual)) {
      deps.warn?.(`[subscriptionSync] rejected sync attempt from ${req.ip ?? 'unknown ip'}`);
      res.status(401).json({ code: 'invalid_secret' });
      return;
    }
    next();
  };
}
