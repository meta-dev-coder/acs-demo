const knownIds = new Set(process.env.KNOWN_CHAN_IDS?.split(',').filter(Boolean) ?? []);

const PATH_RE = /^\/api\/i595\/camera\/(\d+)\/snapshot$/;

const CORS = { 'access-control-allow-origin': '*' };

export const handler = async (event) => {
  const method = event.requestContext?.http?.method?.toUpperCase() ?? 'GET';

  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      },
      body: '',
    };
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return {
      statusCode: 405,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const match = PATH_RE.exec(event.rawPath ?? '');
  if (!match || !/^\d+$/.test(match[1])) {
    return {
      statusCode: 404,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };
  }

  const chanId = match[1];

  if (!knownIds.has(chanId)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Unknown channel ID' }),
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);

  try {
    const upstream = await fetch(
      `https://images-dis.divas.cloud/DGI/chan-${chanId}_h.jpg`,
      { signal: ac.signal },
    );

    if (!upstream.ok) {
      return {
        statusCode: 502,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'snapshot unavailable' }),
      };
    }

    const bytes = await upstream.arrayBuffer();

    return {
      statusCode: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'no-cache, no-store',
        'access-control-allow-origin': '*',
      },
      body: Buffer.from(bytes).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (_err) {
    return {
      statusCode: 502,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'snapshot unavailable' }),
    };
  } finally {
    clearTimeout(timer);
  }
};
