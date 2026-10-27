import { z } from 'zod';
import { runAsSystem } from '@librechat/data-schemas';

/** MongoDB ObjectId as stored in the users collection. */
export const SUBSCRIPTION_USER_ID_PATTERN: RegExp = /^[a-f\d]{24}$/i;
/** Fields a subscription request may name its user by; exactly one must be present. */
export const SUBSCRIPTION_IDENTIFIER_FIELDS = ['email', 'userId'] as const;

/** A user record as the subscription resolvers need it: only the id is read. */
export interface SubscriptionUserLike {
  _id: { toString(): string } | string;
}

/** The user lookups every subscription endpoint shares, injected from ~/models. */
export interface SubscriptionUserLookupDeps {
  /** Stored lowercase; `findUser` normalizes the lookup criteria. */
  findUser: (criteria: { email: string }) => Promise<SubscriptionUserLike | null>;
  getUserById: (userId: string) => Promise<SubscriptionUserLike | null>;
}

/**
 * The identifier half of every subscription endpoint's body: exactly one of these.
 * The explicit annotation keeps `.extend()` and `.shape` available to consumers while
 * giving --isolatedDeclarations a nameable declaration type.
 */
export const subscriptionIdentifierSchema: z.ZodObject<
  { email: z.ZodOptional<z.ZodString>; userId: z.ZodOptional<z.ZodString> },
  'strict'
> = z
  .object({
    email: z.string().trim().min(3).max(320).email().optional(),
    userId: z.string().trim().regex(SUBSCRIPTION_USER_ID_PATTERN).optional(),
  })
  .strict();

export type SubscriptionIdentifier = z.infer<typeof subscriptionIdentifierSchema>;

/** Whether a body names its user by exactly one identifier. */
export function hasExactlyOneSubscriptionIdentifier(data: SubscriptionIdentifier): boolean {
  return SUBSCRIPTION_IDENTIFIER_FIELDS.filter((field) => data[field] != null).length === 1;
}

/** Shared refinement message for endpoint body schemas. */
export const exactlyOneIdentifierMessage = 'Exactly one of email or userId must be provided';

const toUserId = (user: SubscriptionUserLike | null): string | null => {
  const id = user?._id;
  if (id == null) {
    return null;
  }
  return typeof id === 'string' ? id : id.toString();
};

/**
 * Resolves the named user to their id, in system scope — the user models are
 * tenant-isolated, so an unscoped lookup could be rejected under strict mode.
 * Returns null when no user matches.
 */
export async function resolveSubscriptionUserId(
  deps: SubscriptionUserLookupDeps,
  identifier: SubscriptionIdentifier,
): Promise<string | null> {
  const user =
    identifier.email != null
      ? await runAsSystem(() => deps.findUser({ email: identifier.email as string }))
      : await runAsSystem(() => deps.getUserById(identifier.userId as string));
  return toUserId(user);
}
