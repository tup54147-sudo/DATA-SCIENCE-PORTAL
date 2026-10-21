const express = require('express');
const crypto = require('crypto');
const { db, normalizeReg } = require('../lib/db');
const { hashPassword, verifyPassword } = require('../lib/password');
const { requireHod } = require('../lib/auth');
const { normalizeNigerianPhone } = require('../lib/phone');
const { sendSms } = require('../lib/sms');

const router = express.Router();

function clean(value, max = 255) {
  return String(value || '').trim().slice(0, max);
}


// ---------------------------------------------------------------------------
// Phone verification (SMS one-time code) — required before student registration
// ---------------------------------------------------------------------------
const OTP_TTL_MS = 5 * 60 * 1000;        // code valid for 5 minutes
const OTP_RESEND_MS = 60 * 1000;         // 60 seconds between sends to the same number
const OTP_MAX_ATTEMPTS = 5;              // wrong guesses before a new code is required
const VERIFIED_TTL_MS = 15 * 60 * 1000;  // verified number must be used to register within 15 minutes
const ipSends = new Map();               // simple per-IP limiter: 10 sends / hour

function hashOtp(phone, code) {
  return crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || 'dev'}:${phone}:${code}`).digest('hex');
}

function ipAllowed(ip) {
  const now = Date.now();
  const recent = (ipSends.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 10) { ipSends.set(ip, recent); return false; }
  recent.push(now);
  ipSends.set(ip, recent);
  return true;
}

router.post('/phone/send-otp', async (req, res) => {
  try {
    const phone = normalizeNigerianPhone(req.body.phone || req.body.phoneNumber);
    if (!phone) {
      return res.status(400).json({ error: 'Enter a valid Nigerian mobile number, e.g. 0803 123 4567 (+234 803 123 4567).' });
    }
    if (db.prepare('SELECT id FROM students WHERE phone = ?').get(phone)) {
      return res.status(409).json({ error: 'This phone number is already linked to a student account.' });
    }
    const existing = db.prepare('SELECT last_sent_at FROM phone_verifications WHERE phone = ?').get(phone);
    const now = Date.now();
    if (existing && now - existing.last_sent_at < OTP_RESEND_MS) {
      const wait = Math.ceil((OTP_RESEND_MS - (now - existing.last_sent_at)) / 1000);
      return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.`, retryAfter: wait });
    }
    if (!ipAllowed(req.ip)) {
      return res.status(429).json({ error: 'Too many verification requests. Please try again later.' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare(`
      INSERT INTO phone_verifications (phone, code_hash, expires_at, attempts, last_sent_at)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, last_sent_at = excluded.last_sent_at
    `).run(phone, hashOtp(phone, code), now + OTP_TTL_MS, now);

    const { devMode } = await sendSms(phone, `Your University of Uyo Data Science portal verification code is ${code}. It expires in 5 minutes.`);
    // Any previously verified number in this session is no longer trusted once a new one is requested.
    if (req.session.verifiedPhone && req.session.verifiedPhone.phone !== phone) delete req.session.verifiedPhone;

    return res.json({
      success: true,
      phone,
      message: `A 6-digit code has been sent to ${phone}.`,
      resendIn: OTP_RESEND_MS / 1000,
      ...(devMode ? { devMode: true, devCode: code } : {})
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    return res.status(error.status || 502).json({ error: error.status === 503 ? error.message : 'Could not send the verification SMS. Please try again.' });
  }
});

router.post('/phone/verify-otp', (req, res) => {
  try {
    const phone = normalizeNigerianPhone(req.body.phone || req.body.phoneNumber);
    const code = String(req.body.code || '').trim();
    if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code that was sent to your phone.' });

    const row = db.prepare('SELECT * FROM phone_verifications WHERE phone = ?').get(phone);
    if (!row) return res.status(400).json({ error: 'No code was requested for this number. Tap "Send code" first.' });
    if (Date.now() > row.expires_at) {
      db.prepare('DELETE FROM phone_verifications WHERE phone = ?').run(phone);
      return res.status(400).json({ error: 'This code has expired. Request a new one.' });
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      db.prepare('DELETE FROM phone_verifications WHERE phone = ?').run(phone);
      return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
    }

    const expected = Buffer.from(row.code_hash, 'hex');
    const given = Buffer.from(hashOtp(phone, code), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      db.prepare('UPDATE phone_verifications SET attempts = attempts + 1 WHERE phone = ?').run(phone);
      const left = OTP_MAX_ATTEMPTS - row.attempts - 1;
      return res.status(400).json({ error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new one.' });
    }

    db.prepare('DELETE FROM phone_verifications WHERE phone = ?').run(phone);
    req.session.verifiedPhone = { phone, at: Date.now() };
    return res.json({ success: true, phone, message: 'Phone number verified.' });
  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({ error: 'Unable to verify the code right now.' });
  }
});

function expectedLevelForAdmissionYear(year) {
  const currentYear = new Date().getFullYear();
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) return null;
  const mapping = {
    [currentYear]: '100L',
    [currentYear - 1]: '200L',
    [currentYear - 2]: '300L',
    [currentYear - 3]: '400L'
  };
  return mapping[numericYear] || null;
}

function expectedRegPrefixForAdmissionYear(year) {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear)) return null;
  if (numericYear >= 2023 && numericYear <= 2026) return String(numericYear).slice(-2);
  return null;
}

router.post('/student/register', async (req, res) => {
  try {
    const regNumber = normalizeReg(req.body.registrationNumber || req.body.regNumber);
    const fullName = clean(req.body.fullName, 150);
    const email = clean(req.body.email, 150).toLowerCase();
    const phone = normalizeNigerianPhone(req.body.phoneNumber || req.body.phone);
    const course = clean(req.body.course, 150) || 'B.Sc. Data Science';
    const admissionYear = Number(req.body.admissionYear ?? req.body.admission_year);
    const level = clean(req.body.level, 20) || '100L';
    const password = String(req.body.password || '');

    if (!regNumber || !fullName || !email || !password) {
      return res.status(400).json({ error: 'Full name, registration number, email and password are required.' });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (!phone) return res.status(400).json({ error: 'Enter a valid Nigerian phone number (+234…).' });
    const currentYear = new Date().getFullYear();
    const expectedLevel = expectedLevelForAdmissionYear(admissionYear);
    const expectedPrefix = expectedRegPrefixForAdmissionYear(admissionYear);
    if (!expectedLevel || String(level).toUpperCase() !== expectedLevel.toUpperCase()) {
      return res.status(400).json({ error: `level does not match admission year. Current year is ${currentYear}` });
    }
    if (!expectedPrefix || !String(regNumber).replace(/[^0-9]/g, '').startsWith(expectedPrefix)) {
      return res.status(400).json({ error: `Registration number does not match admission year. For ${admissionYear}, registration must start with ${expectedPrefix}.` });
    }
    const verified = req.session.verifiedPhone;
    if (!verified || verified.phone !== phone || Date.now() - verified.at > VERIFIED_TTL_MS) {
      return res.status(403).json({ error: 'Please verify your phone number with the SMS code before creating your account.' });
    }

    const allowed = db.prepare('SELECT reg_number FROM allowed_students WHERE reg_number = ?').get(regNumber);
    if (!allowed) return res.status(403).json({ error: 'This registration number is not on the approved Data Science student list.' });
    if (db.prepare('SELECT id FROM students WHERE reg_number = ? OR email = ?').get(regNumber, email)) {
      return res.status(409).json({ error: 'An account already exists with this registration number or email.' });
    }

    if (db.prepare('SELECT id FROM students WHERE phone = ?').get(phone)) {
      return res.status(409).json({ error: 'This phone number is already linked to a student account.' });
    }

    const { salt, hash } = await hashPassword(password);
    const result = db.prepare(`
      INSERT INTO students (reg_number, full_name, email, phone, course, level, password_salt, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(regNumber, fullName, email, phone, course, level, salt, hash);

    delete req.session.verifiedPhone;
    req.session.studentId = Number(result.lastInsertRowid);
    req.session.studentName = fullName;
    delete req.session.staffId;
    delete req.session.staffRole;

    return res.status(201).json({
      success: true,
      redirect: '/student',
      profile: { registrationNumber: regNumber, fullName, email, phone, course, level }
    });
  } catch (error) {
    console.error('Student registration error:', error);
    return res.status(500).json({ error: 'Unable to create the account right now.' });
  }
});

router.post('/student/login', async (req, res) => {
  try {
    const identifier = clean(req.body.identifier || req.body.regNumber, 150);
    const password = String(req.body.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'Enter your email or registration number and password.' });

    const normalizedReg = normalizeReg(identifier);
    const student = db.prepare('SELECT * FROM students WHERE reg_number = ? OR lower(email) = lower(?)').get(normalizedReg, identifier);
    if (!student || !(await verifyPassword(password, student.password_salt, student.password_hash))) {
      return res.status(401).json({ error: 'Incorrect email/registration number or password.' });
    }

    req.session.studentId = student.id;
    req.session.studentName = student.full_name;
    delete req.session.staffId;
    delete req.session.staffRole;

    return res.json({ success: true, redirect: '/student' });
  } catch (error) {
    console.error('Student login error:', error);
    return res.status(500).json({ error: 'Unable to log in right now.' });
  }
});

router.post('/student/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/learning-area-access.html' }));
});

router.post('/admin/login', async (req, res) => {
  try {
    const identifier = clean(req.body.inviteCode || req.body.identifier, 150);
    const password = String(req.body.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'Enter your staff login code/email and password.' });

    const staff = db.prepare('SELECT * FROM staff WHERE upper(login_code) = upper(?) OR lower(email) = lower(?)').get(identifier, identifier);
    if (!staff || !(await verifyPassword(password, staff.password_salt, staff.password_hash))) {
      return res.status(401).json({ error: 'Invalid staff login details.' });
    }

    req.session.staffId = staff.id;
    req.session.staffName = staff.full_name;
    req.session.staffRole = staff.role;
    delete req.session.studentId;

    return res.json({ success: true, redirect: '/admin' });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({ error: 'Unable to log in right now.' });
  }
});

router.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: '/admin-login.html' }));
});

router.post('/admin/invite-lecturer', requireHod, (req, res) => {
  try {
    const email = clean(req.body.email, 150).toLowerCase();
    const fullName = clean(req.body.fullName, 150);
    if (!email || !fullName) return res.status(400).json({ error: 'Email and full name are required.' });
    if (db.prepare('SELECT id FROM staff WHERE lower(email) = lower(?)').get(email)) {
      return res.status(409).json({ error: 'A staff account already exists for this email.' });
    }
    const inviteCode = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO staff_invites (email, full_name, invite_code, used)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(email) DO UPDATE SET full_name = excluded.full_name, invite_code = excluded.invite_code, used = 0, created_at = CURRENT_TIMESTAMP
    `).run(email, fullName, inviteCode);
    return res.json({ success: true, inviteCode, message: 'Lecturer invite generated.' });
  } catch (error) {
    console.error('Invite error:', error);
    return res.status(500).json({ error: 'Unable to create the invite.' });
  }
});

router.post('/admin/accept-invite', async (req, res) => {
  try {
    const inviteCode = clean(req.body.inviteCode, 150);
    const password = String(req.body.password || '');
    if (!inviteCode || !password) return res.status(400).json({ error: 'Invite code and password are required.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const invite = db.prepare('SELECT * FROM staff_invites WHERE invite_code = ? AND used = 0').get(inviteCode);
    if (!invite) return res.status(403).json({ error: 'This invite code is invalid or has already been used.' });
    if (db.prepare('SELECT id FROM staff WHERE lower(email) = lower(?)').get(invite.email)) {
      return res.status(409).json({ error: 'A staff account already exists for this email.' });
    }

    const { salt, hash } = await hashPassword(password);
    const loginCode = `DS-LEC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO staff (email, full_name, role, login_code, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(invite.email, invite.full_name, 'lecturer', loginCode, salt, hash);
      db.prepare('UPDATE staff_invites SET used = 1 WHERE id = ?').run(invite.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return res.json({ success: true, message: `Account created. Your staff login code is ${loginCode}. You can also log in with your email.` });
  } catch (error) {
    console.error('Accept invite error:', error);
    return res.status(500).json({ error: 'Unable to create the staff account.' });
  }
});

router.get('/session', (req, res) => {
  if (req.session?.studentId) {
    return res.json({ authenticated: true, role: 'student', userId: req.session.studentId, name: req.session.studentName });
  }
  if (req.session?.staffId) {
    return res.json({ authenticated: true, role: req.session.staffRole, userId: req.session.staffId, name: req.session.staffName, preview: true });
  }
  return res.json({ authenticated: false });
});

module.exports = router;
