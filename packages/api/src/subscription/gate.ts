import { ErrorTypes } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { SubscriptionStateUser } from './state';
import { SUBSCRIPTION_INACTIVE_CODE, isSubscriptionActive } from './state';

const AGENT_CHAT_PATH = '/api/agents/chat';
/** POST routes under the chat path that only control or cancel in-flight work. */
const CHAT_CONTROL_ROUTES = new Set(['abort', 'steer/cancel']);
/** Gated requests that are not fresh interactive turns, mirroring `checkBan`'s control
 *  set: an abort and a mid-run steer are answered with a plain 403, never an in-chat
 *  denial. */
const INTERACTIVE_CONTROL_ROUTES = new Set(['abort', 'steer']);

/** The authenticated request as the agents router sees it: the trigger scope is
 *  stamped right after authentication, and the user is the loaded document. */
type GateRequest = Request & {
  _isAgentTrigger?: boolean;
  user?: SubscriptionStateUser;
};

const parsePathname = (req: GateRequest): string => {
  const [path] = (req.originalUrl ?? req.url ?? '').split('?');
  return (path.startsWith('/') ? path : `/${path}`).replace(/\/+$/, '');
};

/**
 * Whether a request starts new model work and must be subscription-gated.
 *
 * Only POSTs under the agents chat path qualify: reads, agent management and the
 * control routes (`abort`, `steer/cancel`) stay open so an expired reader keeps read,
 * stop and cancel access, and the OpenAI/Responses API routers (API-key auth, mounted
 * before this middleware) are never reached at all. Trusted internal admission —
 * `_isAgentTrigger`, stamped right after authentication for trigger-scoped bearers —
 * is exempt, so in-flight runs, scheduled fires and their queued-turn/steer deliveries
 * finish once admitted.
 */
export function isSubscriptionGatedRequest(req: GateRequest | undefined): boolean {
  if (req?._isAgentTrigger === true || req?.method !== 'POST') {
    return false;
  }
  const pathname = parsePathname(req);
  if (pathname === AGENT_CHAT_PATH) {
    return true;
  }
  if (!pathname.startsWith(`${AGENT_CHAT_PATH}/`)) {
    return false;
  }
  const route = pathname.slice(AGENT_CHAT_PATH.length + 1);
  return !CHAT_CONTROL_ROUTES.has(route.toLowerCase());
}

/**
 * Whether a gated request is an interactive browser chat turn whose typed message the
 * in-chat denial should persist — the same predicate `checkBan` uses to choose between
 * `denyRequest` and a plain 403: the chat root, a resume, an ephemeral endpoint or a
 * single-segment route, never a slash-bearing control route.
 */
export function isInteractiveChatRequest(req: GateRequest | undefined): boolean {
  if (req?.method !== 'POST' || req?.body == null) {
    return false;
  }
  const pathname = parsePathname(req);
  if (pathname === AGENT_CHAT_PATH) {
    return true;
  }
  if (!pathname.startsWith(`${AGENT_CHAT_PATH}/`)) {
    return false;
  }
  const route = pathname.slice(AGENT_CHAT_PATH.length + 1);
  return (
    route.length > 0 && !route.includes('/') && !INTERACTIVE_CONTROL_ROUTES.has(route.toLowerCase())
  );
}

export interface SubscriptionGateDeps {
  /** Resolves the stored state; defaults to reading the authenticated request user. */
  isActive?: (user: SubscriptionStateUser | null | undefined, now?: number) => boolean;
  /** Whether the request comes from a browser the in-chat denial is written for. */
  isBrowser: (req: Request) => boolean;
  /** Persists the typed message and streams the in-chat denial (`denyRequest`). */
  denyInChat: (
    req: Request,
    res: Response,
    payload: Record<string, unknown>,
  ) => Promise<void> | void;
  /** Subscription portal URL surfaced to the reader; undefined hides the action. */
  getPortalUrl?: () => string | undefined;
}

/** The coded payload the in-chat denial persists, and the 403 body repeats. */
export type SubscriptionDenyPayload = { type: string; portalUrl?: string };

export function createSubscriptionGate(deps: SubscriptionGateDeps) {
  const isActive =
    deps.isActive ??
    ((user: SubscriptionStateUser | null | undefined, now?: number) =>
      isSubscriptionActive(user, now));
  return async (req: GateRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!isSubscriptionGatedRequest(req) || isActive(req.user)) {
        return next();
      }
      const portalUrl = deps.getPortalUrl?.();
      const payload: SubscriptionDenyPayload = {
        type: ErrorTypes.SUBSCRIPTION_INACTIVE,
        ...(portalUrl != null && portalUrl !== '' ? { portalUrl } : {}),
      };
      if (isInteractiveChatRequest(req) && deps.isBrowser(req)) {
        return await deps.denyInChat(req, res, payload);
      }
      return res.status(403).json({
        code: SUBSCRIPTION_INACTIVE_CODE,
        message: 'An active subscription is required.',
        ...(payload.portalUrl != null ? { portalUrl: payload.portalUrl } : {}),
      });
    } catch (error) {
      return next(error);
    }
  };
}
