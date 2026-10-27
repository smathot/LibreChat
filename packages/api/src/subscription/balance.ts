import { z } from 'zod';
import { runAsSystem } from '@librechat/data-schemas';
import type { SubscriptionUserLookupDeps } from './resolve';
import {
  exactlyOneIdentifierMessage,
  hasExactlyOneSubscriptionIdentifier,
  resolveSubscriptionUserId,
  subscriptionIdentifierSchema,
} from './resolve';

/** Hard ceiling so one malformed purchase cannot mint an unbounded credit amount. */
export const MAX_SUBSCRIPTION_CREDIT_AMOUNT = 1_000_000_000;

/**
 * The body POST /api/subscription/add-balance accepts. Declared rather than `z.infer`-ed
 * so the schema below can carry the explicit type annotation --isolatedDeclarations requires.
 */
export interface SubscriptionAddBalanceBody {
  email?: string;
  userId?: string;
  /** Whole token credits to add (1000 credits = 1 mill, as the balance schema documents). */
  amount: number;
  /** Optional label recorded on the ledger transaction's context. */
  context?: string;
}

export const subscriptionAddBalanceBodySchema: z.ZodType<SubscriptionAddBalanceBody> =
  subscriptionIdentifierSchema
    .extend({
      /** Whole token credits to add (1000 credits = 1 mill, as the balance schema documents). */
      amount: z
        .number({ invalid_type_error: 'amount must be a number' })
        .int('amount must be a whole number of credits')
        .min(1, 'amount must be positive')
        .max(MAX_SUBSCRIPTION_CREDIT_AMOUNT),
      /** Optional label recorded on the ledger transaction's context. */
      context: z.string().trim().min(1).max(64).optional(),
    })
    .strict()
    .refine(hasExactlyOneSubscriptionIdentifier, { message: exactlyOneIdentifierMessage });

/** The ledger-creating charge call every subscription balance write shares, injected
 *  from ~/models (createTransaction). */
export interface SubscriptionChargeDeps {
  addCredits: (txData: {
    user: string;
    tokenType: 'credits';
    context: string;
    rawAmount: number;
    balance?: { enabled?: boolean };
  }) => Promise<{ balance?: number } | undefined>;
  /** Whether the deployment has the balance feature enabled (getBalanceConfig). */
  isBalanceEnabled: () => boolean | undefined;
}

export type SubscriptionAddBalanceResult =
  | { ok: true; value: { userId: string; added: number; tokenCredits: number } }
  | {
      ok: false;
      error: {
        code: 'invalid_body' | 'user_not_found' | 'balance_disabled' | 'add_balance_failed';
        status: 400 | 404 | 409 | 500;
      };
    };

/**
 * Credits a user's balance by the purchased amount.
 *
 * The write is the CLI's validated semantic, not a raw increment: one ledger
 * transaction (`tokenType: 'credits'`, multiplier 1) recorded alongside the
 * optimistic-concurrency balance update, so concurrent generation deductions
 * cannot be lost. The ledger row is durable before the balance is trusted, and
 * the resulting total is returned for Sigmund's reconciliation. Not idempotent —
 * the caller must not retry a purchase whose response it may have received.
 */
export async function addSubscriptionBalance(
  deps: SubscriptionChargeDeps & SubscriptionUserLookupDeps,
  body: unknown,
): Promise<SubscriptionAddBalanceResult> {
  const parsed = subscriptionAddBalanceBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_body', status: 400 } };
  }
  const { amount, context } = parsed.data;

  const resolvedId = await resolveSubscriptionUserId(deps, parsed.data);
  if (resolvedId == null) {
    return { ok: false, error: { code: 'user_not_found', status: 404 } };
  }

  /** Mirrors the CLI, which refuses to run when librechat.yaml has balance off. */
  if (deps.isBalanceEnabled() !== true) {
    return { ok: false, error: { code: 'balance_disabled', status: 409 } };
  }

  let result: { balance?: number } | undefined;
  try {
    result = await runAsSystem(() =>
      deps.addCredits({
        user: resolvedId,
        tokenType: 'credits',
        context: context ?? 'purchase',
        rawAmount: amount,
        balance: { enabled: true },
      }),
    );
  } catch {
    return { ok: false, error: { code: 'add_balance_failed', status: 500 } };
  }
  /** The charge declined without throwing: nothing was written, so the caller may retry. */
  if (result?.balance == null) {
    return { ok: false, error: { code: 'add_balance_failed', status: 500 } };
  }

  return {
    ok: true,
    value: { userId: resolvedId, added: amount, tokenCredits: result.balance },
  };
}
