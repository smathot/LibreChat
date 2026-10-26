import { useEffect, useRef } from 'react';
import { apiBaseUrl } from 'librechat-data-provider';
import { clearComposerDraftStorage, clearRetainedFileDeletions } from '~/utils';
import { BlinkAnimation } from './BlinkAnimation';

/**
 * IdP-initiated ("external") logout landing page.
 *
 * The OIDC provider (or anything allowed by the server's
 * EXTERNAL_LOGOUT_REDIRECT_URIS) navigates the user here to end the LibreChat
 * session in this browser. This must be a client-side page rather than a bare
 * API redirect: the httpOnly `refreshToken` cookie is set with SameSite=Strict,
 * so it does not attach to the cross-site navigation that arrives from the
 * provider — but it does attach to the same-origin POST this page then makes to
 * /api/auth/logout/external, which revokes the session server-side.
 *
 * The route is deliberately registered OUTSIDE AuthContextProvider: mounting
 * inside it would fire the silent token refresh on load and could resurrect the
 * session this page exists to end.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const ExternalLogout = () => {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    /** Same exit hygiene as the in-app logout: the departing account's drafts and
     *  retained file deletions must not survive for the next sign-in on a shared browser. */
    clearComposerDraftStorage();
    clearRetainedFileDeletions();

    const redirectUri = new URLSearchParams(window.location.search).get('redirect_uri') ?? '';
    const endpoint = `${apiBaseUrl()}/api/auth/logout/external${
      redirectUri ? `?redirect_uri=${encodeURIComponent(redirectUri)}` : ''
    }`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    /** The response's redirect target is validated server-side against the
     *  configured allowlist; the query parameter alone is never trusted. */
    fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      credentials: 'same-origin',
    })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as
          | { redirect?: string }
          | null;
        return typeof data?.redirect === 'string' && data.redirect ? data.redirect : null;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timeout))
      .then((target) => {
        /** Whether or not the server could be reached, leave this page: falling
         *  back to our own login keeps the user from being stranded here. */
        window.location.replace(target ?? `${apiBaseUrl()}/login`);
      });
  }, []);

  return (
    <div className="bg-surface-primary flex min-h-screen flex-col items-center justify-center px-6">
      <BlinkAnimation active={true}>
        <div className="h-10 w-40">
          <img src="assets/logo.svg" className="h-full w-full object-contain" alt="LibreChat" />
        </div>
      </BlinkAnimation>
      <h1
        role="status"
        className="text-text-primary mt-8 text-center text-3xl font-semibold"
        style={{ userSelect: 'none' }}
      >
        Signing you out…
      </h1>
      <p className="text-text-primary mt-2 text-center text-sm opacity-70">
        You will be returned shortly.
      </p>
    </div>
  );
};

export default ExternalLogout;
