// Nigerian phone number helpers.
// Accepts: 08031234567, 8031234567, 2348031234567, +2348031234567, +234 803 123 4567
// Always returns the canonical international form: +2348031234567
//
// Valid Nigerian mobile numbers are 10 digits after the country code and begin with
// 70x, 80x, 81x, 90x or 91x (MTN, Airtel, Glo, 9mobile and newer ranges).
function normalizeNigerianPhone(value = '') {
  let digits = String(value).replace(/[\s\-().]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;

  if (digits.startsWith('234')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);

  // national significant number must now be exactly 10 digits, e.g. 8031234567
  if (!/^[789][01]\d{8}$/.test(digits)) return null;
  return `+234${digits}`;
}

module.exports = { normalizeNigerianPhone };
