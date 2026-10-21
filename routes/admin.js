const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { db, normalizeReg } = require('../lib/db');
const { requireStaff, requireHod } = require('../lib/auth');
const { createRoomKey, getSessionById, rowToSession, createEventLog, toStoredStatus } = require('../lib/live');
const { hashPassword, makeTemporaryPassword } = require('../lib/password');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
router.use(requireStaff);

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function isWebUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function removeStoredFile(storedName) {
  if (!storedName) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(storedName));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'image/jpeg',
  'image/png'
]);

function decodeUpload(fileData, originalName, mimeType) {
  if (!fileData) return null;
  const match = String(fileData).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('The uploaded file data is invalid.');
  const detectedMime = match[1].toLowerCase();
  if (!ALLOWED_MIMES.has(detectedMime)) throw new Error('Only PDF, Word, PowerPoint, Excel, text and image files are allowed.');
  const buffer = Buffer.from(match[2], 'base64');
  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('The file must be between 1 byte and 100 MB.');
  const safeExtension = path.extname(originalName || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExtension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);
  return { storedName, mimeType: mimeType || detectedMime, sizeBytes: buffer.length };
}

function saveBufferUpload(buffer, originalName, mimeType) {
  const detectedMime = String(mimeType || '').toLowerCase();
  if (!ALLOWED_MIMES.has(detectedMime)) throw new Error('Only PDF, Word, PowerPoint, Excel, text and image files are allowed.');
  const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
  if (!buffer?.length || buffer.length > MAX_BYTES) throw new Error('The file must be between 1 byte and 100 MB.');
  const safeExtension = path.extname(originalName || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExtension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);
  return { storedName, mimeType: detectedMime, sizeBytes: buffer.length };
}

router.get('/me', (req, res) => {
  const staff = db.prepare('SELECT id, full_name, email, role, login_code, created_at FROM staff WHERE id = ?').get(req.session.staffId);
  return res.json({ staff });
});

router.get('/overview', (req, res) => {
  const data = {
    allowedStudents: db.prepare('SELECT COUNT(*) AS count FROM allowed_students').get().count,
    registeredStudents: db.prepare('SELECT COUNT(*) AS count FROM students').get().count,
    announcements: db.prepare('SELECT COUNT(*) AS count FROM announcements').get().count,
    materials: db.prepare('SELECT COUNT(*) AS count FROM materials').get().count,
    courses: db.prepare('SELECT COUNT(*) AS count FROM courses').get().count,
    liveClasses: db.prepare("SELECT COUNT(*) AS count FROM live_classes WHERE status IN ('scheduled','live')").get().count
  };
  return res.json(data);
});

router.get('/announcements', (req, res) => {
  const rows = db.prepare('SELECT * FROM announcements ORDER BY datetime(created_at) DESC, id DESC').all();
  return res.json({ announcements: rows });
});

