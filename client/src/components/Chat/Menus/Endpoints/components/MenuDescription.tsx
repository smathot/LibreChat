import { useMemo } from 'react';
import {
  CONFIG_HTML_MEDIA_ATTR,
  CONFIG_HTML_MEDIA_TAGS,
  createConfigHtmlSanitizer,
} from '~/utils';

interface MenuDescriptionProps {
  description?: string;
}

/** Matches an opening tag anywhere, so mixed strings ("Model 5.3<br><small>…") render as HTML too. */
const htmlPattern = /<[a-z][a-z0-9]*\b/i;

/**
 * Subtitle text for model-selector rows (endpoint and model entries).
 * Plain strings render as text; strings containing tags render sanitized —
 * `<small>` is allowed beyond the stock config-HTML tag list so operators
 * can write smaller explanatory text. Unset descriptions render nothing.
 */
export default function MenuDescription({ description }: MenuDescriptionProps) {
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: [...CONFIG_HTML_MEDIA_TAGS, 'small'],
        allowedAttr: CONFIG_HTML_MEDIA_ATTR,
      }),
    [],
  );

  if (!description) {
    return null;
  }

  if (!htmlPattern.test(description)) {
    return (
      <span className="break-words text-xs font-normal text-text-secondary">{description}</span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 break-words text-xs font-normal text-text-secondary [&_img]:inline-block [&_img]:h-3.5 [&_img]:w-3.5"
      dangerouslySetInnerHTML={{ __html: sanitize(description) }}
    />
  );
}
