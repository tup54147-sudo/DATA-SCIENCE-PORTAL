const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, normalizeLevelValue, materialVisibleToStudent, announcementVisibleToStudent } = require('../lib/db');
const { rowToSession } = require('../lib/live');
const { requirePortalUser, requireStudent } = require('../lib/auth');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

function clean(value, max = 255) {
  return String(value || '').trim().slice(0, max);
}

function hydrateAnnouncementReadState(item, studentId) {
  const readCount = db.prepare('SELECT COUNT(*) AS count FROM announcement_reads WHERE announcement_id = ?').get(item.id).count;
  const isRead = studentId ? !!db.prepare('SELECT 1 FROM announcement_reads WHERE announcement_id = ? AND (user_id = ? OR student_id = ?) LIMIT 1').get(item.id, studentId, studentId) : false;
  return { ...item, read_count: Number(readCount || 0), is_read: Boolean(isRead) };
}

function getStudentLevel(student) {
  return student ? normalizeLevelValue(student.level) : null;
}

function getVisibleMaterialsForStudent(student, requestedLevel, isStaffPreview = false) {
  const studentLevel = getStudentLevel(student);
  if (isStaffPreview) return db.prepare('SELECT id, course_code, title, level, description, original_name, mime_type, size_bytes, resource_url, uploaded_by, created_at FROM materials ORDER BY datetime(created_at) DESC, id DESC').all();
  if (!studentLevel) return db.prepare('SELECT id, course_code, title, level, description, original_name, mime_type, size_bytes, resource_url, uploaded_by, created_at FROM materials WHERE level = "All Levels" ORDER BY datetime(created_at) DESC, id DESC').all();
  const requested = normalizeLevelValue(requestedLevel || studentLevel);
  if (requested !== 'All Levels' && requested !== studentLevel) return [];
  const rows = db.prepare('SELECT id, course_code, title, level, description, original_name, mime_type, size_bytes, resource_url, uploaded_by, created_at FROM materials ORDER BY datetime(created_at) DESC, id DESC').all();
  return rows.filter((item) => materialVisibleToStudent(item, student));
}

function getVisibleAnnouncementsForStudent(student, requestedLevel, isStaffPreview = false) {
  if (isStaffPreview) {
    return db.prepare("SELECT * FROM announcements WHERE destination IN ('student','both') ORDER BY datetime(created_at) DESC, id DESC").all().map((item) => hydrateAnnouncementReadState(item, student?.id || null));
  }
  const studentLevel = getStudentLevel(student);
  const rows = db.prepare("SELECT * FROM announcements WHERE destination IN ('student','both') ORDER BY datetime(created_at) DESC, id DESC").all();
  if (!student) return [];
  const requested = normalizeLevelValue(requestedLevel || studentLevel || 'All Levels');
  if (requested !== 'All Levels' && studentLevel && requested !== studentLevel) return [];
  return rows.filter((item) => announcementVisibleToStudent(item, student)).map((item) => hydrateAnnouncementReadState(item, student.id));
}

router.use(requirePortalUser);

router.get('/me', (req, res) => {
  if (req.session.studentId) {
    const student = db.prepare('SELECT id, reg_number, full_name, email, phone, course, level, created_at, updated_at FROM students WHERE id = ?').get(req.session.studentId);
    if (!student) return res.status(404).json({ error: 'Student account not found.' });
    return res.json({ role: 'student', student });
  }
  const staff = db.prepare('SELECT id, full_name, email, role FROM staff WHERE id = ?').get(req.session.staffId);
  return res.json({ role: 'staff-preview', staff, student: { full_name: `${staff?.full_name || 'Staff'} (Student View)`, reg_number: 'ADMIN PREVIEW', email: staff?.email || '', phone: '', course: 'B.Sc. Data Science', level: 'All Levels' } });
});

