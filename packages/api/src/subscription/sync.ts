import { z } from 'zod';
import { runAsSystem } from '@librechat/data-schemas';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { SubscriptionStateUser } from './state';
import type { SubscriptionUserLookupDeps } from './resolve';
import {
  exactlyOneIdentifierMessage,
  hasExactlyOneSubscriptionIdentifier,
  resolveSubscriptionUserId,
  subscriptionIdentifierSchema,
} from './resolve';
import { isSubscriptionActive } from './state';

/**
 * The body POST /api/subscription/sync accepts. Declared rather than `z.infer`-ed so the
 * schema below can carry the explicit type annotation --isolatedDeclarations requires.
 */
export interface SubscriptionSyncBody {
  email?: string;
  userId?: string;
  /** Instant the subscription runs until (ISO 8601, UTC `Z`). `null` deactivates. */
  expiresAt: string | null;
  /** Informational provider status, e.g. 'active' or 'past_due'. */
  status?: string;
  /** Informational plan name. */
  plan?: string;
}

export const subscriptionSyncBodySchema: z.ZodType<SubscriptionSyncBody> =
  subscriptionIdentifierSchema
    .extend({
      /** Instant the subscription runs until (ISO 8601, UTC `Z`). `null` deactivates. */
      expiresAt: z.string().datetime().nullable(),
      /** Informational provider status, e.g. 'active' or 'past_due'. */
      status: z.string().trim().min(1).max(64).optional(),
      /** Informational plan name. */
      plan: z.string().trim().min(1).max(64).optional(),
    })
    .strict()
    .refine(hasExactlyOneSubscriptionIdentifier, { message: exactlyOneIdentifierMessage });

export interface SubscriptionSyncDeps extends SubscriptionUserLookupDeps {
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
  const { expiresAt, status, plan } = parsed.data;

  const resolvedId = await resolveSubscriptionUserId(deps, parsed.data);
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
 * Shared-secret bearer auth for the subscription endpoints, following the METRICS_SECRET
 * pattern. SHA-256 digests are compared with `timingSafeEqual`, so the comparison
 * leaks neither the secret's value nor its length. Without a configured secret the
 * endpoints answer 404, so the feature is fully off rather than half-open.
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
