import { SystemRoles } from 'librechat-data-provider';

/** Stable machine-readable code shared by every subscription-inactive denial surface. */
export const SUBSCRIPTION_INACTIVE_CODE = 'subscription_inactive';

export type SubscriptionStateUser = {
  role?: string | null;
  subscription?: {
    expiresAt?: Date | string | null;
  } | null;
};

/**
 * Whether a user may start new model work.
 *
 * An ADMIN is never subscription-gated. No stored `subscription.expiresAt` in the future
 * means inactive: the sync contract is fail-closed, so an account that was never synced
 * cannot chat until the subscription source writes its first state — and an account
 * whose last synced instant has passed suspends itself even if no further sync arrives.
 */
export function isSubscriptionActive(
  user: SubscriptionStateUser | null | undefined,
  now: number = Date.now(),
): boolean {
  if (user?.role === SystemRoles.ADMIN) {
    return true;
  }
  const expiresAt = user?.subscription?.expiresAt;
  if (expiresAt == null) {
    return false;
  }
  const expiryMs = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  return Number.isFinite(expiryMs) && expiryMs > now;
}
