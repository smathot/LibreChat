import { ErrorTypes, SystemRoles } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { SubscriptionGateDeps } from './gate';
import {
  addSubscriptionBalance,
  createSubscriptionGate,
  createSubscriptionSyncAuth,
  hasExactlyOneSubscriptionIdentifier,
  isSubscriptionActive,
  isSubscriptionGatedRequest,
  subscriptionIdentifierSchema,
  subscriptionSyncBodySchema,
  syncSubscription,
} from './index';

const asRequest = (init: Record<string, unknown>): Request => init as unknown as Request;

const asResponse = (): { res: Response; status: jest.Mock; json: jest.Mock } => {
  const status = jest.fn();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  return { res, status, json };
};

describe('isSubscriptionActive', () => {
  const now = 1_700_000_000_000;

  it('never gates an ADMIN', () => {
    expect(isSubscriptionActive({ role: SystemRoles.ADMIN }, now)).toBe(true);
  });

  it('blocks a user with no synced subscription (fail-closed)', () => {
    expect(isSubscriptionActive({ role: SystemRoles.USER }, now)).toBe(false);
    expect(isSubscriptionActive({ role: SystemRoles.USER, subscription: {} }, now)).toBe(false);
    expect(
      isSubscriptionActive({ role: SystemRoles.USER, subscription: { expiresAt: null } }, now),
    ).toBe(false);
  });

  it('treats a future expiry as active and a past one as inactive', () => {
    expect(
      isSubscriptionActive(
        { role: SystemRoles.USER, subscription: { expiresAt: new Date(now + 60_000) } },
        now,
      ),
    ).toBe(true);
    expect(
      isSubscriptionActive(
        { role: SystemRoles.USER, subscription: { expiresAt: new Date(now - 60_000) } },
        now,
      ),
    ).toBe(false);
  });

  it('accepts the ISO string a sync response carries', () => {
    expect(
      isSubscriptionActive(
        {
          role: SystemRoles.USER,
          subscription: { expiresAt: new Date(now + 60_000).toISOString() },
        },
        now,
      ),
    ).toBe(true);
  });
});

describe('isSubscriptionGatedRequest', () => {
  const gated = (init: Record<string, unknown>): boolean =>
    isSubscriptionGatedRequest(asRequest({ method: 'POST', ...init }));

  it('gates new model work under the agents chat path', () => {
    expect(gated({ originalUrl: '/api/agents/chat' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat/resume' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat/openAI' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat/steer' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat/steer/arm' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat/queued-turns' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat/queued-turns/v2' })).toBe(true);
    expect(gated({ originalUrl: '/api/agents/chat?conversationId=new' })).toBe(true);
  });

  it('keeps reads, control routes and agent management open', () => {
    expect(gated({ originalUrl: '/api/agents/chat/abort' })).toBe(false);
    expect(gated({ originalUrl: '/api/agents/chat/steer/cancel' })).toBe(false);
    expect(
      isSubscriptionGatedRequest(
        asRequest({ method: 'GET', originalUrl: '/api/agents/chat/status/abc' }),
      ),
    ).toBe(false);
    expect(gated({ originalUrl: '/api/agents' })).toBe(false);
    expect(gated({ originalUrl: '/api/agents/agent_123/duplicate' })).toBe(false);
    expect(gated({ originalUrl: '/api/agents/v1/chat/completions' })).toBe(false);
  });

  it('exempts trusted trigger admission so in-flight runs and schedules finish', () => {
    expect(gated({ originalUrl: '/api/agents/chat', _isAgentTrigger: true })).toBe(false);
    expect(gated({ originalUrl: '/api/agents/chat/steer/deliver', _isAgentTrigger: true })).toBe(
      false,
    );
  });
});

