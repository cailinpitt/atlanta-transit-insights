const EVENT_BASE_URL = 'https://atlantatransitalerts.app/event';

function rkeyFromAtUri(uri) {
  if (!uri) return null;
  const parts = uri.split('/');
  if (parts.length < 5) return null;
  return parts[parts.length - 1] || null;
}

function resolvedEventLink(postUri, title) {
  const rkey = rkeyFromAtUri(postUri);
  if (!rkey) return null;
  const url = `${EVENT_BASE_URL}/${rkey}/resolved`;
  return {
    url,
    title: title || 'Atlanta Transit Alerts',
    description: 'View this incident on the Atlanta Transit Alerts archive.',
    thumbUrl: `${url}/og.png`,
    fallbackThumbUrl: 'https://atlantatransitalerts.app/og-image.png',
  };
}

module.exports = { EVENT_BASE_URL, rkeyFromAtUri, resolvedEventLink };
