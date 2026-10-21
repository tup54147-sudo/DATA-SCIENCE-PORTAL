const crypto = require('crypto');

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('hex'));
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt);
  return { salt, hash };
}

async function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const actualHash = await scrypt(password, salt);
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function makeTemporaryPassword() {
  return `DS-${crypto.randomBytes(4).toString('hex').toUpperCase()}!`;
}

module.exports = { hashPassword, verifyPassword, makeTemporaryPassword };