describe('createSubscriptionGate', () => {
  const inactive = { role: SystemRoles.USER, subscription: { expiresAt: null } };
  const active = {
    role: SystemRoles.USER,
    subscription: { expiresAt: new Date(Date.now() + 3_600_000) },
  };

  const buildGate = (overrides: Partial<SubscriptionGateDeps> = {}) =>
    createSubscriptionGate({
      isBrowser: () => true,
      denyInChat: jest.fn(),
      getPortalUrl: () => 'https://portal.example.com',
      ...overrides,
    });

  it('denies an interactive browser request in chat with the coded payload', async () => {
    const denyInChat = jest.fn();
    const gate = buildGate({ denyInChat });
    const req = asRequest({
      method: 'POST',
      originalUrl: '/api/agents/chat',
      body: { text: 'hello' },
      headers: {},
      user: inactive,
    });
    const { res } = asResponse();
    const next = jest.fn();

    await gate(req, res, next as NextFunction);

    expect(denyInChat).toHaveBeenCalledWith(req, res, {
      type: ErrorTypes.SUBSCRIPTION_INACTIVE,
      portalUrl: 'https://portal.example.com',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers a browser steer with a plain 403 (mid-run control, not a fresh turn)', async () => {
    const denyInChat = jest.fn();
    const gate = buildGate({ denyInChat });
    const { res, status, json } = asResponse();

    await gate(
      asRequest({
        method: 'POST',
        originalUrl: '/api/agents/chat/steer',
        body: { text: 'hello' },
        headers: {},
        user: inactive,
      }),
      res,
      jest.fn(),
    );

    expect(denyInChat).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'subscription_inactive',
        portalUrl: 'https://portal.example.com',
      }),
    );
  });

  it('answers a non-browser gated request with a coded 403', async () => {
    const denyInChat = jest.fn();
    const gate = buildGate({ isBrowser: () => false, denyInChat });
    const { res, status, json } = asResponse();

    await gate(
      asRequest({
        method: 'POST',
        originalUrl: '/api/agents/chat/resume',
        body: {},
        headers: {},
        user: inactive,
      }),
      res,
      jest.fn(),
    );

    expect(denyInChat).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'subscription_inactive',
        portalUrl: 'https://portal.example.com',
      }),
    );
  });

  it('omits the portal action when no portal URL is configured', async () => {
    const gate = buildGate({ getPortalUrl: () => undefined });
    const { res, status, json } = asResponse();

    await gate(
      asRequest({
        method: 'POST',
        originalUrl: '/api/agents/chat/resume',
        body: {},
        headers: {},
        user: inactive,
      }),
      res,
      jest.fn(),
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.not.objectContaining({ portalUrl: expect.anything() }),
    );
  });

  it('lets an active subscriber start work and never touches non-gated requests', async () => {
    const denyInChat = jest.fn();
    const gate = buildGate({ denyInChat });
    const { res } = asResponse();

    const nextActive = jest.fn();
    await gate(
      asRequest({
        method: 'POST',
        originalUrl: '/api/agents/chat',
        body: { text: 'hello' },
        headers: {},
        user: active,
      }),
      res,
      nextActive as NextFunction,
    );
    expect(nextActive).toHaveBeenCalled();

    const nextRead = jest.fn();
    await gate(
      asRequest({
        method: 'GET',
        originalUrl: '/api/agents/chat/status/abc',
        headers: {},
        user: inactive,
      }),
      res,
      nextRead as NextFunction,
    );
    expect(nextRead).toHaveBeenCalled();
    expect(denyInChat).not.toHaveBeenCalled();
  });
});

