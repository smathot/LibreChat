import { Button } from '@librechat/client';
import type { ErrorRendererProps } from './parts';
import { ErrorBody, ErrorActions, readString } from './parts';
import { useLocalize } from '~/hooks';

/**
 * The account's subscription is inactive: the typed message was kept but no model ran.
 * The portal URL the denial payload carries is the one way forward, so it is offered as
 * the action next to the sentence, opening in a new tab so the chat stays behind it.
 */
export default function SubscriptionError({ json }: ErrorRendererProps) {
  const localize = useLocalize();
  const portalUrl = readString(json, 'portalUrl');

  return (
    <ErrorBody>
      <div>{localize('com_error_subscription_inactive')}</div>
      {portalUrl != null && (
        <ErrorActions>
          <Button size="sm" className="rounded-md" asChild>
            <a href={portalUrl} target="_blank" rel="noreferrer">
              {localize('com_error_subscription_manage')}
            </a>
          </Button>
        </ErrorActions>
      )}
    </ErrorBody>
  );
}
