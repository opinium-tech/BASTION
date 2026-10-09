'use strict';
const crypto = require('crypto');

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(String(data)).digest('hex');
}
function safeEqualHex(a, b) {
  try {
    const x = Buffer.from(String(a), 'hex');
    const y = Buffer.from(String(b), 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch { return false; }
}
function makeId(prefix = 'msg') {
  return `${prefix}_${crypto.randomUUID()}`;
}
module.exports = { sign, safeEqualHex, makeId };
