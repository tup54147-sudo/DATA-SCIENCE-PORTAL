try { require('dotenv').config(); } catch (_) { /* .env is optional */ }
const http = require('node:http');
const express = require('express');
const session = require('express-session');
const path = require('path');
const { Server } = require('socket.io');
const { initDatabase, db } = require('./lib/db');
const { requireStaff, requirePortalUser } = require('./lib/auth');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const studentRoutes = require('./routes/student');
const liveRoutes = require('./routes/live');
const publicRoutes = require('./routes/public');
const {
  getSessionById,
  getIdentityFromRequestSession,
  roleForSession,
  isModeratorRole,
  isStudentBanned,
  createOrUpdateParticipant,
  endParticipantById,
  touchParticipant,
  updateParticipantById,
  participantToPublic,
  getParticipantList,
  createEventLog,
  addChatMessage,
  banStudent,
  toStoredStatus
} = require('./lib/live');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
  maxHttpBufferSize: 1e6
});
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROTECTED_DIR = path.join(ROOT, 'protected');
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const sessionMiddleware = session({
  name: 'ds_portal_session',
  secret: process.env.SESSION_SECRET || 'change-this-development-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/public', publicRoutes);

const socketMeta = new Map();
const roomName = (sessionId) => `live-session-${Number(sessionId)}`;

// Shared, per-room state that every participant must see (spotlight + screen share).
const roomStates = new Map();
function getRoomState(sessionId) {
  const key = Number(sessionId);
  if (!roomStates.has(key)) roomStates.set(key, { spotlightSocketId: null, sharer: null });
  return roomStates.get(key);
}
function publicRoomState(sessionId) {
  const state = getRoomState(sessionId);
  return { spotlightSocketId: state.spotlightSocketId, sharer: state.sharer };
}
function clearSpotlight(sessionId, by = 'the host') {
  const state = getRoomState(sessionId);
  if (!state.spotlightSocketId) return;
  state.spotlightSocketId = null;
  db.prepare('UPDATE session_participants SET is_spotlighted = 0 WHERE session_id = ? AND leave_time IS NULL').run(Number(sessionId));
  io.to(roomName(sessionId)).emit('spotlight-changed', { targetSocketId: null, participant: null, by });
}
function clearSharer(sessionId, by = '') {
  const state = getRoomState(sessionId);
  if (!state.sharer) return;
  state.sharer = null;
  io.to(roomName(sessionId)).emit('screen-share-changed', { sharer: null, by });
}

function publicMeta(meta) {
  return {
    socketId: meta.socketId,
    participantId: meta.participantId,
    userId: meta.identity.userId,
    userType: meta.identity.userType,
    displayName: meta.identity.displayName,
    registrationNumber: meta.identity.registrationNumber,
    role: meta.role
  };
}

function activeStudentCount(sessionId) {
  return getParticipantList(sessionId, false).filter((item) => item.role === 'student').length;
}

function canAccessSession(liveSession, identity) {
  if (identity.userType === 'staff') return true;
  if (isStudentBanned(liveSession.id, identity.userId)) return false;
  if (liveSession.blocked_student_ids.includes(Number(identity.userId))) return false;
  if (liveSession.allowed_student_ids.length && !liveSession.allowed_student_ids.includes(Number(identity.userId))) return false;
  if (liveSession.audience_level && liveSession.audience_level !== 'All Levels' && liveSession.audience_level !== identity.level) return false;
  return true;
}

function getTargetMeta(sourceMeta, targetSocketId) {
  const targetMeta = socketMeta.get(String(targetSocketId));
  if (!targetMeta || Number(targetMeta.sessionId) !== Number(sourceMeta.sessionId)) return null;
  return targetMeta;
}

function broadcastParticipant(sessionId, eventName, participant) {
  io.to(roomName(sessionId)).emit(eventName, { participant: participantToPublic(participant, false) });
}

io.on('connection', (socket) => {
  const requestSession = socket.request.session || {};
  const liveSessionId = Number(socket.handshake.query?.sessionId || 0);
  const liveSession = getSessionById(liveSessionId);
  const identity = getIdentityFromRequestSession(requestSession);

  if (!liveSession || !identity || liveSession.type !== 'in-app') {
    socket.emit('join-denied', { message: 'This internal live session is unavailable.' });
    socket.disconnect(true);
    return;
  }
  if (!canAccessSession(liveSession, identity)) {
    socket.emit('join-denied', { message: 'You have been restricted from this session.' });
    socket.disconnect(true);
    return;
  }

  const role = roleForSession(liveSession, identity);
  if (identity.userType === 'student') {
    if (liveSession.status !== 'live') {
      socket.emit('join-denied', { message: 'The host has not started this live session yet.', waiting: true });
      socket.disconnect(true);
      return;
    }
    if (liveSession.room_locked) {
      socket.emit('join-denied', { message: 'The host has locked this meeting room.' });
      socket.disconnect(true);
      return;
    }
    if (liveSession.capacity_limit && activeStudentCount(liveSession.id) >= Number(liveSession.capacity_limit)) {
      socket.emit('join-denied', { message: 'This live session has reached its participant capacity.' });
      socket.disconnect(true);
      return;
    }
  } else if (['ended', 'cancelled'].includes(liveSession.status)) {
    socket.emit('join-denied', { message: 'This session has already ended.' });
    socket.disconnect(true);
    return;
  }

  const joinedLate = identity.userType === 'student' && new Date() > new Date(liveSession.start_time);
  const participant = createOrUpdateParticipant({
    sessionId: liveSession.id,
    identity,
    role,
    socketId: socket.id,
    micState: identity.userType === 'student' && !liveSession.allow_student_mic ? 'muted' : 'unmuted',
    camState: identity.userType === 'student' && !liveSession.allow_student_video ? 'off' : 'on',
    deviceInfo: socket.handshake.headers['user-agent'] || 'browser',
    attendanceSource: 'internal',
    isLateEntry: joinedLate,
    lateEntryStatus: 'approved'
  });

  const meta = {
    socketId: socket.id,
    sessionId: liveSession.id,
    identity,
    role,
    participantId: participant.id
  };
  socketMeta.set(socket.id, meta);
  socket.join(roomName(liveSession.id));

  const peers = [...socketMeta.values()]
    .filter((item) => item.socketId !== socket.id && Number(item.sessionId) === Number(liveSession.id))
    .map(publicMeta);

  socket.emit('room-ready', {
    session: getSessionById(liveSession.id),
    self: publicMeta(meta),
    peers,
    roomState: publicRoomState(liveSession.id),
    participants: getParticipantList(liveSession.id, false, identity.userType === 'staff')
  });
  socket.to(roomName(liveSession.id)).emit('peer-joined', { peer: publicMeta(meta), participant: participantToPublic(participant, false) });
  io.to(roomName(liveSession.id)).emit('participant-count', { active: getParticipantList(liveSession.id, false).length });
  createEventLog(liveSession.id, 'participant-joined', identity.userId, participant.id, { role, socketId: socket.id });

  socket.on('heartbeat', () => touchParticipant(meta.participantId));

  socket.on('webrtc-offer', (payload = {}) => {
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || !payload.sdp) return;
    io.to(target.socketId).emit('webrtc-offer', { fromSocketId: socket.id, sdp: payload.sdp, peer: publicMeta(meta) });
  });

  socket.on('webrtc-answer', (payload = {}) => {
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || !payload.sdp) return;
    io.to(target.socketId).emit('webrtc-answer', { fromSocketId: socket.id, sdp: payload.sdp });
  });

  socket.on('webrtc-ice-candidate', (payload = {}) => {
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || !payload.candidate) return;
    io.to(target.socketId).emit('webrtc-ice-candidate', { fromSocketId: socket.id, candidate: payload.candidate });
  });

  socket.on('presence-update', (payload = {}) => {
    const updated = updateParticipantById(meta.participantId, {
      mic_state: payload.micState === 'muted' ? 'muted' : 'unmuted',
      cam_state: payload.camState === 'off' ? 'off' : 'on'
    });
    broadcastParticipant(meta.sessionId, 'participant-updated', updated);
  });

  socket.on('raise-hand', (payload = {}) => {
    if (meta.role !== 'student') return;
    const updated = updateParticipantById(meta.participantId, { hand_raised: Boolean(payload.raised) });
    broadcastParticipant(meta.sessionId, 'participant-updated', updated);
    createEventLog(meta.sessionId, payload.raised ? 'hand-raised' : 'hand-lowered', identity.userId, participant.id, {});
  });

  socket.on('chat-message', (payload = {}) => {
    const message = String(payload.message || '').trim().slice(0, 1000);
    if (!message) return;
    const saved = addChatMessage(meta.sessionId, identity, meta.role, message);
    io.to(roomName(meta.sessionId)).emit('chat-message', {
      id: saved.id,
      userId: identity.userId,
      userType: identity.userType,
      role: meta.role,
      displayName: identity.displayName,
      message: saved.message,
      createdAt: saved.created_at
    });
  });

  socket.on('reaction', (payload = {}) => {
    const allowed = new Set(['👏', '👍', '❤️', '🎉', '😂', '✋']);
    const emoji = allowed.has(payload.emoji) ? payload.emoji : '👏';
    io.to(roomName(meta.sessionId)).emit('reaction', { socketId: socket.id, displayName: identity.displayName, emoji });
  });

  socket.on('moderator-mute', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || target.role !== 'student') return;
    io.to(target.socketId).emit('force-mute', { by: identity.displayName });
    const updated = updateParticipantById(target.participantId, { mic_state: 'muted' });
    broadcastParticipant(meta.sessionId, 'participant-updated', updated);
    createEventLog(meta.sessionId, 'participant-muted', identity.userId, target.identity.userId, {});
  });

  socket.on('moderator-camera-off', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || target.role !== 'student') return;
    io.to(target.socketId).emit('force-camera-off', { by: identity.displayName });
    const updated = updateParticipantById(target.participantId, { cam_state: 'off' });
    broadcastParticipant(meta.sessionId, 'participant-updated', updated);
    createEventLog(meta.sessionId, 'participant-camera-stopped', identity.userId, target.identity.userId, {});
  });

  socket.on('moderator-spotlight', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target) return;
    db.prepare('UPDATE session_participants SET is_spotlighted = 0 WHERE session_id = ? AND leave_time IS NULL').run(Number(meta.sessionId));
    const updated = updateParticipantById(target.participantId, { is_spotlighted: 1 });
    getRoomState(meta.sessionId).spotlightSocketId = target.socketId;
    io.to(roomName(meta.sessionId)).emit('spotlight-changed', {
      targetSocketId: target.socketId,
      participant: participantToPublic(updated, false),
      by: identity.displayName
    });
    createEventLog(meta.sessionId, 'participant-spotlighted', identity.userId, target.identity.userId, {});
  });

  socket.on('moderator-unspotlight', () => {
    if (!isModeratorRole(meta.role)) return;
    clearSpotlight(meta.sessionId, identity.displayName);
    createEventLog(meta.sessionId, 'spotlight-removed', identity.userId, null, {});
  });

  // ----- Screen sharing (one presenter at a time; students need permission) -----
  socket.on('screen-share-start', (payload = {}, ack) => {
    const reply = (result) => { if (typeof ack === 'function') ack(result); };
    const current = getSessionById(meta.sessionId);
    if (!current || current.status !== 'live') return reply({ ok: false, message: 'Screen sharing is available once the class is live.' });
    if (meta.role === 'student' && !current.allow_student_share) return reply({ ok: false, message: 'The host has not allowed students to share their screen.' });
    const state = getRoomState(meta.sessionId);
    if (state.sharer && state.sharer.socketId !== socket.id) {
      if (!isModeratorRole(meta.role)) return reply({ ok: false, message: `${state.sharer.displayName} is already sharing their screen.` });
      io.to(state.sharer.socketId).emit('force-stop-share', { by: identity.displayName });
    }
    state.sharer = { socketId: socket.id, displayName: identity.displayName, role: meta.role };
    io.to(roomName(meta.sessionId)).emit('screen-share-changed', { sharer: state.sharer, by: identity.displayName });
    createEventLog(meta.sessionId, 'screen-share-started', identity.userId, meta.participantId, {});
    return reply({ ok: true });
  });

  socket.on('screen-share-stop', () => {
    const state = getRoomState(meta.sessionId);
    if (state.sharer?.socketId !== socket.id) return;
    clearSharer(meta.sessionId, identity.displayName);
    createEventLog(meta.sessionId, 'screen-share-stopped', identity.userId, meta.participantId, {});
  });

  socket.on('moderator-stop-share', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const state = getRoomState(meta.sessionId);
    if (!state.sharer || (payload.targetSocketId && state.sharer.socketId !== payload.targetSocketId)) return;
    io.to(state.sharer.socketId).emit('force-stop-share', { by: identity.displayName });
    clearSharer(meta.sessionId, identity.displayName);
  });

  // ----- Speaking indicator + on-demand video (keeps bandwidth low in mesh calls) -----
  socket.on('speaking', (payload = {}) => {
    socket.to(roomName(meta.sessionId)).emit('speaking', { socketId: socket.id, speaking: Boolean(payload.speaking) });
  });

  socket.on('video-want', (payload = {}) => {
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target) return;
    io.to(target.socketId).emit('video-want', { fromSocketId: socket.id, wanted: Boolean(payload.wanted) });
  });

  socket.on('moderator-ask-unmute', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || target.role !== 'student') return;
    io.to(target.socketId).emit('unmute-request', { by: identity.displayName });
  });

  socket.on('moderator-lower-hand', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const targets = payload.all
      ? [...socketMeta.values()].filter((item) => Number(item.sessionId) === Number(meta.sessionId) && item.role === 'student')
      : [getTargetMeta(meta, payload.targetSocketId)].filter(Boolean);
    for (const target of targets) {
      const updated = updateParticipantById(target.participantId, { hand_raised: false });
      io.to(target.socketId).emit('hand-lowered-by-host', { by: identity.displayName });
      broadcastParticipant(meta.sessionId, 'participant-updated', updated);
    }
  });

  socket.on('moderator-remove', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const target = getTargetMeta(meta, payload.targetSocketId);
    if (!target || target.role !== 'student') return;
    const reason = String(payload.reason || 'Removed by a session administrator.').trim().slice(0, 500);
    banStudent(meta.sessionId, target.identity.userId, reason, identity.userId);
    endParticipantById(target.participantId, { removalReason: reason, removedBy: identity.userId });
    createEventLog(meta.sessionId, 'participant-removed', identity.userId, target.identity.userId, { reason });
    const removedState = getRoomState(meta.sessionId);
    if (removedState.spotlightSocketId === target.socketId) clearSpotlight(meta.sessionId, identity.displayName);
    if (removedState.sharer?.socketId === target.socketId) clearSharer(meta.sessionId, identity.displayName);
    io.to(target.socketId).emit('removed-from-session', { reason, by: identity.displayName });
    io.to(roomName(meta.sessionId)).emit('participant-removed', { socketId: target.socketId, userId: target.identity.userId, reason });
    setTimeout(() => io.sockets.sockets.get(target.socketId)?.disconnect(true), 250);
  });

  socket.on('mute-all-students', () => {
    if (!isModeratorRole(meta.role)) return;
    for (const target of socketMeta.values()) {
      if (Number(target.sessionId) !== Number(meta.sessionId) || target.role !== 'student') continue;
      io.to(target.socketId).emit('force-mute', { by: identity.displayName });
      updateParticipantById(target.participantId, { mic_state: 'muted' });
    }
    io.to(roomName(meta.sessionId)).emit('participants-refresh');
    createEventLog(meta.sessionId, 'mute-all', identity.userId, null, {});
  });

  socket.on('session-start', () => {
    if (!isModeratorRole(meta.role)) return;
    const current = getSessionById(meta.sessionId);
    if (!current || current.status === 'live') return;
    db.prepare("UPDATE live_classes SET status = 'live', actual_start = COALESCE(actual_start, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(new Date().toISOString(), Number(meta.sessionId));
    const updated = getSessionById(meta.sessionId);
    io.to(roomName(meta.sessionId)).emit('session-status', { status: 'live', session: updated });
    createEventLog(meta.sessionId, 'session-started', identity.userId, null, {});
  });

  socket.on('session-lock', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const locked = payload.locked ? 1 : 0;
    db.prepare('UPDATE live_classes SET room_locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(locked, Number(meta.sessionId));
    io.to(roomName(meta.sessionId)).emit('room-lock-changed', { locked: Boolean(locked), by: identity.displayName });
    createEventLog(meta.sessionId, locked ? 'room-locked' : 'room-unlocked', identity.userId, null, {});
  });

  socket.on('student-permissions', (payload = {}) => {
    if (!isModeratorRole(meta.role)) return;
    const current = getSessionById(meta.sessionId);
    const allowMic = payload.allowMic === undefined ? Number(current.allow_student_mic) : (payload.allowMic === false ? 0 : 1);
    const allowVideo = payload.allowVideo === undefined ? Number(current.allow_student_video) : (payload.allowVideo === false ? 0 : 1);
    const allowShare = payload.allowShare === undefined ? Number(current.allow_student_share) : (payload.allowShare ? 1 : 0);
    db.prepare('UPDATE live_classes SET allow_student_mic = ?, allow_student_video = ?, allow_student_share = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(allowMic, allowVideo, allowShare, Number(meta.sessionId));
    const permState = getRoomState(meta.sessionId);
    if (!allowShare && permState.sharer?.role === 'student') {
      io.to(permState.sharer.socketId).emit('force-stop-share', { by: identity.displayName });
      clearSharer(meta.sessionId, identity.displayName);
    }
    io.to(roomName(meta.sessionId)).emit('student-permissions', { allowMic: Boolean(allowMic), allowVideo: Boolean(allowVideo), allowShare: Boolean(allowShare) });
  });

  socket.on('session-end', () => {
    if (!isModeratorRole(meta.role)) return;
    db.prepare('UPDATE live_classes SET status = ?, ended_at = COALESCE(ended_at, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(toStoredStatus('ended'), new Date().toISOString(), Number(meta.sessionId));
    createEventLog(meta.sessionId, 'session-ended', identity.userId, null, {});
    clearSharer(meta.sessionId, identity.displayName);
    clearSpotlight(meta.sessionId, identity.displayName);
    io.to(roomName(meta.sessionId)).emit('session-ended', { by: identity.displayName });
    setTimeout(() => {
      for (const target of [...socketMeta.values()]) {
        if (Number(target.sessionId) === Number(meta.sessionId) && target.role === 'student') {
          io.sockets.sockets.get(target.socketId)?.disconnect(true);
        }
      }
    }, 800);
  });

  socket.on('disconnect', () => {
    const currentMeta = socketMeta.get(socket.id);
    if (!currentMeta) return;
    socketMeta.delete(socket.id);
    const leavingState = getRoomState(currentMeta.sessionId);
    if (leavingState.spotlightSocketId === socket.id) clearSpotlight(currentMeta.sessionId, 'system');
    if (leavingState.sharer?.socketId === socket.id) clearSharer(currentMeta.sessionId, 'system');
    const ended = endParticipantById(currentMeta.participantId);
    socket.to(roomName(currentMeta.sessionId)).emit('peer-left', { socketId: socket.id, participant: participantToPublic(ended, false) });
    io.to(roomName(currentMeta.sessionId)).emit('participant-count', { active: getParticipantList(currentMeta.sessionId, false).length });
    createEventLog(currentMeta.sessionId, 'participant-left', currentMeta.identity.userId, currentMeta.participantId, {});
  });
});

app.get('/admin', requireStaff, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'admin.html')));
app.get(['/student', '/student-preview'], requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-dashboard.html')));
app.get('/student/announcements', requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-announcements.html')));
app.get('/student/materials', requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-materials.html')));
app.get('/student/course-structure', requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-course-structure.html')));
app.get('/student/live-classes', requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-live-classes.html')));
app.get(['/student/live-call', '/live/session'], requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-live-call.html')));
app.get('/student/settings', requirePortalUser, (req, res) => res.sendFile(path.join(PROTECTED_DIR, 'student-settings.html')));

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

initDatabase()
  .then(() => {
    server.listen(PORT, () => console.log(`Data Science portal running at http://localhost:${PORT}`));
  })
  .catch((error) => {
    console.error('Failed to initialise database:', error);
    process.exit(1);
  });
