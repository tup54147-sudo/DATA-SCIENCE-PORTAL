// SMS delivery for phone verification codes.
//
// Production: set TERMII_API_KEY (and optionally TERMII_SENDER_ID) in .env — Termii is a
// Nigerian SMS provider (https://termii.com). Any other provider can be dropped in by
// replacing sendViaTermii().
//
// Development (no API key, NODE_ENV != production): the code is printed in the server
// console and returned to the browser so the flow can be tested without sending SMS.
const TERMII_URL = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com/api/sms/send';

function smsConfigured() {
  return Boolean(process.env.TERMII_API_KEY);
}

async function sendViaTermii(to, message) {
  const response = await fetch(TERMII_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TERMII_API_KEY,
      to: to.replace('+', ''),
      from: process.env.TERMII_SENDER_ID || 'N-Alert',
      sms: message,
      type: 'plain',
      channel: process.env.TERMII_CHANNEL || 'dnd'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.code && data.code !== 'ok')) {
    throw new Error(data.message || `SMS provider error (${response.status})`);
  }
}

// Returns { devMode: boolean }
async function sendSms(to, message) {
  if (smsConfigured()) {
    await sendViaTermii(to, message);
    return { devMode: false };
  }
  if (process.env.NODE_ENV === 'production') {
    const error = new Error('SMS service is not configured. Ask the administrator to set TERMII_API_KEY.');
    error.status = 503;
    throw error;
  }
  console.log(`\n[DEV SMS] to ${to}: ${message}\n`);
  return { devMode: true };
}

module.exports = { sendSms, smsConfigured };
