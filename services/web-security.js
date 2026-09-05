'use strict';

function configureProxy(app) {
  // Trust addresses, never an arbitrary hop supplied by a direct LAN client.
  const proxies = String(process.env.TRUST_PROXY || '').split(',').map(s => s.trim()).filter(Boolean);
  app.set('trust proxy', proxies.length ? proxies : false);
}

function requireSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) {
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request denied' });
    return next(); // Preserve non-browser cookie and bearer API clients.
  }
  const allowed = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const host = req.get('host');
  const sameOrigin = origin === `${req.protocol}://${host}`;
  // TLS may terminate upstream without a trusted X-Forwarded-Proto header.
  const secureOrigin = process.env.COOKIE_SECURE === 'true' && origin === `https://${host}`;
  if (sameOrigin || secureOrigin || allowed.includes(origin)) return next();
  return res.status(403).json({ error: 'Cross-site request denied' });
}

module.exports = { configureProxy, requireSameOrigin };