router.put('/profile', requireStudent, (req, res) => {
  const fullName = clean(req.body.fullName, 150);
  const course = clean(req.body.course, 150) || 'B.Sc. Data Science';
  const level = clean(req.body.level, 20) || '100L';
  if (!fullName) return res.status(400).json({ error: 'Full name is required.' });
  db.prepare('UPDATE students SET full_name = ?, course = ?, level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(fullName, course, level, req.session.studentId);
  req.session.studentName = fullName;
  return res.json({ success: true, message: 'Profile updated.' });
});

router.get('/dashboard', (req, res) => {
  const student = req.session.studentId ? db.prepare('SELECT id, reg_number, full_name, email, phone, course, level, created_at, updated_at FROM students WHERE id = ?').get(req.session.studentId) : null;
  const isStaffPreview = !!req.session.staffId && !req.session.studentId;
  const announcements = getVisibleAnnouncementsForStudent(student, null, isStaffPreview).slice(0, 5);
  const materials = getVisibleMaterialsForStudent(student, null, isStaffPreview).slice(0, 6);
  const liveClasses = db.prepare("SELECT * FROM live_classes WHERE status != 'cancelled' ORDER BY datetime(start_time) ASC, id ASC LIMIT 8").all();
  const counts = {
    announcements: getVisibleAnnouncementsForStudent(student, null, isStaffPreview).length,
    materials: getVisibleMaterialsForStudent(student, null, isStaffPreview).length,
    courses: db.prepare('SELECT COUNT(*) AS count FROM courses').get().count,
    liveClasses: db.prepare("SELECT COUNT(*) AS count FROM live_classes WHERE status IN ('scheduled','live')").get().count
  };
  return res.json({ announcements, materials, liveClasses, counts });
});

router.get('/announcements', (req, res) => {
  const student = req.session.studentId ? db.prepare('SELECT id, reg_number, full_name, email, phone, course, level, created_at, updated_at FROM students WHERE id = ?').get(req.session.studentId) : null;
  const isStaffPreview = !!req.session.staffId && !req.session.studentId;
  const requestedLevel = clean(req.query.level, 30);
  const rows = getVisibleAnnouncementsForStudent(student, requestedLevel, isStaffPreview);
  return res.json({ announcements: rows });
});

router.post('/announcements/:id/read', requireStudent, (req, res) => {
  const announcementId = Number(req.params.id);
  const studentId = Number(req.session.studentId);
  if (!announcementId || !studentId) return res.status(400).json({ error: 'Announcement or student is invalid.' });
  const existing = db.prepare('SELECT id FROM announcement_reads WHERE announcement_id = ? AND (user_id = ? OR student_id = ?) LIMIT 1').get(announcementId, studentId, studentId);
  if (!existing) {
    db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id, student_id) VALUES (?, ?, ?)').run(announcementId, studentId, studentId);
  }
  const count = db.prepare('SELECT COUNT(*) AS count FROM announcement_reads WHERE announcement_id = ?').get(announcementId).count;
  return res.json({ success: true, read: true, count });
});

router.get('/materials', (req, res) => {
  const student = req.session.studentId ? db.prepare('SELECT id, reg_number, full_name, email, phone, course, level, created_at, updated_at FROM students WHERE id = ?').get(req.session.studentId) : null;
  const isStaffPreview = !!req.session.staffId && !req.session.studentId;
  const requestedLevel = clean(req.query.level, 30);
  const course = clean(req.query.course, 60);
  const rows = getVisibleMaterialsForStudent(student, requestedLevel, isStaffPreview).filter((item) => {
    if (course) {
      const match = `${item.course_code || ''} ${item.title || ''}`.toUpperCase();
      return match.includes(course.toUpperCase());
    }
    return true;
  });
  return res.json({ materials: rows });
});

router.get('/materials/:id/download', (req, res) => {
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(Number(req.params.id));
  if (!material) return res.status(404).json({ error: 'Material not found.' });
  const student = req.session.studentId ? db.prepare('SELECT id, reg_number, full_name, email, phone, course, level, created_at, updated_at FROM students WHERE id = ?').get(req.session.studentId) : null;
  const isStaffPreview = !!req.session.staffId && !req.session.studentId;
  const allowed = isStaffPreview || materialVisibleToStudent(material, student);
  if (!allowed) return res.status(403).json({ error: 'This material is not available for your level.' });
  if (!material.stored_name) {
    if (material.resource_url) return res.redirect(material.resource_url);
    return res.status(404).json({ error: 'No downloadable file is attached to this material.' });
  }
  const filePath = path.join(UPLOAD_DIR, path.basename(material.stored_name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'The uploaded file could not be found.' });
  return res.download(filePath, material.original_name || material.stored_name);
});

router.get('/courses', (req, res) => {
  const rows = db.prepare('SELECT * FROM courses ORDER BY level, semester, sort_order, course_code').all();
  const grouped = rows.reduce((acc, row) => {
    if (!acc[row.semester]) acc[row.semester] = [];
    acc[row.semester].push(row);
    return acc;
  }, {});
  return res.json({ courses: rows, grouped });
});

router.get('/live-classes', (req, res) => {
  const rows = db.prepare("SELECT * FROM live_classes WHERE status != 'cancelled' ORDER BY datetime(start_time) DESC, id DESC").all();
  return res.json({ liveClasses: rows.map(rowToSession) });
});

module.exports = router;
