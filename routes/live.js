const express = require('express');
const { db } = require('../lib/db');
const { requireStaff, requirePortalUser } = require('../lib/auth');
const {
  clean,
  serializeIds,
  rowToSession,
  toStoredStatus,
  createRoomKey,
  getSessionById,
  getIdentityFromRequestSession,
  roleForSession,
  isStudentBanned,
  createOrUpdateParticipant,
  endParticipantById,
  getParticipantList,
  getChatMessages,
  buildAttendanceReport,
  createEventLog,
  unbanStudent
} = require('../lib/live');

const router = express.Router();

function isWebUrl(value) {
  return !value || /^https?:\/\//i.test(value);
}

function canStudentAccess(session, identity) {
  if (!session || !identity || identity.userType !== 'student') return true;
  if (isStudentBanned(session.id, identity.userId)) return false;
  if (session.blocked_student_ids.includes(Number(identity.userId))) return false;
  if (session.allowed_student_ids.length && !session.allowed_student_ids.includes(Number(identity.userId))) return false;
  if (session.audience_level && session.audience_level !== 'All Levels' && session.audience_level !== identity.level) return false;
  return true;
}

// ICE servers for WebRTC. STUN is always available; add a TURN relay in .env so students on
// restrictive campus / mobile networks can still connect (TURN_URL, TURN_USERNAME, TURN_CREDENTIAL).
router.get('/ice-servers', requirePortalUser, (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const turnUrls = String(process.env.TURN_URL || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (turnUrls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ iceServers });
});

router.get('/sessions', requirePortalUser, (req, res) => {
  const identity = getIdentityFromRequestSession(req.session);
  const sql = identity?.userType === 'staff'
    ? 'SELECT * FROM live_classes ORDER BY datetime(start_time) DESC, id DESC'
    : 'SELECT * FROM live_classes WHERE status != \'cancelled\' ORDER BY datetime(start_time) DESC, id DESC';
  const sessions = db.prepare(sql).all().map(rowToSession).filter((session) => canStudentAccess(session, identity));
  return res.json({ sessions });
});

router.get('/sessions/:id', requirePortalUser, (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Live session not found.' });
  const identity = getIdentityFromRequestSession(req.session);
  if (!identity) return res.status(401).json({ error: 'Please log in again.' });
  if (!canStudentAccess(session, identity)) return res.status(403).json({ error: 'You do not have access to this live session.' });
  const role = roleForSession(session, identity);
  const joinAllowed = identity.userType === 'staff'
    ? !['ended', 'cancelled'].includes(session.status)
    : session.status === 'live' && !session.room_locked;
  return res.json({
    session,
    viewer: {
      userId: identity.userId,
      userType: identity.userType,
      displayName: identity.displayName,
      registrationNumber: identity.registrationNumber,
      role,
      canModerate: identity.userType === 'staff',
      joinAllowed,
      waitingReason: joinAllowed ? '' : session.status !== 'live' ? 'The host has not started this session.' : 'The meeting room is locked.'
    }
  });
});

router.post('/sessions', requireStaff, (req, res) => {
  const type = clean(req.body.type, 20) || 'external';
  const title = clean(req.body.title || req.body.topic, 180);
  const topic = clean(req.body.topic, 180);
  const courseCode = clean(req.body.courseCode, 60).toUpperCase();
  const startTime = clean(req.body.startTime, 50);
  const endTime = clean(req.body.endTime, 50);
  const details = clean(req.body.details, 3000);
  const joinLink = clean(req.body.joinLink, 1000);
  const recordingLink = clean(req.body.recordingLink, 1000);
  const audienceLevel = clean(req.body.audienceLevel, 30) || 'All Levels';
  const capacityLimit = req.body.capacityLimit ? Math.max(1, Number(req.body.capacityLimit)) : null;
  const attendanceThresholdMinutes = Math.max(0, Number(req.body.attendanceThresholdMinutes || 1));
  if (!['external', 'in-app'].includes(type)) return res.status(400).json({ error: 'Choose an external or internal session.' });
  if (!courseCode || !topic || !startTime) return res.status(400).json({ error: 'Course code, topic and start time are required.' });
  if (Number.isNaN(Date.parse(startTime))) return res.status(400).json({ error: 'Enter a valid start time.' });
  if (endTime && (Number.isNaN(Date.parse(endTime)) || Date.parse(endTime) <= Date.parse(startTime))) return res.status(400).json({ error: 'End time must be later than start time.' });
  if (type === 'external' && (!joinLink || !isWebUrl(joinLink))) return res.status(400).json({ error: 'Enter a valid external meeting link.' });
  if (recordingLink && !isWebUrl(recordingLink)) return res.status(400).json({ error: 'Recording link must begin with http:// or https://.' });

  const result = db.prepare(`INSERT INTO live_classes
    (course_code, topic, title, start_time, end_time, type, provider_room_name, join_link, recording_link,
     details, status, capacity_limit, audience_level, attendance_threshold_minutes, host_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`)
    .run(courseCode, topic, title, new Date(startTime).toISOString(), endTime ? new Date(endTime).toISOString() : null,
      type, type === 'in-app' ? createRoomKey() : '', type === 'external' ? joinLink : '', recordingLink, details,
      capacityLimit, audienceLevel, attendanceThresholdMinutes, Number(req.session.staffId), req.session.staffName || 'Department Staff');
  return res.status(201).json({ success: true, session: getSessionById(Number(result.lastInsertRowid)) });
});

