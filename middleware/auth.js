/**
 * middleware/auth.js — JWT authentication for Encodium
 */
'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const COOKIE_NAME = 'encodium_session';

let SECRET;
if (process.env.JWT_SECRET) {
  SECRET = process.env.JWT_SECRET;
} else {
  SECRET = crypto.randomBytes(64).toString('hex');
  console.warn('\n  ⚠️  JWT_SECRET not set — generated a random ephemeral secret.');
  console.warn('     All tokens will be invalidated on restart. Set JWT_SECRET in .env!\n');
}
if (process.env.NODE_ENV === 'production' && SECRET.length < 32) {
  throw new Error('JWT_SECRET must contain at least 32 characters in production');
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '7d',
  });
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096) {
    throw new Error('Invalid token');
  }
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}

function tokenFromRequest(req) {
  const authorization = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1].trim();

  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try { return decodeURIComponent(cookie.slice(separator + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function cookieOptions(req) {
  const forceSecure = process.env.COOKIE_SECURE === 'true';
  return {
    httpOnly: true,
    secure: forceSecure || !!req.secure,
    sameSite: 'strict',
    path: '/api',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
}

function clearSessionCookie(req, res) {
  const options = cookieOptions(req);
  delete options.maxAge;
  res.clearCookie(COOKIE_NAME, options);
}

/** Express middleware — sets req.user or 401 */
function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Requires admin role */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

module.exports = {
  COOKIE_NAME, signToken, verifyToken, tokenFromRequest,
  setSessionCookie, clearSessionCookie, requireAuth, requireAdmin,
};
