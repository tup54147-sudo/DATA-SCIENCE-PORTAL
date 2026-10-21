const crypto = require('crypto');
const { db } = require('./db');

function clean(value, max = 255) {
  return String(value ?? '').trim().slice(0, max);
}

function parseIds(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function serializeIds(ids) {
  return JSON.stringify(Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : []);
}

const liveClassSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'live_classes'").get()?.sql || '';
const usesLegacyCompletedStatus = liveClassSql.includes("'completed'");

function toStoredStatus(status) {
  return status === 'ended' && usesLegacyCompletedStatus ? 'completed' : status;
}

function rowToSession(row) {
  if (!row) return null;
  return {
    ...row,
    status: row.status === 'completed' ? 'ended' : row.status,
    allowed_student_ids: parseIds(row.allowed_student_ids),
    blocked_student_ids: parseIds(row.blocked_student_ids),
    room_locked: Number(row.room_locked || 0),
    allow_student_mic: Number(row.allow_student_mic ?? 1),
    allow_student_video: Number(row.allow_student_video ?? 1),
    allow_student_share: Number(row.allow_student_share ?? 0)
  };
}

function createRoomKey() {
  return `dsp-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function getSessionById(sessionId) {
  return rowToSession(db.prepare('SELECT * FROM live_classes WHERE id = ?').get(Number(sessionId)));
}

function getIdentityFromRequestSession(session = {}) {
  if (session.staffId) {
    const staff = db.prepare('SELECT id, full_name, email, role FROM staff WHERE id = ?').get(Number(session.staffId));
    if (!staff) return null;
    return {
      userId: staff.id,
      userType: 'staff',
      displayName: staff.full_name,
      email: staff.email || '',
      registrationNumber: '',
      staffRole: staff.role,
      level: ''
    };
  }
  if (session.studentId) {
    const student = db.prepare('SELECT id, full_name, email, reg_number, level FROM students WHERE id = ?').get(Number(session.studentId));
    if (!student) return null;
    return {
      userId: student.id,
      userType: 'student',
      displayName: student.full_name,
      email: student.email || '',
      registrationNumber: student.reg_number || '',
      staffRole: '',
      level: student.level || ''
    };
  }
  return null;
}

function roleForSession(session, identity) {
  if (!identity) return null;
  if (identity.userType === 'student') return 'student';
  return Number(session.host_id) === Number(identity.userId) ? 'host' : 'co-host';
}

function isModeratorRole(role) {
  return role === 'host' || role === 'co-host';
}

function isStudentBanned(sessionId, studentId) {
  return Boolean(db.prepare('SELECT id FROM session_bans WHERE session_id = ? AND student_id = ?').get(Number(sessionId), Number(studentId)));
}

function getActiveParticipant(sessionId, userId, userType = null) {
  if (userType) {
    return db.prepare('SELECT * FROM session_participants WHERE session_id = ? AND user_id = ? AND user_type = ? AND leave_time IS NULL ORDER BY id DESC LIMIT 1')
      .get(Number(sessionId), Number(userId), userType);
  }
  return db.prepare('SELECT * FROM session_participants WHERE session_id = ? AND user_id = ? AND leave_time IS NULL ORDER BY id DESC LIMIT 1')
    .get(Number(sessionId), Number(userId));
}

function createOrUpdateParticipant({
  sessionId,
  identity,
  role,
  socketId = '',
  micState = 'unmuted',
  camState = 'on',
  deviceInfo = '',
  attendanceSource = 'internal',
  isLateEntry = false,
  lateEntryStatus = 'approved'
}) {
  const current = getActiveParticipant(sessionId, identity.userId, identity.userType);
  if (current) {
    db.prepare(`UPDATE session_participants SET role = ?, socket_id = ?, mic_state = ?, cam_state = ?, device_info = ?,
      display_name = ?, registration_number = ?, email = ?, attendance_source = ?, is_late_entry = ?, late_entry_status = ?,
      last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(role, socketId, micState, camState, deviceInfo, identity.displayName, identity.registrationNumber,
        identity.email, attendanceSource, isLateEntry ? 1 : 0, lateEntryStatus, current.id);
    return db.prepare('SELECT * FROM session_participants WHERE id = ?').get(current.id);
  }

  const result = db.prepare(`INSERT INTO session_participants
    (session_id, user_id, role, is_late_entry, late_entry_status, mic_state, cam_state, device_info,
     user_type, display_name, registration_number, email, socket_id, attendance_source, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(Number(sessionId), Number(identity.userId), role, isLateEntry ? 1 : 0, lateEntryStatus,
      micState, camState, clean(deviceInfo, 1000), identity.userType, clean(identity.displayName, 180),
      clean(identity.registrationNumber, 100), clean(identity.email, 180), clean(socketId, 180), attendanceSource);
  return db.prepare('SELECT * FROM session_participants WHERE id = ?').get(Number(result.lastInsertRowid));
}

function endParticipantById(participantId, extra = {}) {
  const participant = db.prepare('SELECT * FROM session_participants WHERE id = ?').get(Number(participantId));
  if (!participant || participant.leave_time) return participant || null;
  const leaveTime = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(participant.join_time).getTime()) / 1000));
  db.prepare(`UPDATE session_participants SET leave_time = ?, duration_seconds = ?, socket_id = '',
    removal_reason = ?, removed_by = ?, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(leaveTime, durationSeconds, clean(extra.removalReason, 500), extra.removedBy ? Number(extra.removedBy) : null, participant.id);
  return db.prepare('SELECT * FROM session_participants WHERE id = ?').get(participant.id);
}

function endParticipant(sessionId, userId, userType = null, extra = {}) {
  const participant = getActiveParticipant(sessionId, userId, userType);
  return participant ? endParticipantById(participant.id, extra) : null;
}

function touchParticipant(participantId) {
  db.prepare('UPDATE session_participants SET last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(Number(participantId));
}

function updateParticipantById(participantId, updates = {}) {
  const allowed = new Map([
    ['mic_state', (v) => clean(v, 20)],
    ['cam_state', (v) => clean(v, 20)],
    ['late_entry_status', (v) => clean(v, 20)],
    ['is_late_entry', (v) => v ? 1 : 0],
    ['hand_raised', (v) => v ? 1 : 0],
    ['is_spotlighted', (v) => v ? 1 : 0],
    ['socket_id', (v) => clean(v, 180)],
    ['removal_reason', (v) => clean(v, 500)],
    ['removed_by', (v) => v ? Number(v) : null]
  ]);
  const fields = [];
  const values = [];
  for (const [key, transform] of allowed.entries()) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      fields.push(`${key} = ?`);
      values.push(transform(updates[key]));
    }
  }
  if (!fields.length) return db.prepare('SELECT * FROM session_participants WHERE id = ?').get(Number(participantId));
  fields.push('last_seen_at = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP');
  values.push(Number(participantId));
  db.prepare(`UPDATE session_participants SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM session_participants WHERE id = ?').get(Number(participantId));
}

function participantToPublic(row, includePrivate = false) {
  if (!row) return null;
  const base = {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    userType: row.user_type,
    role: row.role,
    displayName: row.display_name || (row.role === 'student' ? `Student ${row.user_id}` : `Staff ${row.user_id}`),
    registrationNumber: row.registration_number || '',
    socketId: row.socket_id || '',
    joinTime: row.join_time,
    leaveTime: row.leave_time,
    durationSeconds: Number(row.duration_seconds || 0),
    micState: row.mic_state,
    camState: row.cam_state,
    handRaised: Boolean(row.hand_raised),
    spotlighted: Boolean(row.is_spotlighted),
    removed: Boolean(row.removal_reason),
    removalReason: row.removal_reason || '',
    isLateEntry: Boolean(row.is_late_entry),
    lateEntryStatus: row.late_entry_status,
    attendanceSource: row.attendance_source
  };
  if (includePrivate) base.email = row.email || '';
  return base;
}

function getParticipantList(sessionId, includeLeft = false, includePrivate = false) {
  const sql = includeLeft
    ? 'SELECT * FROM session_participants WHERE session_id = ? ORDER BY datetime(join_time) ASC, id ASC'
    : 'SELECT * FROM session_participants WHERE session_id = ? AND leave_time IS NULL ORDER BY CASE role WHEN \'host\' THEN 0 WHEN \'co-host\' THEN 1 ELSE 2 END, datetime(join_time) ASC';
  return db.prepare(sql).all(Number(sessionId)).map((row) => participantToPublic(row, includePrivate));
}

function createEventLog(sessionId, type, actorId = null, targetId = null, metadata = {}) {
  let encoded = '';
  try { encoded = typeof metadata === 'string' ? metadata : JSON.stringify(metadata || {}); }
  catch { encoded = ''; }
  db.prepare('INSERT INTO session_event_logs (session_id, type, actor_id, target_id, metadata) VALUES (?, ?, ?, ?, ?)')
    .run(Number(sessionId), clean(type, 100), actorId ? Number(actorId) : null, targetId ? Number(targetId) : null, encoded);
}

function addChatMessage(sessionId, identity, role, message) {
  const result = db.prepare(`INSERT INTO session_chat_messages
    (session_id, user_id, user_type, role, display_name, message) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(Number(sessionId), Number(identity.userId), identity.userType, role, clean(identity.displayName, 180), clean(message, 1000));
  return db.prepare('SELECT * FROM session_chat_messages WHERE id = ?').get(Number(result.lastInsertRowid));
}

function getChatMessages(sessionId, limit = 100) {
  return db.prepare(`SELECT id, user_id AS userId, user_type AS userType, role, display_name AS displayName,
    message, created_at AS createdAt FROM session_chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
    .all(Number(sessionId), Math.min(250, Math.max(1, Number(limit) || 100))).reverse();
}

function getExpectedStudents(session) {
  const allowedIds = parseIds(session.allowed_student_ids);
  if (allowedIds.length) {
    const placeholders = allowedIds.map(() => '?').join(',');
    return db.prepare(`SELECT id, full_name, reg_number, email, level FROM students WHERE id IN (${placeholders}) ORDER BY reg_number`).all(...allowedIds);
  }
  if (session.audience_level && session.audience_level !== 'All Levels') {
    return db.prepare('SELECT id, full_name, reg_number, email, level FROM students WHERE level = ? ORDER BY reg_number').all(session.audience_level);
  }
  return db.prepare('SELECT id, full_name, reg_number, email, level FROM students ORDER BY reg_number').all();
}

function buildAttendanceReport(sessionId) {
  const session = getSessionById(sessionId);
  if (!session) return null;
  const rows = db.prepare('SELECT * FROM session_participants WHERE session_id = ? AND role = \'student\' ORDER BY datetime(join_time), id')
    .all(Number(sessionId));
  const byStudent = new Map();
  const now = Date.now();
  for (const row of rows) {
    const key = Number(row.user_id);
    const current = byStudent.get(key) || {
      studentId: key,
      fullName: row.display_name || `Student ${key}`,
      registrationNumber: row.registration_number || '',
      email: row.email || '',
      firstJoin: null,
      lastLeave: null,
      durationSeconds: 0,
      joinCount: 0,
      removed: false,
      removalReason: '',
      attendanceSource: row.attendance_source || 'internal'
    };
    current.joinCount += 1;
    if (!current.firstJoin || new Date(row.join_time) < new Date(current.firstJoin)) current.firstJoin = row.join_time;
    if (row.leave_time && (!current.lastLeave || new Date(row.leave_time) > new Date(current.lastLeave))) current.lastLeave = row.leave_time;
    let duration = Number(row.duration_seconds || 0);
    if (!row.leave_time) duration = Math.max(duration, Math.floor((now - new Date(row.join_time).getTime()) / 1000));
    current.durationSeconds += Math.max(0, duration);
    if (row.removal_reason) {
      current.removed = true;
      current.removalReason = row.removal_reason;
    }
    if (row.attendance_source === 'external') current.attendanceSource = 'external';
    byStudent.set(key, current);
  }

  const expected = getExpectedStudents(session);
  const expectedMap = new Map(expected.map((student) => [Number(student.id), student]));
  for (const item of byStudent.values()) {
    if (!expectedMap.has(item.studentId)) {
      expectedMap.set(item.studentId, {
        id: item.studentId,
        full_name: item.fullName,
        reg_number: item.registrationNumber,
        email: item.email,
        level: '—'
      });
    }
  }

  const thresholdSeconds = Math.max(0, Number(session.attendance_threshold_minutes || 1) * 60);
  const startMs = new Date(session.actual_start || session.start_time).getTime();
  const students = [...expectedMap.values()].map((student) => {
    const joined = byStudent.get(Number(student.id));
    const late = Boolean(joined?.firstJoin && Number.isFinite(startMs) && new Date(joined.firstJoin).getTime() > startMs + 60_000);
    let status = 'Absent';
    if (joined) {
      if (joined.removed) status = 'Removed';
      else if (joined.attendanceSource === 'external' || joined.durationSeconds >= thresholdSeconds) status = 'Present';
      else status = 'Partial';
    }
    return {
      studentId: Number(student.id),
      fullName: joined?.fullName || student.full_name,
      registrationNumber: joined?.registrationNumber || student.reg_number,
      email: joined?.email || student.email,
      level: student.level || '—',
      firstJoin: joined?.firstJoin || null,
      lastLeave: joined?.lastLeave || null,
      durationSeconds: joined?.durationSeconds || 0,
      joinCount: joined?.joinCount || 0,
      late,
      status,
      removalReason: joined?.removalReason || '',
      attendanceSource: joined?.attendanceSource || ''
    };
  });

  const totalJoined = students.filter((item) => item.joinCount > 0).length;
  const present = students.filter((item) => item.status === 'Present').length;
  const partial = students.filter((item) => item.status === 'Partial').length;
  const absent = students.filter((item) => item.status === 'Absent').length;
  const late = students.filter((item) => item.late).length;
  const removed = students.filter((item) => item.status === 'Removed').length;
  const staff = getParticipantList(sessionId, true, true).filter((item) => item.role !== 'student');

  return {
    session,
    summary: {
      expectedStudents: expected.length,
      totalJoined,
      present,
      partial,
      absent,
      late,
      removed,
      attendanceRate: expected.length ? Math.round((present / expected.length) * 100) : 0,
      attendanceThresholdMinutes: Number(session.attendance_threshold_minutes || 1)
    },
    students,
    staff
  };
}

function banStudent(sessionId, studentId, reason, removedBy) {
  db.prepare(`INSERT INTO session_bans (session_id, student_id, reason, removed_by)
    VALUES (?, ?, ?, ?) ON CONFLICT(session_id, student_id) DO UPDATE SET reason = excluded.reason,
    removed_by = excluded.removed_by, created_at = CURRENT_TIMESTAMP`)
    .run(Number(sessionId), Number(studentId), clean(reason, 500), removedBy ? Number(removedBy) : null);
  const session = getSessionById(sessionId);
  if (session) {
    const blocked = [...new Set([...session.blocked_student_ids, Number(studentId)])];
    db.prepare('UPDATE live_classes SET blocked_student_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(serializeIds(blocked), Number(sessionId));
  }
}

function unbanStudent(sessionId, studentId) {
  db.prepare('DELETE FROM session_bans WHERE session_id = ? AND student_id = ?').run(Number(sessionId), Number(studentId));
  const session = getSessionById(sessionId);
  if (session) {
    const blocked = session.blocked_student_ids.filter((id) => Number(id) !== Number(studentId));
    db.prepare('UPDATE live_classes SET blocked_student_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(serializeIds(blocked), Number(sessionId));
  }
}

module.exports = {
  clean,
  parseIds,
  serializeIds,
  rowToSession,
  toStoredStatus,
  createRoomKey,
  getSessionById,
  getIdentityFromRequestSession,
  roleForSession,
  isModeratorRole,
  isStudentBanned,
  getActiveParticipant,
  createOrUpdateParticipant,
  endParticipant,
  endParticipantById,
  touchParticipant,
  updateParticipantById,
  participantToPublic,
  getParticipantList,
  createEventLog,
  addChatMessage,
  getChatMessages,
  getExpectedStudents,
  buildAttendanceReport,
  banStudent,
  unbanStudent
};