describe('syncSubscription', () => {
  const future = new Date(Date.now() + 86_400_000);

  const buildDeps = (
    updateUserImpl: () => Promise<unknown> = async () => ({
      role: SystemRoles.USER,
      subscription: { expiresAt: future },
    }),
  ) => ({
    findUser: jest.fn(async () => ({ _id: { toString: () => 'user1' } })),
    getUserById: jest.fn(async () => ({ _id: { toString: () => 'user1' } })),
    updateUser: jest.fn(updateUserImpl),
  });

  it('resolves by email and writes the subdocument preserving the account TTL', async () => {
    const deps = buildDeps();
    const result = await syncSubscription(deps, {
      email: 'user@example.com',
      expiresAt: future.toISOString(),
      status: 'active',
      plan: 'pro',
    });

    expect(result).toEqual({
      ok: true,
      value: { userId: 'user1', active: true, expiresAt: future.toISOString() },
    });
    expect(deps.findUser).toHaveBeenCalledWith({ email: 'user@example.com' });
    expect(deps.updateUser).toHaveBeenCalledWith(
      'user1',
      {
        subscription: {
          expiresAt: future,
          syncedAt: expect.any(Date),
          status: 'active',
          plan: 'pro',
        },
      },
      {},
      { preserveExpiresAt: true },
    );
  });

  it('resolves by userId when no email is named', async () => {
    const deps = buildDeps();
    await syncSubscription(deps, {
      userId: '507f1f77bcf86cd799439011',
      expiresAt: future.toISOString(),
    });
    expect(deps.getUserById).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
    expect(deps.findUser).not.toHaveBeenCalled();
  });

  it('deactivates on a null expiry', async () => {
    const deps = buildDeps(async () => ({
      role: SystemRoles.USER,
      subscription: { expiresAt: null },
    }));
    const result = await syncSubscription(deps, { email: 'user@example.com', expiresAt: null });
    expect(result).toEqual({
      ok: true,
      value: { userId: 'user1', active: false, expiresAt: null },
    });
  });

  it('rejects a body naming both identifiers or none as invalid_body', async () => {
    const deps = buildDeps();
    const both = await syncSubscription(deps, {
      email: 'user@example.com',
      userId: '507f1f77bcf86cd799439011',
      expiresAt: null,
    });
    const neither = await syncSubscription(deps, { expiresAt: null });
    expect(both).toEqual({ ok: false, error: { code: 'invalid_body', status: 400 } });
    expect(neither).toEqual({ ok: false, error: { code: 'invalid_body', status: 400 } });
  });

  it('reports an unknown user as user_not_found', async () => {
    const deps = {
      findUser: jest.fn(async () => null),
      getUserById: jest.fn(async () => null),
      updateUser: jest.fn(),
    };
    const result = await syncSubscription(deps, { email: 'gone@example.com', expiresAt: null });
    expect(result).toEqual({ ok: false, error: { code: 'user_not_found', status: 404 } });
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('reports a user deleted mid-sync as user_not_found', async () => {
    const deps = buildDeps(async () => null);
    const result = await syncSubscription(deps, {
      email: 'user@example.com',
      expiresAt: future.toISOString(),
    });
    expect(result).toEqual({ ok: false, error: { code: 'user_not_found', status: 404 } });
  });
});

describe('createSubscriptionSyncAuth', () => {
  const next = jest.fn();

  beforeEach(() => {
    next.mockClear();
  });

  it('hides the endpoint when no secret is configured', () => {
    const auth = createSubscriptionSyncAuth({ getSecret: () => undefined });
    const { res, status, json } = asResponse();
    auth(asRequest({ headers: {} }), res, next);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ code: 'subscription_sync_disabled' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a wrong or missing bearer with 401', () => {
    const auth = createSubscriptionSyncAuth({
      getSecret: () => 'secret',
      warn: jest.fn(),
    });
    const missing = asResponse();
    auth(asRequest({ headers: {} }), missing.res, next);
    expect(missing.status).toHaveBeenCalledWith(401);

    const wrong = asResponse();
    auth(
      asRequest({ headers: { authorization: 'Bearer nope' }, ip: '10.0.0.1' }),
      wrong.res,
      next,
    );
    expect(wrong.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the configured secret', () => {
    const auth = createSubscriptionSyncAuth({ getSecret: () => 'secret' });
    const { res } = asResponse();
    auth(asRequest({ headers: { authorization: 'Bearer secret' } }), res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('shared identifier contract', () => {
  it('accepts each identifier alone and rejects both-or-neither', () => {
    expect(subscriptionSyncBodySchema.safeParse({ email: 'a@b.co', expiresAt: null }).success).toBe(
      true,
    );
    expect(
      subscriptionSyncBodySchema.safeParse({
        userId: '507f1f77bcf86cd799439011',
        expiresAt: null,
      }).success,
    ).toBe(true);
    expect(
      subscriptionSyncBodySchema.safeParse({
        email: 'a@b.co',
        userId: '507f1f77bcf86cd799439011',
        expiresAt: null,
      }).success,
    ).toBe(false);
    expect(subscriptionSyncBodySchema.safeParse({ expiresAt: null }).success).toBe(false);
  });

  it('names the same identifier fields as the balance schema', () => {
    expect(Object.keys(subscriptionIdentifierSchema.shape)).toEqual(['email', 'userId']);
    expect(hasExactlyOneSubscriptionIdentifier({ email: 'a@b.co' })).toBe(true);
    expect(
      hasExactlyOneSubscriptionIdentifier({ email: 'a@b.co', userId: 'x'.repeat(24) }),
    ).toBe(false);
  });
});

describe('addSubscriptionBalance', () => {
  const buildDeps = (
    addCreditsImpl: () => Promise<{ balance?: number } | undefined> = async () => ({
      balance: 5000,
    }),
  ) => ({
    findUser: jest.fn(async () => ({ _id: { toString: () => 'user1' } })),
    getUserById: jest.fn(async () => ({ _id: { toString: () => 'user1' } })),
    addCredits: jest.fn(addCreditsImpl),
    isBalanceEnabled: jest.fn(() => true),
  });

  it('credits the amount through a ledger transaction and reports the new total', async () => {
    const deps = buildDeps();
    const result = await addSubscriptionBalance(deps, {
      email: 'user@example.com',
      amount: 1000,
    });

    expect(result).toEqual({
      ok: true,
      value: { userId: 'user1', added: 1000, tokenCredits: 5000 },
    });
    expect(deps.addCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user1',
        tokenType: 'credits',
        context: 'purchase',
        rawAmount: 1000,
        balance: { enabled: true },
      }),
    );
  });

  it('honors a caller-supplied context label', async () => {
    const deps = buildDeps();
    await addSubscriptionBalance(deps, {
      userId: '507f1f77bcf86cd799439011',
      amount: 500,
      context: 'topup_plan_pro',
    });
    expect(deps.addCredits).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'topup_plan_pro' }),
    );
  });

  it('rejects non-positive, fractional, oversized, and non-numeric amounts', async () => {
    const deps = buildDeps();
    for (const amount of [0, -100, 12.5, 1e10, '1000']) {
      const result = await addSubscriptionBalance(deps, { email: 'u@example.com', amount });
      expect(result).toEqual({ ok: false, error: { code: 'invalid_body', status: 400 } });
    }
    expect(deps.addCredits).not.toHaveBeenCalled();
  });

  it('rejects both-or-neither identifiers and unknown fields as invalid_body', async () => {
    const deps = buildDeps();
    const both = await addSubscriptionBalance(deps, {
      email: 'u@example.com',
      userId: '507f1f77bcf86cd799439011',
      amount: 100,
    });
    const neither = await addSubscriptionBalance(deps, { amount: 100 });
    const extra = await addSubscriptionBalance(deps, {
      email: 'u@example.com',
      amount: 100,
      expiresAt: null,
    });
    expect(both).toEqual({ ok: false, error: { code: 'invalid_body', status: 400 } });
    expect(neither).toEqual({ ok: false, error: { code: 'invalid_body', status: 400 } });
    expect(extra).toEqual({ ok: false, error: { code: 'invalid_body', status: 400 } });
  });

  it('reports an unknown user as user_not_found', async () => {
    const deps = buildDeps();
    deps.findUser.mockResolvedValue(null);
    const result = await addSubscriptionBalance(deps, {
      email: 'gone@example.com',
      amount: 100,
    });
    expect(result).toEqual({ ok: false, error: { code: 'user_not_found', status: 404 } });
    expect(deps.addCredits).not.toHaveBeenCalled();
  });

  it('refuses to credit when the deployment has balance disabled', async () => {
    const deps = buildDeps();
    deps.isBalanceEnabled.mockReturnValue(false);
    const result = await addSubscriptionBalance(deps, {
      email: 'user@example.com',
      amount: 100,
    });
    expect(result).toEqual({ ok: false, error: { code: 'balance_disabled', status: 409 } });
    expect(deps.addCredits).not.toHaveBeenCalled();
  });

  it('reports a declined or throwing charge as add_balance_failed without inventing a total', async () => {
    const throwing = buildDeps(async () => {
      throw new Error('db down');
    });
    const failed = await addSubscriptionBalance(throwing, {
      email: 'user@example.com',
      amount: 100,
    });
    expect(failed).toEqual({ ok: false, error: { code: 'add_balance_failed', status: 500 } });

    const declining = buildDeps(async () => ({ balance: undefined }));
    const declined = await addSubscriptionBalance(declining, {
      email: 'user@example.com',
      amount: 100,
    });
    expect(declined).toEqual({ ok: false, error: { code: 'add_balance_failed', status: 500 } });
  });
});
