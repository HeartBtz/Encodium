/**
 * middleware/auth.js — JWT authentication for Encodium
 */
'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../db');

const SECRET = process.env.JWT_SECRET || 'encodium-change-me';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/** Express middleware — sets req.user or 401 */
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization;
  if (!hdr || !hdr.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = verifyToken(hdr.slice(7));
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

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, SECRET };
