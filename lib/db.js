const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./password');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'db', 'portal.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

const schema = `
CREATE TABLE IF NOT EXISTS allowed_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_number TEXT NOT NULL UNIQUE,
  full_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_number TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT DEFAULT '',
  course TEXT NOT NULL DEFAULT 'B.Sc. Data Science',
  level TEXT NOT NULL DEFAULT '100L',
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (reg_number) REFERENCES allowed_students(reg_number)
);

CREATE TABLE IF NOT EXISTS phone_verifications (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('hod','lecturer')),
  login_code TEXT UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  destination TEXT NOT NULL CHECK(destination IN ('public','student','both')),
  author_name TEXT NOT NULL,
  audience_type TEXT NOT NULL DEFAULT 'all_students',
  audience_levels TEXT NOT NULL DEFAULT '',
  audience_student TEXT NOT NULL DEFAULT '',
  attachment_url TEXT DEFAULT '',
  attachment_label TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcement_reads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0,
  student_id INTEGER NOT NULL DEFAULT 0,
  read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(announcement_id, user_id),
  UNIQUE(announcement_id, student_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code TEXT NOT NULL,
  title TEXT NOT NULL,
  level TEXT NOT NULL,
  description TEXT DEFAULT '',
  stored_name TEXT,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER DEFAULT 0,
  resource_url TEXT,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester TEXT NOT NULL,
  level TEXT NOT NULL,
  course_code TEXT NOT NULL,
  course_title TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  reading_guide TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(semester, course_code)
);

CREATE TABLE IF NOT EXISTS live_classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_code TEXT NOT NULL,
  topic TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT,
  actual_start TEXT,
  ended_at TEXT,
  type TEXT NOT NULL DEFAULT 'external' CHECK(type IN ('external','in-app')),
  provider_room_name TEXT DEFAULT '',
  join_link TEXT,
  recording_link TEXT DEFAULT '',
  details TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','ended','cancelled')),
  capacity_limit INTEGER DEFAULT NULL,
  late_entry_cutoff TEXT DEFAULT NULL,
  allowed_student_ids TEXT DEFAULT '[]',
  blocked_student_ids TEXT DEFAULT '[]',
  host_id INTEGER,
  room_locked INTEGER NOT NULL DEFAULT 0,
  audience_level TEXT NOT NULL DEFAULT 'All Levels',
  attendance_threshold_minutes INTEGER NOT NULL DEFAULT 1,
  allow_student_mic INTEGER NOT NULL DEFAULT 1,
  allow_student_video INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('host','co-host','student')),
  join_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  leave_time TEXT DEFAULT NULL,
  duration_seconds INTEGER DEFAULT 0,
  is_late_entry INTEGER NOT NULL DEFAULT 0,
  late_entry_status TEXT NOT NULL DEFAULT 'pending' CHECK(late_entry_status IN ('pending','approved','denied')),
  mic_state TEXT NOT NULL DEFAULT 'unmuted',
  cam_state TEXT NOT NULL DEFAULT 'on',
  device_info TEXT DEFAULT '',
  user_type TEXT NOT NULL DEFAULT 'student',
  display_name TEXT DEFAULT '',
  registration_number TEXT DEFAULT '',
  email TEXT DEFAULT '',
  socket_id TEXT DEFAULT '',
  removal_reason TEXT DEFAULT '',
  removed_by INTEGER,
  hand_raised INTEGER NOT NULL DEFAULT 0,
  is_spotlighted INTEGER NOT NULL DEFAULT 0,
  attendance_source TEXT NOT NULL DEFAULT 'internal',
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES live_classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  reason TEXT DEFAULT '',
  removed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, student_id),
  FOREIGN KEY (session_id) REFERENCES live_classes(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_type TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES live_classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id INTEGER,
  target_id INTEGER,
  metadata TEXT DEFAULT '',
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES live_classes(id) ON DELETE CASCADE
);
`;

db.exec(schema);