router.post('/announcements', (req, res) => {
  const title = clean(req.body.title, 180);
  const body = clean(req.body.body, 5000);
  const destination = clean(req.body.destination, 20);
  const audienceType = clean(req.body.audienceType || 'all_students', 30).toLowerCase();
  const audienceLevels = Array.isArray(req.body.audienceLevels) ? req.body.audienceLevels : (req.body.audienceLevels ? String(req.body.audienceLevels).split(',') : []);
  const audienceStudent = clean(req.body.audienceStudent, 200);
  const attachmentUrl = clean(req.body.attachmentUrl, 1000);
  const attachmentLabel = clean(req.body.attachmentLabel, 200);

  if (!title || !body) return res.status(400).json({ error: 'Title and message are required.' });
  if (!['public', 'student', 'both'].includes(destination)) return res.status(400).json({ error: 'Choose a valid announcement destination.' });

  const validAudienceTypes = new Set(['all_students', 'specific_level', 'multiple_levels', 'single_student']);
  if (!validAudienceTypes.has(audienceType)) return res.status(400).json({ error: 'Choose a valid announcement audience.' });

  if (['specific_level', 'multiple_levels'].includes(audienceType) && !audienceLevels.length) {
    return res.status(400).json({ error: 'Select at least one target level.' });
  }
  if (audienceType === 'single_student' && !audienceStudent) {
    return res.status(400).json({ error: 'Enter the student name or registration number.' });
  }

  const levelsText = Array.isArray(audienceLevels) ? audienceLevels.map((value) => clean(value, 30)).filter(Boolean).join(',') : '';
  const result = db.prepare('INSERT INTO announcements (title, body, destination, author_name, audience_type, audience_levels, audience_student, attachment_url, attachment_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(title, body, destination, req.session.staffName || 'Department Staff', audienceType, levelsText, audienceStudent, attachmentUrl, attachmentLabel);
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(Number(result.lastInsertRowid));
  return res.status(201).json({ success: true, announcement });
});

router.put('/announcements/:id', (req, res) => {
  const id = Number(req.params.id);
  const title = clean(req.body.title, 180);
  const body = clean(req.body.body, 5000);
  const destination = clean(req.body.destination, 20);
  const audienceType = clean(req.body.audienceType || 'all_students', 30).toLowerCase();
  const audienceLevels = Array.isArray(req.body.audienceLevels) ? req.body.audienceLevels : (req.body.audienceLevels ? String(req.body.audienceLevels).split(',') : []);
  const audienceStudent = clean(req.body.audienceStudent, 200);
  const attachmentUrl = clean(req.body.attachmentUrl, 1000);
  const attachmentLabel = clean(req.body.attachmentLabel, 200);
  if (!title || !body || !['public', 'student', 'both'].includes(destination)) return res.status(400).json({ error: 'Complete all announcement fields.' });
  const validAudienceTypes = new Set(['all_students', 'specific_level', 'multiple_levels', 'single_student']);
  if (!validAudienceTypes.has(audienceType)) return res.status(400).json({ error: 'Choose a valid announcement audience.' });
  if (['specific_level', 'multiple_levels'].includes(audienceType) && !audienceLevels.length) return res.status(400).json({ error: 'Select at least one target level.' });
  if (audienceType === 'single_student' && !audienceStudent) return res.status(400).json({ error: 'Enter the student name or registration number.' });
  const levelsText = Array.isArray(audienceLevels) ? audienceLevels.map((value) => clean(value, 30)).filter(Boolean).join(',') : '';
  const result = db.prepare('UPDATE announcements SET title = ?, body = ?, destination = ?, audience_type = ?, audience_levels = ?, audience_student = ?, attachment_url = ?, attachment_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(title, body, destination, audienceType, levelsText, audienceStudent, attachmentUrl, attachmentLabel, id);
  if (!result.changes) return res.status(404).json({ error: 'Announcement not found.' });
  return res.json({ success: true });
});

router.delete('/announcements/:id', (req, res) => {
  const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Announcement not found.' });
  return res.json({ success: true });
});

router.get('/materials', (req, res) => {
  const rows = db.prepare('SELECT * FROM materials ORDER BY datetime(created_at) DESC, id DESC').all();
  return res.json({ materials: rows });
});

router.post('/materials', upload.single('materialFile'), (req, res) => {
  try {
    const courseCode = clean(req.body.courseCode, 60).toUpperCase();
    const title = clean(req.body.title, 180);
    const level = clean(req.body.level, 30);
    const description = clean(req.body.description, 3000);
    const resourceUrl = clean(req.body.resourceUrl, 1000);
    if (!courseCode || !title || !level) return res.status(400).json({ error: 'Course code, title and level are required.' });
    if (!req.file && !req.body.fileData && !resourceUrl) return res.status(400).json({ error: 'Choose a file or enter a material link.' });
    if (!isWebUrl(resourceUrl)) return res.status(400).json({ error: 'Material link must start with http:// or https://.' });

    let upload = null;
    let originalName = null;
    let mimeType = null;

    if (req.file) {
      originalName = clean(req.file.originalname, 255);
      mimeType = clean(req.file.mimetype, 150);
      upload = saveBufferUpload(req.file.buffer, originalName, mimeType);
    } else if (req.body.fileData) {
      originalName = clean(req.body.fileName, 255);
      mimeType = clean(req.body.mimeType, 150);
      upload = decodeUpload(req.body.fileData, originalName, mimeType);
    }

    const result = db.prepare(`
      INSERT INTO materials (course_code, title, level, description, stored_name, original_name, mime_type, size_bytes, resource_url, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      courseCode, title, level, description,
      upload?.storedName || null, originalName || null, upload?.mimeType || null, upload?.sizeBytes || 0,
      resourceUrl || null, req.session.staffName || 'Department Staff'
    );
    const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(result.lastInsertRowid));
    return res.status(201).json({ success: true, material });
  } catch (error) {
    console.error('Material upload error:', error);
    return res.status(400).json({ error: error.message || 'Unable to upload the material.' });
  }
});

router.delete('/materials/:id', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.status(404).json({ error: 'Material not found.' });
  db.prepare('DELETE FROM materials WHERE id = ?').run(material.id);
  removeStoredFile(material.stored_name);
  return res.json({ success: true });
});

router.get('/courses', (req, res) => {
  const rows = db.prepare('SELECT * FROM courses ORDER BY level, semester, sort_order, course_code').all();
  return res.json({ courses: rows });
});

router.post('/courses', (req, res) => {
  const semester = clean(req.body.semester, 100);
  const level = clean(req.body.level, 30);
  const courseCode = clean(req.body.courseCode, 60).toUpperCase();
  const courseTitle = clean(req.body.courseTitle, 180);
  const units = Number(req.body.units || 0);
  const readingGuide = clean(req.body.readingGuide, 2000);
  const sortOrder = Number(req.body.sortOrder || 0);
  if (!semester || !level || !courseCode || !courseTitle) return res.status(400).json({ error: 'Semester, level, course code and title are required.' });
  if (!Number.isInteger(units) || units < 0 || units > 20) return res.status(400).json({ error: 'Units must be between 0 and 20.' });
  try {
    const result = db.prepare(`
      INSERT INTO courses (semester, level, course_code, course_title, units, reading_guide, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(semester, level, courseCode, courseTitle, units, readingGuide, sortOrder);
    return res.status(201).json({ success: true, course: db.prepare('SELECT * FROM courses WHERE id = ?').get(Number(result.lastInsertRowid)) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: 'That course code already exists in the selected semester.' });
    throw error;
  }
});

router.put('/courses/:id', (req, res) => {
  const id = Number(req.params.id);
  const semester = clean(req.body.semester, 100);
  const level = clean(req.body.level, 30);
  const courseCode = clean(req.body.courseCode, 60).toUpperCase();
  const courseTitle = clean(req.body.courseTitle, 180);
  const units = Number(req.body.units || 0);
  const readingGuide = clean(req.body.readingGuide, 2000);
  const sortOrder = Number(req.body.sortOrder || 0);
  const result = db.prepare(`UPDATE courses SET semester = ?, level = ?, course_code = ?, course_title = ?, units = ?, reading_guide = ?, sort_order = ? WHERE id = ?`)
    .run(semester, level, courseCode, courseTitle, units, readingGuide, sortOrder, id);
  if (!result.changes) return res.status(404).json({ error: 'Course not found.' });
  return res.json({ success: true });
});

router.delete('/courses/:id', (req, res) => {
  const result = db.prepare('DELETE FROM courses WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Course not found.' });
  return res.json({ success: true });
});

router.get('/live-classes', (req, res) => {
  const rows = db.prepare('SELECT * FROM live_classes ORDER BY datetime(start_time) DESC, id DESC').all();
  return res.json({ liveClasses: rows.map(rowToSession) });
});

router.post('/live-classes', (req, res) => {
  const courseCode = clean(req.body.courseCode, 60).toUpperCase();
  const topic = clean(req.body.topic, 180);
  const title = clean(req.body.title || topic, 180);
  const type = clean(req.body.type, 20) || 'external';
  const startTime = clean(req.body.startTime, 50);
  const endTime = clean(req.body.endTime, 50);
  const joinLink = clean(req.body.joinLink, 1000);
  const recordingLink = clean(req.body.recordingLink, 1000);
  const details = clean(req.body.details, 3000);
  const audienceLevel = clean(req.body.audienceLevel, 30) || 'All Levels';
  const capacityLimit = req.body.capacityLimit ? Math.max(1, Number(req.body.capacityLimit)) : null;
  const attendanceThresholdMinutes = Math.max(0, Number(req.body.attendanceThresholdMinutes || 1));

  if (!['external', 'in-app'].includes(type)) return res.status(400).json({ error: 'Choose an external link or internal portal meeting.' });
  if (!courseCode || !topic || !startTime) return res.status(400).json({ error: 'Course, topic and start time are required.' });
  if (type === 'external' && !joinLink) return res.status(400).json({ error: 'External session join link is required.' });
  if (type === 'external' && !isWebUrl(joinLink)) return res.status(400).json({ error: 'Class join link must start with http:// or https://.' });
  if (recordingLink && !isWebUrl(recordingLink)) return res.status(400).json({ error: 'Recording link must start with http:// or https://.' });
  if (Number.isNaN(Date.parse(startTime))) return res.status(400).json({ error: 'Enter a valid start date and time.' });
  if (endTime && (Number.isNaN(Date.parse(endTime)) || Date.parse(endTime) <= Date.parse(startTime))) return res.status(400).json({ error: 'End time must be later than the start time.' });

  const result = db.prepare(`
    INSERT INTO live_classes
      (course_code, topic, title, start_time, end_time, type, provider_room_name, join_link, recording_link,
       details, status, capacity_limit, audience_level, attendance_threshold_minutes, host_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)
  `).run(
    courseCode,
    topic,
    title,
    new Date(startTime).toISOString(),
    endTime ? new Date(endTime).toISOString() : null,
    type,
    type === 'in-app' ? createRoomKey() : '',
    type === 'external' ? joinLink : '',
    recordingLink || '',
    details,
    capacityLimit,
    audienceLevel,
    attendanceThresholdMinutes,
    Number(req.session.staffId),
    req.session.staffName || 'Department Staff'
  );
  const liveClass = getSessionById(Number(result.lastInsertRowid));
  createEventLog(liveClass.id, 'session-created', req.session.staffId, null, { type, audienceLevel });
  return res.status(201).json({ success: true, liveClass });
});

router.put('/live-classes/:id', (req, res) => {
  const id = Number(req.params.id);
  const current = getSessionById(id);
  if (!current) return res.status(404).json({ error: 'Live class not found.' });
  let status = clean(req.body.status || current.status, 20);
  if (status === 'completed') status = 'ended';
  if (!['scheduled', 'live', 'ended', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid live class status.' });
  const joinLink = clean(req.body.joinLink ?? current.join_link, 1000);
  const recordingLink = clean(req.body.recordingLink ?? current.recording_link, 1000);
  if (current.type === 'external' && !isWebUrl(joinLink)) return res.status(400).json({ error: 'External link must start with http:// or https://.' });
  if (recordingLink && !isWebUrl(recordingLink)) return res.status(400).json({ error: 'Recording link must start with http:// or https://.' });
  const actualStart = status === 'live' && !current.actual_start ? new Date().toISOString() : current.actual_start;
  const endedAt = status === 'ended' && !current.ended_at ? new Date().toISOString() : current.ended_at;
  db.prepare(`UPDATE live_classes SET status = ?, join_link = ?, recording_link = ?, details = ?,
    actual_start = ?, ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(toStoredStatus(status), joinLink, recordingLink, clean(req.body.details ?? current.details, 3000), actualStart, endedAt, id);
  createEventLog(id, `session-${status}`, req.session.staffId, null, { source: 'admin-dashboard' });
  return res.json({ success: true, liveClass: getSessionById(id) });
});

router.delete('/live-classes/:id', (req, res) => {
  const result = db.prepare('DELETE FROM live_classes WHERE id = ?').run(Number(req.params.id));
  if (!result.changes) return res.status(404).json({ error: 'Live class not found.' });
  return res.json({ success: true });
});

router.get('/students', (req, res) => {
  const rows = db.prepare(`
    SELECT a.reg_number, COALESCE(s.full_name, a.full_name, '') AS full_name, s.email, s.phone, s.course, s.level, s.created_at,
           CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS registered
    FROM allowed_students a LEFT JOIN students s ON s.reg_number = a.reg_number
    ORDER BY a.reg_number
  `).all();
  return res.json({ students: rows });
});

router.post('/students/reset-password', requireHod, async (req, res) => {
  const regNumber = normalizeReg(req.body.regNumber);
  const student = db.prepare('SELECT id, full_name FROM students WHERE reg_number = ?').get(regNumber);
  if (!student) return res.status(404).json({ error: 'No registered student account was found for that registration number.' });
  const temporaryPassword = makeTemporaryPassword();
  const { salt, hash } = await hashPassword(temporaryPassword);
  db.prepare('UPDATE students SET password_salt = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(salt, hash, student.id);
  return res.json({ success: true, temporaryPassword, studentName: student.full_name, message: 'Password reset successfully. Give the temporary password directly to the student.' });
});

router.get('/staff', (req, res) => {
  const rows = db.prepare('SELECT id, full_name, email, role, login_code, created_at FROM staff ORDER BY CASE role WHEN \'hod\' THEN 0 ELSE 1 END, full_name').all();
  return res.json({ staff: rows });
});

module.exports = router;
