'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateAddress(address) {
  if (!address || typeof address !== 'string') return true;
  const normalized = address.toLowerCase().split('%')[0];

  if (normalized.startsWith('::ffff:')) {
    return isPrivateAddress(normalized.slice(7));
  }

  if (net.isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    const [a, b, c] = octets;
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224;
  }

  if (net.isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' ||
      normalized.startsWith('fc') || normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:');
  }

  return true;
}

async function resolvePublicWebhookUrl(rawUrl, lookup = dns.lookup) {
  let url;
  try { url = new URL(String(rawUrl)); }
  catch { throw new Error('Invalid webhook URL'); }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https webhook URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('Webhook URLs containing credentials are not allowed');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = net.isIP(hostname);
  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  }
  if (!addresses || addresses.length === 0) throw new Error('Webhook host did not resolve');
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Internal, private, reserved, or non-routable webhook targets are not allowed');
  }

  return { url, hostname, address: addresses[0].address, family: addresses[0].family };
}

module.exports = { isPrivateAddress, resolvePublicWebhookUrl };