function ensureColumn(table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn('live_classes', 'title', "TEXT NOT NULL DEFAULT ''");
ensureColumn('live_classes', 'actual_start', 'TEXT DEFAULT NULL');
ensureColumn('live_classes', 'ended_at', 'TEXT DEFAULT NULL');
ensureColumn('live_classes', 'type', "TEXT NOT NULL DEFAULT 'external'");
ensureColumn('live_classes', 'provider_room_name', "TEXT DEFAULT ''");
ensureColumn('live_classes', 'status', "TEXT NOT NULL DEFAULT 'scheduled'");
ensureColumn('live_classes', 'capacity_limit', 'INTEGER DEFAULT NULL');
ensureColumn('live_classes', 'late_entry_cutoff', 'TEXT DEFAULT NULL');
ensureColumn('live_classes', 'allowed_student_ids', "TEXT DEFAULT '[]'");
ensureColumn('live_classes', 'blocked_student_ids', "TEXT DEFAULT '[]'");
ensureColumn('live_classes', 'host_id', 'INTEGER');
ensureColumn('live_classes', 'room_locked', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('live_classes', 'audience_level', "TEXT NOT NULL DEFAULT 'All Levels'");
ensureColumn('live_classes', 'attendance_threshold_minutes', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('live_classes', 'allow_student_mic', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('live_classes', 'allow_student_video', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('live_classes', 'allow_student_share', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('announcements', 'audience_type', "TEXT NOT NULL DEFAULT 'all_students'");
ensureColumn('announcements', 'audience_levels', "TEXT NOT NULL DEFAULT ''");
ensureColumn('announcements', 'audience_student', "TEXT NOT NULL DEFAULT ''");
ensureColumn('announcements', 'attachment_url', "TEXT DEFAULT ''");
ensureColumn('announcements', 'attachment_label', "TEXT DEFAULT ''");

ensureColumn('announcement_reads', 'user_id', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('announcement_reads', 'announcement_id', 'INTEGER NOT NULL');
ensureColumn('announcement_reads', 'student_id', 'INTEGER NOT NULL DEFAULT 0');

ensureColumn('session_participants', 'user_type', "TEXT NOT NULL DEFAULT 'student'");
ensureColumn('session_participants', 'display_name', "TEXT DEFAULT ''");
ensureColumn('session_participants', 'registration_number', "TEXT DEFAULT ''");
ensureColumn('session_participants', 'email', "TEXT DEFAULT ''");
ensureColumn('session_participants', 'socket_id', "TEXT DEFAULT ''");
ensureColumn('session_participants', 'removal_reason', "TEXT DEFAULT ''");
ensureColumn('session_participants', 'removed_by', 'INTEGER');
ensureColumn('session_participants', 'hand_raised', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('session_participants', 'is_spotlighted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('session_participants', 'attendance_source', "TEXT NOT NULL DEFAULT 'internal'");
ensureColumn('session_participants', 'last_seen_at', "TEXT DEFAULT ''");

function normalizeReg(value = '') {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeLevelValue(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return 'All Levels';
  const normalized = raw.toUpperCase().replace(/\s+/g, ' ');
  if (normalized === 'ALL LEVELS' || normalized === 'ALL') return 'All Levels';
  const match = normalized.match(/^(\d+)\s*L$/) || normalized.match(/^(\d+)\s*LEVEL$/) || normalized.match(/^(\d+)$/);
  if (match) return `${match[1]}L`;
  return raw.trim();
}

function parseLevelList(rawLevels) {
  if (Array.isArray(rawLevels)) {
    return [...new Set(rawLevels.map((value) => normalizeLevelValue(value)).filter((value) => value && value !== 'All Levels' && /^\d+L$/.test(value)))];
  }
  return [...new Set(String(rawLevels || '')
    .split(/[;,|]/)
    .map((value) => normalizeLevelValue(value))
    .filter((value) => value && value !== 'All Levels' && /^\d+L$/.test(value)))];
}

function materialVisibleToStudent(material, student) {
  if (!material) return false;
  const materialLevel = normalizeLevelValue(material.level);
  if (materialLevel === 'All Levels') return true;
  if (!student) return false;
  return normalizeLevelValue(student.level) === materialLevel;
}

function announcementVisibleToStudent(announcement, student) {
  if (!announcement) return false;
  if (!student) return false;
  const audienceType = String(announcement.audience_type || '').toLowerCase();
  if (!audienceType && ['student', 'both'].includes(String(announcement.destination || '').toLowerCase())) return true;
  if (audienceType === 'all_students') return true;
  if (audienceType === 'single_student') {
    const target = String(announcement.audience_student || '').trim().toLowerCase();
    if (!target) return false;
    const studentName = String(student.full_name || '').trim().toLowerCase();
    const studentReg = normalizeReg(student.reg_number || '').toLowerCase();
    return target === studentReg || target === studentName || studentName.includes(target) || target.includes(studentName);
  }
  const levels = parseLevelList(announcement.audience_levels || announcement.target_level || announcement.level);
  if (!levels.length && audienceType === 'multiple_levels') return false;
  return levels.includes(normalizeLevelValue(student.level));
}

async function seedAllowedStudents() {
  const csvPath = path.join(ROOT, 'db', 'allowed_students.csv');
  if (!fs.existsSync(csvPath)) return;
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const insert = db.prepare('INSERT OR IGNORE INTO allowed_students (reg_number) VALUES (?)');
  db.exec('BEGIN');
  try {
    for (const line of lines.slice(1)) insert.run(normalizeReg(line));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const initialStaff = [
  { fullName: 'Dr. Uduak D. George', role: 'hod', email: 'hod@datascience.uniuyo.edu.ng', code: 'DS-ADM-001-XN29', password: 'HODDataSci01!' },
  { fullName: 'Dr. Samuel S. Udoh', role: 'lecturer', email: 's.udoh@uniuyo.edu.ng', code: 'DS-ADM-002-KP57', password: 'UdohDataSci02!' },
  { fullName: 'Prof. Udoinyang G. Inyang', role: 'lecturer', email: 'u.inyang@uniuyo.edu.ng', code: 'DS-ADM-003-HM84', password: 'InyangDataSci03!' },
  { fullName: 'Mr. Emmanuel Ambrose Dan', role: 'lecturer', email: 'e.dan@uniuyo.edu.ng', code: 'DS-ADM-004-ZQ62', password: 'DanDataSci04!' }
];

async function seedStaff() {
  const find = db.prepare('SELECT id FROM staff WHERE login_code = ? OR email = ?');
  const insert = db.prepare('INSERT INTO staff (email, full_name, role, login_code, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?)');
  for (const member of initialStaff) {
    if (find.get(member.code, member.email)) continue;
    const { salt, hash } = await hashPassword(member.password);
    insert.run(member.email, member.fullName, member.role, member.code, salt, hash);
  }
}

function seedContent() {
  const announcementCount = db.prepare('SELECT COUNT(*) AS count FROM announcements').get().count;
  if (!announcementCount) {
    const insert = db.prepare('INSERT INTO announcements (title, body, destination, author_name, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('Departmental Seminar Series — Session 1', 'Faculty of Computing Auditorium | 10:00 AM', 'public', 'Department Admin', '2026-08-15T09:00:00.000Z');
    insert.run('B.Sc. Final Year Project Presentation', 'Data Science Lab | 9:00 AM – 5:00 PM', 'public', 'Department Admin', '2026-09-02T08:00:00.000Z');
    insert.run('Industry Guest Lecture — AI in Nigerian FinTech', 'Faculty Lecture Hall 1 | 2:00 PM', 'public', 'Department Admin', '2026-09-20T13:00:00.000Z');
    insert.run('Course Registration Notice', '2025/2026 First Semester course registration is open. Complete registration within two weeks of resumption.', 'student', 'Department Admin', '2026-06-01T09:00:00.000Z');
  }

  const courseCount = db.prepare('SELECT COUNT(*) AS count FROM courses').get().count;
  if (!courseCount) {
    const insert = db.prepare('INSERT INTO courses (semester, level, course_code, course_title, units, reading_guide, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const rows = [
      ['100L First Semester', '100L', 'UUY-DTS 111', 'Introduction to Data Science', 2, '', 1],
      ['100L First Semester', '100L', 'UUY-DTS 113', 'Introduction to Programming', 3, '', 2],
      ['100L First Semester', '100L', 'MTH 111', 'Elementary Mathematics I', 3, '', 3],
      ['100L Second Semester', '100L', 'UUY-DTS 112', 'Introduction to Database Technology', 2, '', 1],
      ['100L Second Semester', '100L', 'UUY-DTS 114', 'Data Structures and Algorithms', 3, '', 2]
    ];
    for (const row of rows) insert.run(...row);
  }
}

async function initDatabase() {
  await seedAllowedStudents();
  await seedStaff();
  seedContent();
}

module.exports = {
  db,
  initDatabase,
  normalizeReg,
  normalizeLevelValue,
  parseLevelList,
  materialVisibleToStudent,
  announcementVisibleToStudent,
  DB_PATH
};
