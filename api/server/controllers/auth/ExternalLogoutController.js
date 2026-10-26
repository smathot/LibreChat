const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { clearCloudFrontCookies } = require('@librechat/api');
const { deleteSession, findSession } = require('~/models');

const domains = {
  client: process.env.DOMAIN_CLIENT,
};

/**
 * IdP-initiated ("external") logout: ends the LibreChat session of the browser
 * that calls this endpoint, without requiring a bearer token. The Identity
 * Provider (or any site allowed by EXTERNAL_LOGOUT_REDIRECT_URIS) navigates the
 * user to the client's /external-logout page, whose same-origin fetch lands here
 * with the httpOnly `refreshToken` cookie attached.
 *
 * Why a page rather than redirecting straight here: the refresh-token cookie is
 * set with SameSite=Strict, so it is NOT sent on the cross-site navigation that
 * arrives from the IdP — only on the same-origin request the page then makes.
 *
 * POST is deliberate: a cross-site top-level navigation can only be a GET, and
 * neither Strict nor Lax cookies attach to cross-site POSTs, so this endpoint is
 * structurally immune to logout-CSRF without a token.
 *
 * Scope: per-browser. Only the session identified by the presented cookie is
 * revoked; sessions of the same user on other devices are untouched.
 */

/** Exact redirect targets (comma-separated) that this endpoint may send the user
 * back to, e.g. the OIDC provider's login page:
 *   EXTERNAL_LOGOUT_REDIRECT_URIS=https://sigmund.example/login
 * Same-origin targets are always allowed; anything else falls back to DOMAIN_CLIENT/login. */
const getAllowedExternalRedirectUris = () =>
  (process.env.EXTERNAL_LOGOUT_REDIRECT_URIS ?? '')
    .split(',')
    .map((uri) => uri.trim())
    .filter(Boolean);

const isSafeExternalLogoutRedirect = (value) => {  
  if (typeof value !== 'string' || !value) {
    return false;
  }
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return false;
  }
  if (domains.client) {
    try {
      if (target.origin === new URL(domains.client).origin) {
        return true;
      }
    } catch {
      /* fall through to the allowlist */
    }
  }
  return getAllowedExternalRedirectUris().includes(target.toString());
};

const getDefaultExternalLogoutRedirect = () => `${domains.client ?? ''}/login`;

/**
 * Ends the durable session that the refresh-token cookie identifies. The cookie
 * is a JWT signed with JWT_REFRESH_SECRET whose `id` claim names the user — the
 * same unauthenticated identity source /api/auth/refresh relies on — and the
 * session record is looked up by the token's hash, exactly as the authenticated
 * logout does. When the cookie is not a local refresh-token JWT (OpenID reuse
 * deployments store the IdP-issued token instead), the upserted session record
 * is identified by the token hash alone.
 * @param {string} refreshToken
 * @returns {Promise<boolean>} whether a session record was revoked
 */
const revokeSessionByRefreshCookie = async (refreshToken) => {
  let userId = null;
  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET ?? '');
    if (typeof payload === 'object' && payload != null && typeof payload.id === 'string') {
      userId = payload.id;
    }
  } catch {
    /* Not a LibreChat-minted refresh token; fall back to hash-only lookup. */
  }
  try {
    const session = userId
      ? await findSession({ userId, refreshToken }, { lean: false })
      : await findSession({ refreshToken }, { lean: false });
    if (session) {
      await deleteSession({ sessionId: session._id.toString() });
      return true;
    }
  } catch (error) {
    logger.warn(
      '[externalLogoutController] Failed to revoke session:',
      error?.message ?? error,
    );
  }
  return false;
};

/**
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */
const externalLogoutController = async (req, res) => {
  const parsedCookies = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  const refreshToken = parsedCookies.refreshToken;

  let revoked = false;
  if (refreshToken) {
    revoked = await revokeSessionByRefreshCookie(refreshToken);
  }

  /** The express session may hold OpenID tokens; destroy it like the authenticated logout does. */
  try {
    req.session?.destroy?.();
  } catch (error) {
    logger.debug('[externalLogoutController] Failed to destroy session.', error);
  }

  res.clearCookie('refreshToken');
  res.clearCookie('openid_access_token');
  res.clearCookie('openid_id_token');
  res.clearCookie('openid_user_id');
  res.clearCookie('token_provider');
  clearCloudFrontCookies(res, {});

  if (revoked) {
    logger.info('[externalLogoutController] Session revoked via external logout');
  }

  /** The redirect target is validated against the configured allowlist; the
   *  query parameter alone is never trusted, so this cannot become an open redirect. */
  const redirectUri = req.query?.redirect_uri;
  const redirect = isSafeExternalLogoutRedirect(redirectUri)
    ? redirectUri
    : getDefaultExternalLogoutRedirect();

  res.set('Cache-Control', 'no-store');
  logger.info(`[externalLogoutController] redirecting to ${redirect}`);
  return res.status(200).json({ message: 'Logout successful', redirect });
};

module.exports = { externalLogoutController, isSafeExternalLogoutRedirect };