router.put('/sessions/:id', requireStaff, (req, res) => {
  const current = getSessionById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Live session not found.' });
  const status = clean(req.body.status ?? current.status, 20);
  if (!['scheduled', 'live', 'ended', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid session status.' });
  const title = clean(req.body.title ?? current.title, 180);
  const topic = clean(req.body.topic ?? current.topic, 180);
  const courseCode = clean(req.body.courseCode ?? current.course_code, 60).toUpperCase();
  const startTime = clean(req.body.startTime ?? current.start_time, 50);
  const endTime = clean(req.body.endTime ?? current.end_time, 50);
  const joinLink = clean(req.body.joinLink ?? current.join_link, 1000);
  const recordingLink = clean(req.body.recordingLink ?? current.recording_link, 1000);
  const details = clean(req.body.details ?? current.details, 3000);
  const audienceLevel = clean(req.body.audienceLevel ?? current.audience_level, 30) || 'All Levels';
  const capacityLimit = req.body.capacityLimit === '' ? null : Number(req.body.capacityLimit ?? current.capacity_limit) || null;
  const attendanceThresholdMinutes = Math.max(0, Number(req.body.attendanceThresholdMinutes ?? current.attendance_threshold_minutes ?? 1));
  if (current.type === 'external' && (!joinLink || !isWebUrl(joinLink))) return res.status(400).json({ error: 'Enter a valid external meeting link.' });
  if (recordingLink && !isWebUrl(recordingLink)) return res.status(400).json({ error: 'Enter a valid recording link.' });

  const actualStart = status === 'live' && !current.actual_start ? new Date().toISOString() : current.actual_start;
  const endedAt = status === 'ended' && !current.ended_at ? new Date().toISOString() : current.ended_at;
  db.prepare(`UPDATE live_classes SET title = ?, topic = ?, course_code = ?, start_time = ?, end_time = ?,
    join_link = ?, recording_link = ?, details = ?, status = ?, capacity_limit = ?, audience_level = ?,
    attendance_threshold_minutes = ?, actual_start = ?, ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(title, topic, courseCode, startTime, endTime || null, joinLink, recordingLink, details, toStoredStatus(status),
      capacityLimit, audienceLevel, attendanceThresholdMinutes, actualStart, endedAt, Number(req.params.id));
  createEventLog(current.id, `session-${status}`, req.session.staffId, null, { source: 'api' });
  return res.json({ success: true, session: getSessionById(current.id) });
});

router.post('/sessions/:id/external-join', requirePortalUser, (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Live session not found.' });
  if (session.type !== 'external') return res.status(400).json({ error: 'This is an internal portal meeting.' });
  const identity = getIdentityFromRequestSession(req.session);
  if (!identity || !canStudentAccess(session, identity)) return res.status(403).json({ error: 'You do not have access to this session.' });
  const role = roleForSession(session, identity);
  const participant = createOrUpdateParticipant({
    sessionId: session.id,
    identity,
    role,
    socketId: '',
    micState: 'unknown',
    camState: 'unknown',
    deviceInfo: req.get('user-agent') || 'external-browser',
    attendanceSource: 'external',
    lateEntryStatus: 'approved'
  });
  endParticipantById(participant.id);
  createEventLog(session.id, 'external-link-opened', identity.userId, participant.id, { role });
  return res.json({ success: true, joinLink: session.join_link });
});

router.get('/sessions/:id/participants', requirePortalUser, (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Live session not found.' });
  const identity = getIdentityFromRequestSession(req.session);
  if (!identity || !canStudentAccess(session, identity)) return res.status(403).json({ error: 'You do not have access to this session.' });
  const includeLeft = identity.userType === 'staff' && req.query.history === '1';
  return res.json({ participants: getParticipantList(session.id, includeLeft, identity.userType === 'staff') });
});

router.get('/sessions/:id/chat', requirePortalUser, (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Live session not found.' });
  return res.json({ messages: getChatMessages(session.id, 100) });
});

router.get('/sessions/:id/report', requireStaff, (req, res) => {
  const report = buildAttendanceReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Live session not found.' });
  return res.json(report);
});

router.post('/sessions/:id/report', requireStaff, (req, res) => {
  const report = buildAttendanceReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Live session not found.' });
  return res.json({ session: report.session, report: { ...report.summary, participants: report.students } });
});

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

router.get('/sessions/:id/report.csv', requireStaff, (req, res) => {
  const report = buildAttendanceReport(req.params.id);
  if (!report) return res.status(404).send('Live session not found.');
  const header = ['Registration Number', 'Student Name', 'Email', 'Level', 'Status', 'First Join', 'Last Leave', 'Duration Minutes', 'Late', 'Join Count', 'Removal Reason', 'Source'];
  const lines = [header.map(csvCell).join(',')];
  for (const item of report.students) {
    lines.push([
      item.registrationNumber, item.fullName, item.email, item.level, item.status, item.firstJoin || '', item.lastLeave || '',
      (item.durationSeconds / 60).toFixed(1), item.late ? 'Yes' : 'No', item.joinCount, item.removalReason, item.attendanceSource
    ].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-session-${report.session.id}.csv"`);
  return res.send(`\uFEFF${lines.join('\n')}`);
});

router.delete('/sessions/:id/bans/:studentId', requireStaff, (req, res) => {
  const session = getSessionById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Live session not found.' });
  unbanStudent(session.id, req.params.studentId);
  createEventLog(session.id, 'student-unbanned', req.session.staffId, req.params.studentId, {});
  return res.json({ success: true });
});

module.exports = router;
