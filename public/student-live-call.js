import { api, escapeHtml } from './portal.js';

/* =====================================================================
   Live classroom client
   - Pre-join lobby (camera/mic preview, device choice)
   - Speaker view (active speaker / pinned / spotlight / shared screen) and paged gallery view
   - Host & co-host controls: spotlight for everyone, mute, stop video, lower hand, remove,
     lock room, student permissions (mic, video, screen share), start/end class
   - Screen sharing with proper renegotiation (perfect-negotiation pattern)
   - Attendance opens ONLY when the host asks for it
   - Video is sent on demand: a participant only uploads their camera to people who are
     actually looking at it (speaker, pinned, spotlight, visible tiles). This keeps mesh calls light.
   ===================================================================== */

const params = new URLSearchParams(location.search);
const sessionId = Number(params.get('id') || 0);
const els = {};
document.querySelectorAll('[id]').forEach((el) => { els[el.id] = el; });

const state = {
  session: null, viewer: null, socket: null,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  localStream: new MediaStream(), audioTrack: null, cameraTrack: null, selfVideoStream: null,
  screenStream: null, sharing: false,
  micOn: false, camOn: false, handRaised: false,
  joined: false, joining: false,
  peers: new Map(), participants: new Map(), tiles: new Map(),
  room: { spotlightSocketId: null, sharer: null },
  pinned: null, layout: 'speaker', galleryPage: 0,
  speaking: new Set(), lastSpoke: new Map(), activeSpeaker: null, lastSwitch: 0,
  wants: new Set(),
  timer: null, heartbeat: null, detector: null, audioCtx: null,
  unread: 0, sidebarTab: 'participants',
  removeTarget: null, attendanceTab: 'active', reportCache: null, reportSearch: '',
  waitTimer: null, renderQueued: false
};

const pre = { audioTrack: null, videoTrack: null, mic: true, cam: true, stream: null };
const selfId = () => state.socket?.id || '';
const isMobile = () => window.matchMedia('(max-width: 700px)').matches;
const isModerator = () => Boolean(state.viewer?.canModerate);
const isStaffRole = (p) => p && (p.role === 'host' || p.role === 'co-host');

/* ---------------------------------------------------------------- helpers */
function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'DS';
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}
function emitAck(event, payload = {}) {
  return new Promise((resolve) => {
    if (!state.socket?.connected) return resolve({ ok: false, message: 'You are not connected to the classroom.' });
    const timeout = setTimeout(() => resolve({ ok: false, message: 'The classroom did not respond. Try again.' }), 8000);
    state.socket.emit(event, payload, (result) => { clearTimeout(timeout); resolve(result || { ok: false }); });
  });
}
function showNotice(message, type = 'info', timeout = 4500, action = null) {
  els.meetingNotice.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = message;
  els.meetingNotice.appendChild(text);
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', () => { els.meetingNotice.hidden = true; action.run(); });
    els.meetingNotice.appendChild(button);
  }
  els.meetingNotice.className = `meeting-notice ${type}`;
  els.meetingNotice.hidden = false;
  clearTimeout(showNotice.timer);
  if (timeout) showNotice.timer = setTimeout(() => { els.meetingNotice.hidden = true; }, timeout);
}
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}

/* --------------------------------------------------------- session header */
function setMeetingStatus(status) {
  const normalized = status || 'scheduled';
  els.meetingStatus.className = `meeting-badge ${normalized === 'live' ? 'live' : ''}`;
  els.meetingStatus.innerHTML = `<i class="fas fa-circle"></i> ${normalized[0].toUpperCase() + normalized.slice(1)}`;
}
function updateSessionHeader() {
  const session = state.session;
  if (!session) return;
  els.sessionTitle.textContent = session.title || session.topic || 'Internal Live Classroom';
  els.sessionMeta.textContent = `${session.course_code} · ${session.topic} · ${formatDate(session.start_time)}`;
  setMeetingStatus(session.status);
  els.securityState.innerHTML = session.room_locked
    ? '<i class="fas fa-lock"></i> Room locked'
    : '<i class="fas fa-shield-halved"></i> Secure room';
  els.lockToggle.checked = Boolean(session.room_locked);
  els.allowStudentMic.checked = Boolean(session.allow_student_mic);
  els.allowStudentVideo.checked = Boolean(session.allow_student_video);
  els.allowStudentShare.checked = Boolean(session.allow_student_share);
  els.startSession.hidden = !(isModerator() && state.joined && session.status !== 'live' && session.status !== 'ended');
  els.endSession.disabled = session.status === 'ended';
  startTimer();
  updateToolbar();
}
function startTimer() {
  clearInterval(state.timer);
  const tick = () => {
    const start = new Date(state.session?.actual_start || state.session?.start_time || Date.now()).getTime();
    if (!Number.isFinite(start) || state.session?.status !== 'live') { els.meetingTimer.textContent = '00:00:00'; return; }
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    els.meetingTimer.textContent = `${h}:${m}:${s}`;
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

/* ------------------------------------------------------------ media (local) */
const videoConstraints = (deviceId) => ({
  width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 },
  ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' })
});
const audioConstraints = (deviceId) => ({
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  ...(deviceId ? { deviceId: { exact: deviceId } } : {})
});
const gum = (constraints) => navigator.mediaDevices.getUserMedia(constraints);

async function acquireAudioTrack(deviceId = '') {
  const stream = await gum({ audio: audioConstraints(deviceId) });
  return stream.getAudioTracks()[0];
}
async function acquireVideoTrack(deviceId = '') {
  const stream = await gum({ video: videoConstraints(deviceId) });
  return stream.getVideoTracks()[0];
}

async function populateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind, fallback) => {
      const current = select.value;
      const list = devices.filter((item) => item.kind === kind);
      select.innerHTML = `<option value="">${fallback}</option>` + list.map((item, i) =>
        `<option value="${escapeHtml(item.deviceId)}">${escapeHtml(item.label || `${fallback} ${i + 1}`)}</option>`).join('');
      if ([...select.options].some((o) => o.value === current)) select.value = current;
    };
    fill(els.prejoinCamSelect, 'videoinput', 'Default camera');
    fill(els.prejoinMicSelect, 'audioinput', 'Default microphone');
  } catch (error) { console.warn(error); }
}

function setPreviewVideo() {
  const live = Boolean(pre.videoTrack) && pre.cam;
  els.prejoinVideo.srcObject = live ? new MediaStream([pre.videoTrack]) : null;
  els.prejoinVideo.play?.().catch(() => {});
  document.querySelector('.prejoin-preview').classList.toggle('novideo', !live);
  els.prejoinMic.classList.toggle('on', pre.mic && Boolean(pre.audioTrack));
  els.prejoinMic.innerHTML = `<i class="fas fa-microphone${pre.mic && pre.audioTrack ? '' : '-slash'}"></i>`;
  els.prejoinCam.classList.toggle('on', pre.cam && Boolean(pre.videoTrack));
  els.prejoinCam.innerHTML = `<i class="fas fa-video${pre.cam && pre.videoTrack ? '' : '-slash'}"></i>`;
}

async function startPreview() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.prejoinMessage.textContent = 'Camera and microphone need HTTPS (or localhost). You can still join and watch the class.';
    pre.mic = false; pre.cam = false;
    setPreviewVideo();
    return;
  }
  try {
    const stream = await gum({ audio: audioConstraints(), video: videoConstraints() });
    pre.audioTrack = stream.getAudioTracks()[0] || null;
    pre.videoTrack = stream.getVideoTracks()[0] || null;
  } catch (error) {
    // One device may be missing or blocked: try them separately so the other still works.
    try { pre.audioTrack = await acquireAudioTrack(); } catch (e) { console.warn('No microphone', e); }
    try { pre.videoTrack = await acquireVideoTrack(); } catch (e) { console.warn('No camera', e); }
    if (!pre.audioTrack && !pre.videoTrack) {
      els.prejoinMessage.textContent = 'Camera and microphone are blocked or unavailable. You can still join in listen-only mode, or allow access in your browser and refresh.';
    }
  }
  pre.mic = Boolean(pre.audioTrack);
  pre.cam = Boolean(pre.videoTrack);
  if (!isModerator()) {
    if (!state.session.allow_student_mic) pre.mic = false;
    if (!state.session.allow_student_video) pre.cam = false;
  }
  await populateDevices();
  setPreviewVideo();
}

async function changePreviewDevice(kind) {
  try {
    if (kind === 'video') {
      pre.videoTrack?.stop();
      pre.videoTrack = await acquireVideoTrack(els.prejoinCamSelect.value);
      pre.cam = true;
    } else {
      pre.audioTrack?.stop();
      pre.audioTrack = await acquireAudioTrack(els.prejoinMicSelect.value);
      pre.mic = true;
    }
    setPreviewVideo();
  } catch (error) { showNotice(`Could not switch device: ${error.message}`, 'error'); }
}

async function togglePreviewCam() {
  if (!pre.videoTrack || !pre.cam) {
    if (!isModerator() && !state.session.allow_student_video) return showNotice('The host has turned off student cameras.', 'warning');
    try {
      if (!pre.videoTrack || pre.videoTrack.readyState === 'ended') pre.videoTrack = await acquireVideoTrack(els.prejoinCamSelect.value);
      pre.cam = true;
    } catch (error) { return showNotice('Camera permission was not granted.', 'warning'); }
  } else {
    pre.cam = false;
    pre.videoTrack.stop();
    pre.videoTrack = null;
  }
  setPreviewVideo();
}
async function togglePreviewMic() {
  if (!pre.audioTrack) {
    try { pre.audioTrack = await acquireAudioTrack(els.prejoinMicSelect.value); pre.mic = true; }
    catch (error) { return showNotice('Microphone permission was not granted.', 'warning'); }
  } else pre.mic = !pre.mic;
  if (pre.mic && !isModerator() && !state.session.allow_student_mic) { pre.mic = false; showNotice('The host has turned off student microphones.', 'warning'); }
  setPreviewVideo();
}

/* Hand the preview tracks over to the live call. */
function adoptPreviewTracks() {
  const staff = isModerator();
  state.audioTrack = pre.audioTrack;
  state.cameraTrack = pre.cam ? pre.videoTrack : null;
  if (!pre.cam) pre.videoTrack?.stop();
  state.micOn = Boolean(state.audioTrack) && pre.mic && (staff || Boolean(state.session.allow_student_mic));
  state.camOn = Boolean(state.cameraTrack) && (staff || Boolean(state.session.allow_student_video));
  if (!state.camOn && state.cameraTrack) { state.cameraTrack.stop(); state.cameraTrack = null; }
  if (state.audioTrack) state.audioTrack.enabled = state.micOn;
  state.localStream = new MediaStream([state.audioTrack, state.cameraTrack].filter(Boolean));
  refreshSelfVideoStream();
}
function refreshSelfVideoStream() {
  state.selfVideoStream = state.cameraTrack ? new MediaStream([state.cameraTrack]) : null;
}

async function ensureAudioTrack() {
  if (state.audioTrack && state.audioTrack.readyState === 'live') return true;
  try {
    state.audioTrack = await acquireAudioTrack(els.prejoinMicSelect.value);
    state.localStream.addTrack(state.audioTrack);
    for (const peer of state.peers.values()) peer.audioT?.sender.replaceTrack(state.audioTrack).catch(() => {});
    startSpeakingDetector();
    return true;
  } catch (error) {
    showNotice('Microphone permission was not granted.', 'warning');
    return false;
  }
}

async function setMic(enabled) {
  if (enabled && !(await ensureAudioTrack())) return;
  if (enabled && !isModerator() && !state.session.allow_student_mic) return showNotice('The host has turned off student microphones.', 'warning');
  if (state.audioTrack) state.audioTrack.enabled = enabled;
  state.micOn = Boolean(state.audioTrack) && enabled;
  if (!state.micOn) setSpeakingSelf(false);
  updateToolbar();
  sendPresence();
}

async function setCamera(enabled) {
  if (enabled) {
    if (!isModerator() && !state.session.allow_student_video) return showNotice('The host has turned off student cameras.', 'warning');
    try {
      const track = await acquireVideoTrack(state.currentCameraId || '');
      state.cameraTrack = track;
      state.currentCameraId = track.getSettings?.().deviceId || state.currentCameraId;
      state.localStream.getVideoTracks().forEach((t) => state.localStream.removeTrack(t));
      state.localStream.addTrack(track);
      state.camOn = true;
    } catch (error) { return showNotice('Camera permission was not granted.', 'warning'); }
  } else {
    if (state.cameraTrack) {
      state.localStream.removeTrack(state.cameraTrack);
      state.cameraTrack.stop();
    }
    state.cameraTrack = null;
    state.camOn = false;
  }
  refreshSelfVideoStream();
  for (const peer of state.peers.values()) applyVideoGate(peer);
  updateToolbar();
  sendPresence();
  scheduleRender();
}

async function switchCamera() {
  if (!navigator.mediaDevices?.enumerateDevices) return showNotice('Camera switching is not supported by this browser.', 'warning');
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === 'videoinput');
    if (devices.length < 2) return showNotice('Only one camera is available on this device.', 'info');
    const index = Math.max(0, devices.findIndex((item) => item.deviceId === state.currentCameraId));
    const next = devices[(index + 1) % devices.length];
    state.cameraTrack?.stop();
    const track = await acquireVideoTrack(next.deviceId);
    state.localStream.getVideoTracks().forEach((t) => state.localStream.removeTrack(t));
    state.localStream.addTrack(track);
    state.cameraTrack = track;
    state.currentCameraId = next.deviceId;
    state.camOn = true;
    refreshSelfVideoStream();
    for (const peer of state.peers.values()) applyVideoGate(peer, true);
    updateToolbar(); sendPresence(); scheduleRender();
    showNotice(`Camera switched to ${next.label || 'another camera'}.`, 'success', 2500);
  } catch (error) { showNotice(`Unable to switch camera: ${error.message}`, 'error'); }
}

/* ---------------------------------------------------- speaking detection */
function startSpeakingDetector() {
  if (state.detector || !state.audioTrack) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    state.audioCtx = state.audioCtx || new Ctx();
    const source = state.audioCtx.createMediaStreamSource(new MediaStream([state.audioTrack]));
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let speaking = false; let loud = 0; let quiet = 0;
    state.detector = setInterval(() => {
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume().catch(() => {});
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) { const x = (data[i] - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / data.length);
      if (state.micOn && rms > 0.035) { loud += 1; quiet = 0; } else { quiet += 1; loud = 0; }
      if (!speaking && loud >= 2) { speaking = true; setSpeakingSelf(true); }
      else if (speaking && quiet >= 7) { speaking = false; setSpeakingSelf(false); }
    }, 120);
  } catch (error) { console.warn('Speaking detector unavailable', error); }
}
function setSpeakingSelf(speaking) {
  const id = selfId();
  if (!id) return;
  const had = state.speaking.has(id);
  if (speaking === had) return;
  onSpeakingChange(id, speaking);
  state.socket?.emit('speaking', { speaking });
}
function onSpeakingChange(socketId, speaking) {
  if (speaking) { state.speaking.add(socketId); state.lastSpoke.set(socketId, Date.now()); }
  else state.speaking.delete(socketId);
  if (speaking && socketId !== selfId()) {
    const now = Date.now();
    const current = state.activeSpeaker;
    if (!current || !state.participants.has(current) || !state.speaking.has(current) || now - state.lastSwitch > 1500) {
      if (current !== socketId) { state.activeSpeaker = socketId; state.lastSwitch = now; }
    }
  }
  const tile = state.tiles.get(socketId);
  if (tile) tile.classList.toggle('speaking', state.speaking.has(socketId));
  if (speaking && state.layout === 'speaker') scheduleRender();
}

/* ------------------------------------------------------------ peers / WebRTC */
function ensurePeer(socketId, info = null) {
  let peer = state.peers.get(socketId);
  if (!peer) {
    peer = {
      socketId, pc: null, polite: String(selfId()) > String(socketId), makingOffer: false, ignoreOffer: false,
      audioT: null, videoT: null, screenSenders: [], wantsMyVideo: false, negotiated: false, candidates: [],
      remoteVideoStream: null, remoteScreen: null, audioEl: null
    };
    state.peers.set(socketId, peer);
  }
  if (info) registerParticipant(info, socketId);
  return peer;
}

function createPc(peer) {
  if (peer.pc) return peer.pc;
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  peer.pc = pc;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket?.emit('webrtc-ice-candidate', { targetSocketId: peer.socketId, candidate });
  };
  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      state.socket?.emit('webrtc-offer', { targetSocketId: peer.socketId, sdp: pc.localDescription });
    } catch (error) { console.error('Offer error:', error); }
    finally { peer.makingOffer = false; }
  };
  pc.ontrack = (event) => handleRemoteTrack(peer, event);
  pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') tuneSenders(peer); };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch (_) { /* ignore */ } }
  };
  return pc;
}

/* The newcomer always offers to people already in the room, so there is never an initial offer collision. */
function connectToPeer(peer) {
  const pc = createPc(peer);
  peer.audioT = pc.addTransceiver('audio', { direction: 'sendrecv', streams: [state.localStream] });
  peer.videoT = pc.addTransceiver('video', { direction: 'sendrecv', streams: [state.localStream] });
  if (state.audioTrack) peer.audioT.sender.replaceTrack(state.audioTrack).catch(() => {});
  applyVideoGate(peer);
}

function adoptTransceivers(peer) {
  for (const transceiver of peer.pc.getTransceivers()) {
    const kind = transceiver.receiver.track.kind;
    if (kind === 'audio' && !peer.audioT) peer.audioT = transceiver;
    else if (kind === 'video' && !peer.videoT) peer.videoT = transceiver;
  }
}

/* Answering side: attach our own mic/camera to the transceivers the offer created. */
async function prepareSending(peer) {
  adoptTransceivers(peer);
  const pairs = [[peer.audioT, state.audioTrack], [peer.videoT, null]];
  for (const [transceiver, track] of pairs) {
    if (!transceiver) continue;
    try {
      if (transceiver.direction !== 'sendrecv') transceiver.direction = 'sendrecv';
      transceiver.sender.setStreams?.(state.localStream);
      await transceiver.sender.replaceTrack(track);
    } catch (error) { console.warn('prepareSending', error); }
  }
  applyVideoGate(peer);
}

function applyVideoGate(peer, force = false) {
  const sender = peer.videoT?.sender;
  if (!sender) return;
  const wanted = peer.wantsMyVideo && state.camOn && state.cameraTrack && state.cameraTrack.readyState === 'live';
  const track = wanted ? state.cameraTrack : null;
  if (force || sender.track !== track) sender.replaceTrack(track).catch(() => {});
}

function afterFirstNegotiation(peer) {
  applyVideoGate(peer);
  if (state.sharing && state.screenStream) addScreenToPeer(peer);
  if (state.wants.has(peer.socketId)) state.socket?.emit('video-want', { targetSocketId: peer.socketId, wanted: true });
}

async function handleDescription(fromSocketId, description, info = null) {
  const peer = ensurePeer(fromSocketId, info);
  const pc = createPc(peer);
  try {
    const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;
    await pc.setRemoteDescription(description);
    for (const candidate of peer.candidates.splice(0)) { try { await pc.addIceCandidate(candidate); } catch (_) { /* stale */ } }
    if (description.type === 'offer') {
      const first = !peer.negotiated;
      if (first) await prepareSending(peer);
      await pc.setLocalDescription();
      state.socket?.emit('webrtc-answer', { targetSocketId: fromSocketId, sdp: pc.localDescription });
      if (first) { peer.negotiated = true; afterFirstNegotiation(peer); }
    } else if (!peer.negotiated) {
      peer.negotiated = true;
      afterFirstNegotiation(peer);
    }
  } catch (error) { console.error('Negotiation error:', error); }
}

async function handleCandidate(fromSocketId, candidate) {
  const peer = state.peers.get(fromSocketId);
  if (!peer?.pc || !candidate) return;
  if (!peer.pc.remoteDescription) { peer.candidates.push(candidate); return; }
  try { await peer.pc.addIceCandidate(candidate); }
  catch (error) { if (!peer.ignoreOffer) console.warn('ICE candidate error:', error); }
}

function handleRemoteTrack(peer, event) {
  adoptTransceivers(peer);
  const { track, transceiver } = event;
  const isCamera = transceiver === peer.audioT || transceiver === peer.videoT;
  if (isCamera && track.kind === 'audio') {
    if (!peer.audioEl) {
      peer.audioEl = document.createElement('audio');
      peer.audioEl.autoplay = true;
      peer.audioEl.playsInline = true;
      els.audioSink.appendChild(peer.audioEl);
    }
    peer.audioEl.srcObject = new MediaStream([track]);
    peer.audioEl.play().catch(() => showAudioUnlock());
  } else if (isCamera) {
    peer.remoteVideoStream = new MediaStream([track]);
    scheduleRender();
  } else {
    // Any additional transceiver is a shared screen (video, plus optional system audio).
    if (!peer.remoteScreen) peer.remoteScreen = new MediaStream();
    peer.remoteScreen.getTracks().filter((t) => t.kind === track.kind).forEach((t) => peer.remoteScreen.removeTrack(t));
    peer.remoteScreen.addTrack(track);
    scheduleRender();
  }
}

function tuneSenders(peer) {
  const pc = peer.pc;
  if (!pc || pc.signalingState !== 'stable') return;
  const count = Math.max(1, state.peers.size);
  const staff = isModerator();
  const jobs = [];
  if (peer.videoT?.sender) jobs.push([peer.videoT.sender, staff ? 900_000 : Math.round(Math.min(600_000, Math.max(150_000, 3_000_000 / count))), 0]);
  for (const sender of peer.screenSenders) {
    if (sender.track?.kind === 'video') jobs.push([sender, Math.round(Math.min(1_800_000, Math.max(250_000, 6_000_000 / count))), 15]);
  }
  for (const [sender, maxBitrate, maxFramerate] of jobs) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) continue;
      parameters.encodings[0].maxBitrate = maxBitrate;
      if (maxFramerate) parameters.encodings[0].maxFramerate = maxFramerate;
      sender.setParameters(parameters).catch(() => {});
    } catch (_) { /* not supported */ }
  }
}

function closePeer(socketId, { forget = true } = {}) {
  const peer = state.peers.get(socketId);
  if (peer) {
    try { peer.pc?.close(); } catch (_) { /* ignore */ }
    if (peer.audioEl) { peer.audioEl.srcObject = null; peer.audioEl.remove(); }
  }
  state.peers.delete(socketId);
  state.wants.delete(socketId);
  state.speaking.delete(socketId);
  state.lastSpoke.delete(socketId);
  if (state.activeSpeaker === socketId) state.activeSpeaker = null;
  if (state.pinned === socketId) state.pinned = null;
  if (forget) {
    state.participants.delete(socketId);
    const tile = state.tiles.get(socketId);
    if (tile) { tile.remove(); state.tiles.delete(socketId); }
  }
  scheduleRender();
}

function resetPeers() {
  for (const id of [...state.peers.keys()]) closePeer(id);
  state.participants.clear();
  state.tiles.forEach((tile) => tile.remove());
  state.tiles.clear();
  state.wants.clear();
  state.speaking.clear();
}

/* --------------------------------------------------------------- screen share */
async function startScreenShare() {
  if (state.sharing) return;
  if (!isModerator() && !state.session.allow_student_share) return showNotice('The host has not allowed students to share their screen.', 'warning');
  if (state.session.status !== 'live') return showNotice('Screen sharing is available once the class is live.', 'warning');
  if (!navigator.mediaDevices?.getDisplayMedia) return showNotice('Screen sharing is not supported by this browser or device. Use a desktop browser to present.', 'warning', 6000);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: true });
  } catch (error) {
    if (error.name !== 'NotAllowedError') showNotice(`Unable to share screen: ${error.message}`, 'error');
    return;
  }
  const result = await emitAck('screen-share-start');
  if (!result.ok) {
    stream.getTracks().forEach((t) => t.stop());
    return showNotice(result.message || 'Screen sharing was not allowed.', 'warning');
  }
  state.screenStream = stream;
  state.sharing = true;
  const video = stream.getVideoTracks()[0];
  if (video) { video.contentHint = 'detail'; video.addEventListener('ended', () => stopScreenShare()); }
  for (const peer of state.peers.values()) addScreenToPeer(peer);
  updateToolbar();
  scheduleRender();
}

function addScreenToPeer(peer) {
  if (!peer.pc || !state.screenStream || peer.screenSenders.length) return;
  peer.screenSenders = state.screenStream.getTracks().map((track) => peer.pc.addTrack(track, state.screenStream));
}

function stopScreenShare({ notify = true } = {}) {
  if (!state.sharing) return;
  state.sharing = false;
  for (const peer of state.peers.values()) {
    for (const sender of peer.screenSenders) { try { peer.pc.removeTrack(sender); } catch (_) { /* closed */ } }
    peer.screenSenders = [];
  }
  state.screenStream?.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  if (notify) state.socket?.emit('screen-share-stop');
  updateToolbar();
  scheduleRender();
}

/* --------------------------------------------------------------- participants */
function registerParticipant(participant, socketId = participant?.socketId) {
  if (!participant || !socketId) return;
  const previous = state.participants.get(socketId) || {};
  const merged = { ...previous, ...participant, socketId };
  merged.displayName = merged.displayName || `Participant ${merged.userId ?? ''}`.trim();
  merged.micState = merged.micState || 'unmuted';
  merged.camState = merged.camState || 'on';
  state.participants.set(socketId, merged);
  scheduleRender();
}

function participantPriority(p) {
  if (p.role === 'host') return 0;
  if (p.role === 'co-host') return 1;
  return 2;
}
function orderedOthers() {
  const me = selfId();
  return [...state.participants.values()]
    .filter((p) => p.socketId !== me)
    .sort((a, b) =>
      participantPriority(a) - participantPriority(b)
      || (state.lastSpoke.get(b.socketId) || 0) - (state.lastSpoke.get(a.socketId) || 0)
      || Number(Boolean(b.handRaised)) - Number(Boolean(a.handRaised))
      || a.displayName.localeCompare(b.displayName))
    .map((p) => p.socketId);
}

/* ------------------------------------------------------------- stage layout */
function pickSpeaker() {
  const me = selfId();
  const current = state.activeSpeaker;
  if (current && current !== me && state.participants.has(current)) return current;
  const others = orderedOthers();
  return others.find((id) => isStaffRole(state.participants.get(id))) || others[0] || me;
}

function featured() {
  const sharer = state.room.sharer;
  if (sharer) return { kind: 'screen', id: sharer.socketId };
  const spot = state.room.spotlightSocketId;
  if (spot && state.participants.has(spot)) return { kind: 'spotlight', id: spot };
  if (state.pinned && state.participants.has(state.pinned)) return { kind: 'pinned', id: state.pinned };
  if (state.layout === 'gallery') return { kind: 'none' };
  return { kind: 'speaker', id: pickSpeaker() };
}

function galleryPageSize() {
  if (isMobile()) return 6;
  return window.innerWidth < 1000 ? 9 : 25;
}
function galleryGrid(count) {
  const wide = els.stageMain.clientWidth >= els.stageMain.clientHeight;
  let cols;
  if (count <= 1) cols = 1;
  else if (count === 2) cols = wide ? 2 : 1;
  else if (count <= 4) cols = 2;
  else if (count <= 6) cols = wide ? 3 : 2;
  else if (count <= 9) cols = 3;
  else if (count <= 12) cols = wide ? 4 : 3;
  else if (count <= 16) cols = 4;
  else cols = 5;
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}

function buildTile(socketId) {
  const tile = document.createElement('article');
  tile.className = 'video-tile';
  tile.dataset.socketId = socketId;
  tile.innerHTML = `<video autoplay playsinline muted></video>
    <div class="tile-avatar"><span></span></div>
    <div class="tile-badges"></div>
    <div class="hand-indicator" hidden>✋</div>
    <button class="tile-menu-btn" aria-label="Participant options" aria-haspopup="true" aria-expanded="false"><i class="fas fa-ellipsis"></i></button>
    <div class="tile-bottom"><span class="tile-name"></span><span class="tile-icons"><i class="fas fa-microphone"></i><i class="fas fa-video"></i></span></div>`;
  const video = tile.querySelector('video');
  ['loadedmetadata', 'resize', 'playing'].forEach((name) => video.addEventListener(name, () => refreshTile(socketId)));
  tile.querySelector('.tile-menu-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    openFloatMenu(socketId, event.currentTarget);
  });
  tile.addEventListener('dblclick', () => togglePin(socketId));
  tile.addEventListener('click', (event) => {
    if (event.target.closest('.tile-menu-btn')) return;
    if (tile.parentElement === els.stageStrip) togglePin(socketId);
  });
  return tile;
}

function getTile(socketId) {
  let tile = state.tiles.get(socketId);
  if (!tile) { tile = buildTile(socketId); state.tiles.set(socketId, tile); }
  bindTileVideo(socketId, tile);
  refreshTile(socketId);
  return tile;
}

function bindTileVideo(socketId, tile) {
  const video = tile.querySelector('video');
  const stream = socketId === selfId() ? state.selfVideoStream : (state.peers.get(socketId)?.remoteVideoStream || null);
  if (video.srcObject !== stream) video.srcObject = stream;
  if (stream && video.paused) video.play().catch(() => {});
}

function refreshTile(socketId) {
  const tile = state.tiles.get(socketId);
  const p = state.participants.get(socketId);
  if (!tile || !p) return;
  const me = socketId === selfId();
  const micOff = me ? !state.micOn : p.micState === 'muted';
  const camOff = me ? !state.camOn : p.camState === 'off';
  tile.classList.toggle('local', me);
  tile.classList.toggle('speaking', state.speaking.has(socketId));
  tile.classList.toggle('pinned', state.pinned === socketId);
  tile.classList.toggle('spotlight', state.room.spotlightSocketId === socketId);
  tile.querySelector('.tile-name').textContent = `${p.displayName}${me ? ' (You)' : ''}`;
  tile.querySelector('.tile-avatar span').textContent = initials(p.displayName);
  const icons = tile.querySelectorAll('.tile-icons i');
  icons[0].className = `fas fa-microphone${micOff ? '-slash off' : ''}`;
  icons[1].className = `fas fa-video${camOff ? '-slash off' : ''}`;
  tile.querySelector('.hand-indicator').hidden = !(me ? state.handRaised : p.handRaised);
  const badges = [];
  if (p.role === 'host') badges.push('<span>Host</span>');
  else if (p.role === 'co-host') badges.push('<span>Co-host</span>');
  if (state.room.spotlightSocketId === socketId) badges.push('<span class="b-spot"><i class="fas fa-thumbtack"></i> Spotlight</span>');
  if (state.pinned === socketId) badges.push('<span class="b-pin"><i class="fas fa-thumbtack"></i> Pinned</span>');
  const badgeHtml = badges.join('');
  const badgeBox = tile.querySelector('.tile-badges');
  if (badgeBox.innerHTML !== badgeHtml) badgeBox.innerHTML = badgeHtml;
  const video = tile.querySelector('video');
  const hasVideo = me ? Boolean(state.camOn && state.cameraTrack) : (!camOff && video.videoWidth > 0);
  tile.dataset.novideo = hasVideo ? '0' : '1';
  tile.title = tile.parentElement === els.stageStrip ? 'Click to pin' : 'Double-click to pin';
}

function syncContainer(container, ids) {
  const tiles = ids.map((id) => getTile(id));
  [...container.children].forEach((child) => {
    if (child.classList.contains('video-tile') && !tiles.includes(child)) child.remove();
  });
  tiles.forEach((tile, index) => {
    const current = [...container.children].filter((c) => c.classList.contains('video-tile'))[index];
    if (current !== tile) container.insertBefore(tile, current || container.querySelector('.strip-more'));
    const video = tile.querySelector('video');
    if (video.srcObject && video.paused) video.play().catch(() => {});
  });
}

function renderStage() {
  const feat = featured();
  const layout = feat.kind === 'none' ? 'gallery' : 'speaker';
  const me = selfId();
  els.stage.dataset.layout = layout;
  els.meetingEmpty.hidden = state.participants.size > 0;
  renderScreenView(feat);
  renderStageBadge(feat);
  renderBanner();

  const displayed = [];
  if (layout === 'speaker') {
    els.galleryNav.hidden = true;
    const mainId = feat.kind === 'screen' ? null : feat.id;
    syncContainer(els.mainSlot, mainId && state.participants.has(mainId) ? [mainId] : []);
    if (mainId) displayed.push(mainId);
    const others = [me, ...orderedOthers()].filter((id) => id && id !== mainId && state.participants.has(id));
    const stripVisible = getComputedStyle(els.stageStrip).display !== 'none';
    const cap = isMobile() ? 3 : 6;
    let shown = others.slice(0, cap);
    if (me && others.includes(me) && !shown.includes(me)) shown = [me, ...shown.slice(0, cap - 1)];
    // The sharer's camera should be visible next to their shared screen.
    if (feat.kind === 'screen' && feat.id !== me && state.participants.has(feat.id) && !shown.includes(feat.id)) shown = [feat.id, ...shown.slice(0, cap - 1)];
    syncContainer(els.stageStrip, stripVisible ? shown : []);
    els.stageStrip.querySelectorAll('.strip-more').forEach((node) => node.remove());
    const hidden = others.length - shown.length;
    if (stripVisible && hidden > 0) {
      const more = document.createElement('button');
      more.className = 'strip-more';
      more.textContent = `+${hidden}`;
      more.title = 'Show everyone';
      more.addEventListener('click', () => openSidebar('participants'));
      els.stageStrip.appendChild(more);
    }
    if (stripVisible) displayed.push(...shown);
    syncContainer(els.galleryGrid, []);
  } else {
    const all = [me, ...orderedOthers()].filter((id) => id && state.participants.has(id));
    const size = galleryPageSize();
    const pages = Math.max(1, Math.ceil(all.length / size));
    state.galleryPage = Math.min(state.galleryPage, pages - 1);
    const pageIds = all.slice(state.galleryPage * size, (state.galleryPage + 1) * size);
    const { cols, rows } = galleryGrid(pageIds.length);
    els.galleryGrid.style.setProperty('--cols', cols);
    els.galleryGrid.style.setProperty('--rows', rows);
    syncContainer(els.mainSlot, []);
    syncContainer(els.stageStrip, []);
    syncContainer(els.galleryGrid, pageIds);
    displayed.push(...pageIds);
    els.galleryNav.hidden = pages <= 1;
    els.galleryPage.textContent = `${state.galleryPage + 1} / ${pages}`;
    els.galleryPrev.disabled = state.galleryPage === 0;
    els.galleryNext.disabled = state.galleryPage >= pages - 1;
  }
  state.tiles.forEach((_, id) => refreshTile(id));
  syncVideoWants(displayed);
  updateViewButtons(feat);
}

function renderScreenView(feat) {
  const show = feat.kind === 'screen';
  els.screenView.hidden = !show;
  if (!show) {
    if (els.screenVideo.srcObject) els.screenVideo.srcObject = null;
    return;
  }
  const sharer = state.room.sharer;
  const mine = sharer.socketId === selfId();
  els.screenSelf.hidden = !mine;
  els.screenVideo.hidden = mine;
  els.screenLabel.textContent = mine ? 'You are sharing your screen' : `${sharer.displayName} is sharing their screen`;
  if (!mine) {
    const stream = state.peers.get(sharer.socketId)?.remoteScreen || null;
    if (els.screenVideo.srcObject !== stream) els.screenVideo.srcObject = stream;
    if (stream) els.screenVideo.play().catch(() => showAudioUnlock());
  }
}

function renderStageBadge(feat) {
  const badge = els.stageBadge;
  const p = feat.id ? state.participants.get(feat.id) : null;
  if ((feat.kind === 'spotlight' || feat.kind === 'pinned') && p) {
    const spot = feat.kind === 'spotlight';
    const action = spot ? (isModerator() ? '<button data-badge="unspotlight">Remove</button>' : '') : '<button data-badge="unpin">Unpin</button>';
    badge.innerHTML = `<i class="fas fa-thumbtack"></i> ${spot ? 'Spotlight' : 'Pinned'}: ${escapeHtml(p.displayName)} ${action}`;
    badge.hidden = false;
  } else badge.hidden = true;
}

function renderBanner() {
  const sharer = state.room.sharer;
  if (sharer && isModerator() && sharer.socketId !== selfId()) {
    els.stageBanner.innerHTML = `<span><i class="fas fa-display"></i> ${escapeHtml(sharer.displayName)} is sharing their screen.</span><button data-banner="stop-share"><i class="fas fa-stop"></i> Stop sharing</button>`;
    els.stageBanner.hidden = false;
  } else els.stageBanner.hidden = true;
}

function updateViewButtons(feat) {
  const gallery = state.layout === 'gallery' && feat.kind === 'none';
  const label = gallery ? 'Speaker' : 'Gallery';
  const icon = gallery ? 'fa-user' : 'fa-table-cells-large';
  els.viewToggle.innerHTML = `<i class="fas ${icon}"></i><span>${label}</span>`;
  els.viewToggleBar.querySelector('span').innerHTML = `<i class="fas ${icon}"></i>`;
  els.viewToggleBar.querySelector('small').textContent = `${label} view`;
}

function syncVideoWants(displayed) {
  const me = selfId();
  const wanted = new Set(displayed.filter((id) => id && id !== me));
  for (const id of wanted) if (!state.wants.has(id)) state.socket?.emit('video-want', { targetSocketId: id, wanted: true });
  for (const id of state.wants) if (!wanted.has(id)) state.socket?.emit('video-want', { targetSocketId: id, wanted: false });
  state.wants = wanted;
}

/* ---------------------------------------------------------- panels & lists */
function renderParticipantsPanel() {
  const query = els.participantSearch.value.trim().toLowerCase();
  const me = selfId();
  const all = [...state.participants.values()];
  els.participantCount.textContent = all.length;
  els.toolbarCount.textContent = all.length;
  const rows = all
    .filter((p) => !query || [p.displayName, p.registrationNumber, p.role].some((v) => String(v || '').toLowerCase().includes(query)))
    .sort((a, b) => participantPriority(a) - participantPriority(b) || a.displayName.localeCompare(b.displayName));
  const row = (p) => {
    const self = p.socketId === me;
    const micOff = self ? !state.micOn : p.micState === 'muted';
    const camOff = self ? !state.camOn : p.camState === 'off';
    const raised = self ? state.handRaised : p.handRaised;
    const tags = [];
    if (p.role === 'host') tags.push('Host'); else if (p.role === 'co-host') tags.push('Co-host');
    if (state.room.sharer?.socketId === p.socketId) tags.push('Sharing');
    return `<article class="participant-row">
      <div class="participant-avatar">${escapeHtml(initials(p.displayName))}</div>
      <div class="participant-info"><strong>${escapeHtml(p.displayName)}${self ? ' (You)' : ''}</strong><small>${escapeHtml([...tags, p.registrationNumber].filter(Boolean).join(' · ') || 'Student')}</small></div>
      <div class="participant-state">
        ${raised ? '<i class="fas fa-hand raised" title="Hand raised"></i>' : ''}
        ${state.room.spotlightSocketId === p.socketId ? '<i class="fas fa-thumbtack tag-spot" title="Spotlighted"></i>' : ''}
        ${state.pinned === p.socketId ? '<i class="fas fa-thumbtack tag-pin" title="Pinned by you"></i>' : ''}
        <i class="fas fa-microphone${micOff ? '-slash off' : ''}"></i><i class="fas fa-video${camOff ? '-slash off' : ''}"></i>
        <button class="row-menu" data-menu="${escapeHtml(p.socketId)}" aria-label="Options for ${escapeHtml(p.displayName)}"><i class="fas fa-ellipsis"></i></button>
      </div></article>`;
  };
  const hands = rows.filter((p) => (p.socketId === me ? state.handRaised : p.handRaised));
  let html = '';
  if (hands.length) html += `<div class="list-heading">Raised hands (${hands.length})</div>${hands.map(row).join('')}`;
  const staff = rows.filter((p) => isStaffRole(p));
  const students = rows.filter((p) => !isStaffRole(p));
  if (staff.length) html += `<div class="list-heading">Hosts (${staff.length})</div>${staff.map(row).join('')}`;
  if (students.length) html += `<div class="list-heading">Students (${students.length})</div>${students.map(row).join('')}`;
  els.participantsList.innerHTML = html || '<div class="sidebar-empty">No participants match this search.</div>';
  els.participantTools.hidden = !isModerator();
}

function renderActiveNow() {
  if (els.attendanceBackdrop.hidden) return;
  const people = [...state.participants.values()].sort((a, b) => participantPriority(a) - participantPriority(b) || a.displayName.localeCompare(b.displayName));
  els.activeNowCount.textContent = people.length;
  els.activeNowList.innerHTML = people.length ? people.map((p) => {
    const me = p.socketId === selfId();
    return `<div class="active-row"><div class="av">${escapeHtml(initials(p.displayName))}</div>
      <div><strong>${escapeHtml(p.displayName)}${me ? ' (You)' : ''}</strong><small>${escapeHtml([p.role === 'student' ? p.registrationNumber : p.role, p.joinTime ? `joined ${formatTime(p.joinTime)}` : ''].filter(Boolean).join(' · '))}</small></div>
      <div class="st">${p.handRaised ? '<i class="fas fa-hand" style="color:#d98e00"></i>' : ''}<i class="fas fa-microphone${(me ? !state.micOn : p.micState === 'muted') ? '-slash off' : ''}"></i><i class="fas fa-video${(me ? !state.camOn : p.camState === 'off') ? '-slash off' : ''}"></i></div></div>`;
  }).join('') : '<div class="active-empty">Nobody is connected yet.</div>';
}

function appendChatMessage(message) {
  if (els.chatMessages.querySelector('.sidebar-empty')) els.chatMessages.innerHTML = '';
  const article = document.createElement('article');
  article.className = 'chat-message';
  article.innerHTML = `<div class="chat-message-head"><strong>${escapeHtml(message.displayName || 'Participant')}</strong><span>${formatTime(message.createdAt || Date.now())}</span></div><p>${escapeHtml(message.message || '')}</p>`;
  els.chatMessages.appendChild(article);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}
function onChatMessage(message) {
  appendChatMessage(message);
  const chatVisible = els.meetingApp.classList.contains('sidebar-open') && state.sidebarTab === 'chat';
  const mine = Number(message.userId) === Number(state.viewer?.userId) && message.userType === state.viewer?.userType;
  if (!chatVisible && !mine) { state.unread += 1; updateUnread(); }
}
function updateUnread() {
  const show = state.unread > 0;
  [els.chatBadge, els.toolbarChatBadge].forEach((el) => { el.hidden = !show; el.textContent = state.unread > 99 ? '99+' : state.unread; });
}
async function loadChat() {
  try {
    const data = await api(`/api/live/sessions/${sessionId}/chat`);
    els.chatMessages.innerHTML = '';
    (data.messages || []).forEach(appendChatMessage);
    if (!(data.messages || []).length) els.chatMessages.innerHTML = '<div class="sidebar-empty">Messages sent during this class appear here.</div>';
  } catch (error) { console.warn(error); }
}

function showReaction({ emoji, displayName }) {
  const item = document.createElement('div');
  item.className = 'floating-reaction';
  item.style.left = `${10 + Math.random() * 80}%`;
  item.textContent = emoji;
  item.title = displayName || '';
  els.reactionLayer.appendChild(item);
  setTimeout(() => item.remove(), 2800);
}

function render() {
  if (!state.joined) return;
  renderStage();
  renderParticipantsPanel();
  renderActiveNow();
}

/* ----------------------------------------------------------------- toolbar */
function updateToolbar() {
  const staff = isModerator();
  const studentMicBlocked = !staff && !state.session?.allow_student_mic;
  const studentCamBlocked = !staff && !state.session?.allow_student_video;
  els.toggleMic.classList.toggle('off', !state.micOn);
  els.toggleMic.classList.toggle('disabled', studentMicBlocked && !state.micOn);
  els.toggleMic.innerHTML = `<span><i class="fas fa-microphone${state.micOn ? '' : '-slash'}"></i></span><small>${state.micOn ? 'Mute' : 'Unmute'}</small>`;
  els.toggleMic.setAttribute('aria-label', state.micOn ? 'Mute microphone' : 'Unmute microphone');
  els.toggleCam.classList.toggle('off', !state.camOn);
  els.toggleCam.classList.toggle('disabled', studentCamBlocked && !state.camOn);
  els.toggleCam.innerHTML = `<span><i class="fas fa-video${state.camOn ? '' : '-slash'}"></i></span><small>${state.camOn ? 'Stop Video' : 'Start Video'}</small>`;
  els.toggleCam.setAttribute('aria-label', state.camOn ? 'Stop video' : 'Start video');
  els.raiseHand.hidden = staff;
  els.raiseHand.classList.toggle('hand-on', state.handRaised);
  els.raiseHand.querySelector('small').textContent = state.handRaised ? 'Lower Hand' : 'Raise Hand';
  const canShare = Boolean(navigator.mediaDevices?.getDisplayMedia);
  els.shareScreen.hidden = !canShare;
  els.shareScreen.classList.toggle('sharing', state.sharing);
  els.shareScreen.classList.toggle('disabled', !staff && !state.session?.allow_student_share && !state.sharing);
  els.shareScreen.querySelector('small').textContent = state.sharing ? 'Stop Share' : 'Share Screen';
  els.hostTools.hidden = !staff;
  els.toggleParticipants.classList.toggle('active', els.meetingApp.classList.contains('sidebar-open') && state.sidebarTab === 'participants');
  els.toggleChat.classList.toggle('active', els.meetingApp.classList.contains('sidebar-open') && state.sidebarTab === 'chat');
}

function sendPresence() {
  if (!state.socket?.connected) return;
  state.socket.emit('presence-update', { micState: state.micOn ? 'unmuted' : 'muted', camState: state.camOn ? 'on' : 'off' });
  const self = state.participants.get(selfId());
  if (self) registerParticipant({ ...self, micState: state.micOn ? 'unmuted' : 'muted', camState: state.camOn ? 'on' : 'off' }, selfId());
}

/* ------------------------------------------------------- sidebar & popovers */
function openSidebar(tab = 'participants') {
  state.sidebarTab = tab;
  els.meetingApp.classList.add('sidebar-open');
  document.querySelectorAll('.sidebar-tab').forEach((b) => b.classList.toggle('active', b.dataset.sideTab === tab));
  document.querySelectorAll('.sidebar-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `side-${tab}`));
  if (tab === 'chat') { state.unread = 0; updateUnread(); els.chatMessages.scrollTop = els.chatMessages.scrollHeight; if (!isMobile()) els.chatInput.focus(); }
  updateToolbar();
  setTimeout(scheduleRender, 230);
}
function closeSidebar() {
  els.meetingApp.classList.remove('sidebar-open');
  updateToolbar();
  setTimeout(scheduleRender, 230);
}
function toggleSidebar(tab) {
  if (els.meetingApp.classList.contains('sidebar-open') && state.sidebarTab === tab) closeSidebar();
  else openSidebar(tab);
}

function closeAllPopovers() {
  [els.floatMenu, els.securityPopover, els.morePopover, els.leavePopover, els.reactionMenu].forEach((el) => { el.hidden = true; });
  document.querySelectorAll('[aria-expanded="true"]').forEach((el) => el.setAttribute('aria-expanded', 'false'));
}
function placeFloating(el, anchor, prefer = 'below') {
  el.hidden = false;
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth; const h = el.offsetHeight;
  const rect = anchor && anchor.offsetParent !== null ? anchor.getBoundingClientRect() : null;
  let left; let top;
  if (!rect) { left = (window.innerWidth - w) / 2; top = window.innerHeight - h - 96; }
  else {
    left = Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8);
    if (prefer === 'above') left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
    top = prefer === 'above' ? rect.top - h - 8 : rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    if (top < 8) top = 8;
  }
  el.style.left = `${left}px`; el.style.top = `${top}px`;
}
function togglePopover(el, anchor, prefer = 'above') {
  const wasOpen = !el.hidden;
  closeAllPopovers();
  if (wasOpen) return;
  placeFloating(el, anchor, prefer);
  anchor?.setAttribute?.('aria-expanded', 'true');
}

function menuItemsFor(p) {
  const items = [];
  const me = p.socketId === selfId();
  const mod = isModerator();
  items.push(state.pinned === p.socketId
    ? { act: 'unpin', icon: 'thumbtack', label: 'Unpin (for me)' }
    : { act: 'pin', icon: 'thumbtack', label: 'Pin (for me)' });
  if (mod) {
    items.push(state.room.spotlightSocketId === p.socketId
      ? { act: 'unspotlight', icon: 'star', label: 'Remove spotlight' }
      : { act: 'spotlight', icon: 'star', label: 'Spotlight for everyone' });
  }
  if (mod && !me && p.role === 'student') {
    items.push(p.micState === 'muted'
      ? { act: 'ask-unmute', icon: 'microphone', label: 'Ask to unmute' }
      : { act: 'mute', icon: 'microphone-slash', label: 'Mute' });
    if (p.camState !== 'off') items.push({ act: 'camera-off', icon: 'video-slash', label: 'Stop video' });
    if (p.handRaised) items.push({ act: 'lower-hand', icon: 'hand', label: 'Lower hand' });
    if (state.room.sharer?.socketId === p.socketId) items.push({ act: 'stop-share', icon: 'display', label: 'Stop screen share' });
    items.push({ act: 'remove', icon: 'user-slash', label: 'Remove from class', danger: true });
  }
  if (mod && me && state.sharing) items.push({ act: 'stop-share-self', icon: 'display', label: 'Stop my screen share' });
  return items;
}

function openFloatMenu(socketId, anchor) {
  const p = state.participants.get(socketId);
  if (!p) return;
  const wasOpen = !els.floatMenu.hidden && els.floatMenu.dataset.target === socketId;
  closeAllPopovers();
  if (wasOpen) return;
  els.floatMenu.innerHTML = `<div class="menu-title">${escapeHtml(p.displayName)}</div>` + menuItemsFor(p).map((item) =>
    `<button role="menuitem" class="${item.danger ? 'danger' : ''}" data-act="${item.act}"><i class="fas fa-${item.icon}"></i> ${item.label}</button>`).join('');
  els.floatMenu.dataset.target = socketId;
  placeFloating(els.floatMenu, anchor, 'below');
  anchor.setAttribute('aria-expanded', 'true');
}

function togglePin(socketId) {
  state.pinned = state.pinned === socketId ? null : socketId;
  if (state.pinned) showNotice(`Pinned ${state.participants.get(socketId)?.displayName || 'participant'} on your screen.`, 'info', 1800);
  scheduleRender();
}

function runAction(act, socketId) {
  const socket = state.socket;
  if (act === 'pin') { state.pinned = socketId; scheduleRender(); }
  else if (act === 'unpin') { state.pinned = null; scheduleRender(); }
  else if (act === 'spotlight') socket.emit('moderator-spotlight', { targetSocketId: socketId });
  else if (act === 'unspotlight') socket.emit('moderator-unspotlight');
  else if (act === 'mute') socket.emit('moderator-mute', { targetSocketId: socketId });
  else if (act === 'ask-unmute') { socket.emit('moderator-ask-unmute', { targetSocketId: socketId }); showNotice('Request sent.', 'info', 1800); }
  else if (act === 'camera-off') socket.emit('moderator-camera-off', { targetSocketId: socketId });
  else if (act === 'lower-hand') socket.emit('moderator-lower-hand', { targetSocketId: socketId });
  else if (act === 'stop-share') socket.emit('moderator-stop-share', { targetSocketId: socketId });
  else if (act === 'stop-share-self') stopScreenShare();
  else if (act === 'remove') openRemoveModal(socketId);
}

function buildMorePopover() {
  const staff = isModerator();
  const item = (id, icon, label) => `<button data-more="${id}"><i class="fas fa-${icon}"></i> ${label}</button>`;
  const parts = [];
  if (!staff) parts.push(item('hand', 'hand', state.handRaised ? 'Lower hand' : 'Raise hand'));
  parts.push(`<div class="emoji-row">${['👏', '👍', '❤️', '🎉', '😂', '✋'].map((e) => `<button data-react="${e}">${e}</button>`).join('')}</div>`);
  parts.push(item('view', 'table-cells-large', state.layout === 'gallery' ? 'Speaker view' : 'Gallery view'));
  parts.push(item('camera', 'camera-rotate', 'Switch camera'));
  if (staff) { parts.push(item('host', 'user-shield', 'Host tools')); parts.push(item('attendance', 'clipboard-user', 'Attendance')); }
  parts.push(item('fullscreen', 'expand', 'Full screen'));
  els.morePopover.innerHTML = parts.join('');
}

/* ------------------------------------------------------------- attendance */
function openAttendance() {
  if (!isModerator()) return;
  closeAllPopovers();
  els.attendanceBackdrop.hidden = false;
  setAttendanceTab(state.attendanceTab);
  renderActiveNow();
  els.attendanceClose.focus();
}
function closeAttendance() { els.attendanceBackdrop.hidden = true; }
function setAttendanceTab(tab) {
  state.attendanceTab = tab;
  document.querySelectorAll('[data-att-tab]').forEach((b) => b.classList.toggle('active', b.dataset.attTab === tab));
  els.attActive.hidden = tab !== 'active';
  els.attReport.hidden = tab !== 'report';
  if (tab === 'report') loadAttendance();
}
async function loadAttendance() {
  if (!isModerator()) return;
  try {
    const report = await api(`/api/live/sessions/${sessionId}/report`);
    state.reportCache = report;
    const summary = report.summary;
    els.statExpected.textContent = summary.expectedStudents;
    els.statJoined.textContent = summary.totalJoined;
    els.statPresent.textContent = summary.present;
    els.statAbsent.textContent = summary.absent;
    els.statLate.textContent = summary.late;
    els.statRate.textContent = `${summary.attendanceRate}%`;
    els.exportAttendance.href = `/api/live/sessions/${sessionId}/report.csv`;
    renderReportRows();
  } catch (error) { showNotice(error.message, 'error'); }
}
function renderReportRows() {
  const report = state.reportCache;
  if (!report) return;
  const query = els.reportSearch.value.trim().toLowerCase();
  const rows = report.students.filter((item) => !query || [item.fullName, item.registrationNumber, item.status].some((v) => String(v || '').toLowerCase().includes(query)));
  els.attendanceRows.innerHTML = rows.length ? rows.map((item) => `<tr>
    <td><strong>${escapeHtml(item.fullName)}</strong><br><small>${escapeHtml(item.email || '')}</small></td>
    <td>${escapeHtml(item.registrationNumber)}</td>
    <td><span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
    <td>${item.firstJoin ? escapeHtml(formatDate(item.firstJoin)) : '—'}</td>
    <td>${escapeHtml(formatDuration(item.durationSeconds))}</td>
    <td>${item.late ? 'Yes' : 'No'}</td>
    <td>${escapeHtml(item.removalReason || (item.joinCount > 1 ? `${item.joinCount} connections` : ''))}</td>
  </tr>`).join('') : '<tr><td colspan="7">No students match.</td></tr>';
}

function openRemoveModal(socketId) {
  const participant = state.participants.get(socketId);
  if (!participant) return;
  state.removeTarget = participant;
  els.removeStudentName.textContent = `${participant.displayName} will be disconnected and blocked from rejoining this session.`;
  els.removeReason.value = '';
  els.removeModal.hidden = false;
  els.removeReason.focus();
}
function closeRemoveModal() { els.removeModal.hidden = true; state.removeTarget = null; }

/* ------------------------------------------------------------------ audio */
function showAudioUnlock() { els.audioUnlock.hidden = false; }
function unlockAudio() {
  state.audioCtx?.resume?.().catch(() => {});
  state.peers.forEach((peer) => peer.audioEl?.play().catch(() => {}));
  els.screenVideo.play().catch(() => {});
  state.tiles.forEach((tile) => tile.querySelector('video').play().catch(() => {}));
  els.audioUnlock.hidden = true;
}

/* ----------------------------------------------------------------- socket */
function connectSocket() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = io({ query: { sessionId: String(sessionId) }, transports: ['websocket', 'polling'] });
    state.socket = socket;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };

    socket.on('connect_error', (error) => { showNotice(`Unable to connect to the classroom: ${error.message}`, 'error', 0); fail(error); });
    socket.on('join-denied', (payload) => {
      socket.io.opts.reconnection = false;
      showNotice(payload.message || 'You cannot join this session.', payload.waiting ? 'warning' : 'error', 0);
      fail(new Error(payload.message || 'Join denied'));
    });

    socket.on('room-ready', (payload) => {
      const rejoin = state.joined;
      resetPeers();
      state.session = payload.session;
      state.room = payload.roomState || { spotlightSocketId: null, sharer: null };
      const self = { ...payload.self, micState: state.micOn ? 'unmuted' : 'muted', camState: state.camOn ? 'on' : 'off', handRaised: false };
      registerParticipant(self, socket.id);
      for (const participant of payload.participants || []) if (participant.socketId && participant.socketId !== socket.id) registerParticipant(participant, participant.socketId);
      state.joined = true;
      updateSessionHeader();
      for (const peer of payload.peers || []) {
        const entry = ensurePeer(peer.socketId, { ...state.participants.get(peer.socketId), ...peer });
        connectToPeer(entry);
      }
      startSpeakingDetector();
      sendPresence();
      clearInterval(state.heartbeat);
      state.heartbeat = setInterval(() => socket.emit('heartbeat'), 30000);
      if (state.sharing) { /* a reconnect dropped our share; stop cleanly */ stopScreenShare({ notify: false }); }
      showNotice(rejoin ? 'Reconnected to the class.' : `Joined as ${payload.self.role === 'co-host' ? 'Co-host' : payload.self.role}.`, 'success', 2500);
      render();
      if (!settled) { settled = true; resolve(); }
    });

    socket.on('peer-joined', ({ peer, participant }) => {
      ensurePeer(peer.socketId, { ...participant, ...peer });
      showNotice(`${peer.displayName} joined the class.`, 'info', 2000);
    });
    socket.on('webrtc-offer', ({ fromSocketId, sdp, peer }) => handleDescription(fromSocketId, sdp, peer));
    socket.on('webrtc-answer', ({ fromSocketId, sdp }) => handleDescription(fromSocketId, sdp));
    socket.on('webrtc-ice-candidate', ({ fromSocketId, candidate }) => handleCandidate(fromSocketId, candidate));
    socket.on('peer-left', ({ socketId, participant }) => {
      const name = state.participants.get(socketId)?.displayName || participant?.displayName || 'A participant';
      closePeer(socketId);
      showNotice(`${name} left the class.`, 'info', 2000);
    });
    socket.on('participant-updated', ({ participant }) => { if (participant?.socketId) registerParticipant(participant, participant.socketId); });
    socket.on('participants-refresh', () => refreshParticipants());
    socket.on('participant-count', () => scheduleRender());
    socket.on('participant-removed', ({ socketId }) => closePeer(socketId));

    socket.on('spotlight-changed', ({ targetSocketId, participant, by }) => {
      state.room.spotlightSocketId = targetSocketId || null;
      if (targetSocketId) showNotice(`${participant?.displayName || 'A participant'} is now spotlighted${by ? ` by ${by}` : ''}.`, 'info', 2500);
      else showNotice('Spotlight removed.', 'info', 1800);
      scheduleRender();
    });
    socket.on('screen-share-changed', ({ sharer, by }) => {
      state.room.sharer = sharer || null;
      if (!sharer) {
        state.peers.forEach((peer) => { peer.remoteScreen = null; });
        if (state.sharing) stopScreenShare({ notify: false });
      } else if (sharer.socketId !== selfId()) showNotice(`${sharer.displayName} started sharing their screen.`, 'info', 2500);
      updateToolbar();
      scheduleRender();
    });
    socket.on('force-stop-share', ({ by }) => { stopScreenShare(); showNotice(`${by || 'The host'} stopped your screen share.`, 'warning'); });
    socket.on('speaking', ({ socketId, speaking }) => onSpeakingChange(socketId, Boolean(speaking)));
    socket.on('video-want', ({ fromSocketId, wanted }) => {
      const peer = ensurePeer(fromSocketId);
      peer.wantsMyVideo = Boolean(wanted);
      applyVideoGate(peer);
    });

    socket.on('force-mute', ({ by }) => { setMic(false); showNotice(`${by || 'A host'} muted your microphone.`, 'warning'); });
    socket.on('force-camera-off', ({ by }) => { setCamera(false); showNotice(`${by || 'A host'} stopped your camera.`, 'warning'); });
    socket.on('unmute-request', ({ by }) => showNotice(`${by || 'The host'} asks you to unmute.`, 'info', 12000, { label: 'Unmute', run: () => setMic(true) }));
    socket.on('hand-lowered-by-host', () => { state.handRaised = false; updateToolbar(); scheduleRender(); });
    socket.on('removed-from-session', ({ reason }) => {
      socket.io.opts.reconnection = false;
      showNotice(`You were removed from this class. ${reason || ''}`, 'error', 0);
      cleanup(false);
      setTimeout(() => { location.href = '/student/live-classes'; }, 4500);
    });
    socket.on('chat-message', onChatMessage);
    socket.on('reaction', showReaction);
    socket.on('session-status', ({ status, session }) => {
      state.session = session || { ...state.session, status };
      updateSessionHeader();
      showNotice(status === 'live' ? 'The class is now live.' : `Session status changed to ${status}.`, 'success');
    });
    socket.on('room-lock-changed', ({ locked, by }) => {
      state.session.room_locked = locked ? 1 : 0;
      updateSessionHeader();
      showNotice(`${by || 'A host'} ${locked ? 'locked' : 'unlocked'} the room.`, 'info');
    });
    socket.on('student-permissions', ({ allowMic, allowVideo, allowShare }) => {
      state.session.allow_student_mic = allowMic ? 1 : 0;
      state.session.allow_student_video = allowVideo ? 1 : 0;
      state.session.allow_student_share = allowShare ? 1 : 0;
      if (!isModerator()) {
        if (!allowMic && state.micOn) setMic(false);
        if (!allowVideo && state.camOn) setCamera(false);
        if (!allowShare && state.sharing) stopScreenShare();
      }
      updateSessionHeader();
    });
    socket.on('session-ended', ({ by }) => {
      state.session.status = 'ended';
      stopScreenShare({ notify: false });
      updateSessionHeader();
      if (isModerator()) showNotice(`${by || 'The host'} ended the class. Open Attendance for the final report.`, 'warning', 0);
      else {
        showNotice(`${by || 'The host'} ended the class. Thank you for attending.`, 'warning', 0);
        setTimeout(() => { cleanup(); location.href = '/student/live-classes'; }, 4500);
      }
    });
    socket.on('disconnect', (reason) => {
      if (reason === 'io client disconnect' || reason === 'io server disconnect') return;
      showNotice('Connection lost. Trying to reconnect…', 'warning', 0);
    });
  });
}

async function refreshParticipants() {
  try {
    const data = await api(`/api/live/sessions/${sessionId}/participants`);
    for (const participant of data.participants || []) if (participant.socketId) registerParticipant(participant, participant.socketId);
  } catch (error) { console.warn(error); }
}

/* --------------------------------------------------------- session lifecycle */
async function loadSession() {
  if (!sessionId) throw new Error('No live session was selected.');
  const data = await api(`/api/live/sessions/${sessionId}`);
  if (data.session.type !== 'in-app') throw new Error('This page is only for internal portal meetings.');
  state.session = data.session;
  state.viewer = data.viewer;
  if (isModerator()) {
    els.backLink.href = '/admin#live';
    els.backLink.title = 'Return to admin dashboard';
    els.prejoinBack.href = '/admin#live';
    els.hostTools.hidden = false;
    els.exportAttendance.href = `/api/live/sessions/${sessionId}/report.csv`;
  }
  try { const ice = await api('/api/live/ice-servers'); if (ice.iceServers?.length) state.iceServers = ice.iceServers; } catch (_) { /* STUN only */ }
  return data;
}

function showPrejoin() {
  const session = state.session;
  els.prejoinTitle.textContent = session.title || session.topic || 'Live class';
  els.prejoinCourse.textContent = `${session.course_code || 'LIVE CLASS'} · ${formatDate(session.start_time)}`;
  els.prejoinInitials.textContent = initials(state.viewer.displayName);
  updatePrejoinState();
}

function updatePrejoinState() {
  const viewer = state.viewer;
  const ready = viewer.joinAllowed;
  els.prejoinJoin.disabled = !ready || state.joining;
  els.prejoinJoin.textContent = ready ? (isModerator() && state.session.status !== 'live' ? 'Join as host' : 'Join class') : 'Waiting for host…';
  if (!ready) els.prejoinMessage.textContent = viewer.waitingReason || 'The host has not started this session.';
  else if (!els.prejoinMessage.dataset.fixed) els.prejoinMessage.textContent = isModerator() && state.session.status !== 'live'
    ? 'You can join now and press “Start class” when you are ready to let students in.'
    : 'Check your camera and microphone, then join.';
}

function pollForStart() {
  clearInterval(state.waitTimer);
  state.waitTimer = setInterval(async () => {
    if (state.joined || state.viewer.joinAllowed) return;
    try {
      const data = await api(`/api/live/sessions/${sessionId}`);
      state.session = data.session; state.viewer = data.viewer;
      if (['ended', 'cancelled'].includes(state.session.status)) {
        clearInterval(state.waitTimer);
        els.prejoinMessage.textContent = 'This live session is no longer available.';
        els.prejoinMessage.dataset.fixed = '1';
        els.prejoinJoin.disabled = true;
        return;
      }
      updatePrejoinState();
      if (state.viewer.joinAllowed) clearInterval(state.waitTimer);
    } catch (error) { console.warn(error); }
  }, 5000);
}

async function joinMeeting() {
  if (state.joining || state.joined) return;
  state.joining = true;
  els.prejoinJoin.disabled = true;
  els.prejoinJoin.textContent = 'Joining…';
  try {
    adoptPreviewTracks();
    state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext || function () {})();
    await Promise.all([connectSocket(), loadChat()]);
    els.prejoin.hidden = true;
    els.meetingEmpty.hidden = true;
    updateToolbar();
    if (!isMobile() && window.innerWidth > 1100 && isModerator()) openSidebar('participants');
  } catch (error) {
    console.error(error);
    state.joining = false;
    state.socket?.disconnect();
    state.session && showPrejoin();
    return;
  }
  state.joining = false;
}

function cleanup(disconnect = true) {
  clearInterval(state.heartbeat); clearInterval(state.timer); clearInterval(state.detector); clearInterval(state.waitTimer);
  if (disconnect && state.socket) { state.socket.io.opts.reconnection = false; state.socket.disconnect(); }
  for (const peer of state.peers.values()) { try { peer.pc?.close(); } catch (_) { /* ignore */ } }
  state.peers.clear();
  [state.audioTrack, state.cameraTrack, pre.audioTrack, pre.videoTrack].forEach((t) => t?.stop());
  state.screenStream?.getTracks().forEach((t) => t.stop());
}

function leaveToDashboard() {
  cleanup();
  location.href = isModerator() ? '/admin#live' : '/student/live-classes';
}

/* ------------------------------------------------------------------ events */
function wireEvents() {
  // prejoin
  els.prejoinJoin.addEventListener('click', joinMeeting);
  els.prejoinMic.addEventListener('click', togglePreviewMic);
  els.prejoinCam.addEventListener('click', togglePreviewCam);
  els.prejoinCamSelect.addEventListener('change', () => changePreviewDevice('video'));
  els.prejoinMicSelect.addEventListener('change', () => changePreviewDevice('audio'));

  // toolbar
  els.toggleMic.addEventListener('click', () => setMic(!state.micOn));
  els.toggleCam.addEventListener('click', () => setCamera(!state.camOn));
  els.switchCamera.addEventListener('click', switchCamera);
  els.shareScreen.addEventListener('click', () => (state.sharing ? stopScreenShare() : startScreenShare()));
  els.stopShareInline.addEventListener('click', () => stopScreenShare());
  els.toggleParticipants.addEventListener('click', () => toggleSidebar('participants'));
  els.toggleChat.addEventListener('click', () => toggleSidebar('chat'));
  els.sidebarClose.addEventListener('click', closeSidebar);
  document.querySelectorAll('.sidebar-tab').forEach((button) => button.addEventListener('click', () => openSidebar(button.dataset.sideTab)));
  els.raiseHand.addEventListener('click', () => {
    if (isModerator()) return;
    state.handRaised = !state.handRaised;
    state.socket?.emit('raise-hand', { raised: state.handRaised });
    updateToolbar(); scheduleRender();
  });
  els.reactionButton.addEventListener('click', () => togglePopover(els.reactionMenu, els.reactionButton, 'above'));
  els.reactionMenu.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    state.socket?.emit('reaction', { emoji: button.textContent.trim() });
    closeAllPopovers();
  });
  els.securityButton.addEventListener('click', () => togglePopover(els.securityPopover, els.securityButton, 'above'));
  els.moreButton.addEventListener('click', () => { buildMorePopover(); togglePopover(els.morePopover, els.moreButton, 'above'); });
  els.morePopover.addEventListener('click', (event) => {
    const react = event.target.closest('[data-react]');
    if (react) { state.socket?.emit('reaction', { emoji: react.dataset.react }); return closeAllPopovers(); }
    const more = event.target.closest('[data-more]')?.dataset.more;
    if (!more) return;
    closeAllPopovers();
    if (more === 'hand') els.raiseHand.click();
    if (more === 'view') toggleView();
    if (more === 'camera') switchCamera();
    if (more === 'host') setTimeout(() => togglePopover(els.securityPopover, els.securityButton, 'above'), 0);
    if (more === 'attendance') openAttendance();
    if (more === 'fullscreen') toggleFullscreen();
  });
  els.leaveCall.addEventListener('click', () => {
    if (!isModerator()) return leaveToDashboard();
    togglePopover(els.leavePopover, els.leaveCall, 'above');
  });
  els.leaveOnly.addEventListener('click', leaveToDashboard);
  els.endSession.addEventListener('click', () => {
    closeAllPopovers();
    if (confirm('End this live class for every student and save the attendance report?')) state.socket?.emit('session-end');
  });
  els.startSession.addEventListener('click', () => state.socket?.emit('session-start'));
  els.viewToggle.addEventListener('click', toggleView);
  els.viewToggleBar.addEventListener('click', toggleView);
  els.fullscreenToggle.addEventListener('click', toggleFullscreen);
  els.screenFit.addEventListener('click', () => els.screenView.classList.toggle('fill'));
  els.audioUnlock.addEventListener('click', unlockAudio);
  els.galleryPrev.addEventListener('click', () => { state.galleryPage = Math.max(0, state.galleryPage - 1); scheduleRender(); });
  els.galleryNext.addEventListener('click', () => { state.galleryPage += 1; scheduleRender(); });

  // host popover
  const sendPermissions = () => state.socket?.emit('student-permissions', {
    allowMic: els.allowStudentMic.checked, allowVideo: els.allowStudentVideo.checked, allowShare: els.allowStudentShare.checked
  });
  els.allowStudentMic.addEventListener('change', sendPermissions);
  els.allowStudentVideo.addEventListener('change', sendPermissions);
  els.allowStudentShare.addEventListener('change', sendPermissions);
  els.lockToggle.addEventListener('change', () => state.socket?.emit('session-lock', { locked: els.lockToggle.checked }));
  const muteAll = () => { state.socket?.emit('mute-all-students'); closeAllPopovers(); };
  els.muteAll.addEventListener('click', muteAll);
  els.muteAllInline.addEventListener('click', muteAll);
  const lowerAll = () => { state.socket?.emit('moderator-lower-hand', { all: true }); closeAllPopovers(); };
  els.lowerHandsPop.addEventListener('click', lowerAll);
  els.lowerAllHands.addEventListener('click', lowerAll);
  els.clearSpotlight.addEventListener('click', () => { state.socket?.emit('moderator-unspotlight'); closeAllPopovers(); });

  // menus, list, badge, banner
  els.floatMenu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const target = els.floatMenu.dataset.target;
    closeAllPopovers();
    runAction(button.dataset.act, target);
  });
  els.participantsList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-menu]');
    if (button) openFloatMenu(button.dataset.menu, button);
  });
  els.participantSearch.addEventListener('input', renderParticipantsPanel);
  els.stageBadge.addEventListener('click', (event) => {
    const action = event.target.closest('[data-badge]')?.dataset.badge;
    if (action === 'unpin') { state.pinned = null; scheduleRender(); }
    if (action === 'unspotlight') state.socket?.emit('moderator-unspotlight');
  });
  els.stageBanner.addEventListener('click', (event) => {
    if (event.target.closest('[data-banner="stop-share"]')) state.socket?.emit('moderator-stop-share', {});
  });
  els.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = els.chatInput.value.trim();
    if (!message || !state.socket?.connected) return;
    state.socket.emit('chat-message', { message });
    els.chatInput.value = '';
  });

  // attendance drawer (host only; closes on X, backdrop click, Escape)
  els.showAttendance.addEventListener('click', openAttendance);
  els.attendanceClose.addEventListener('click', closeAttendance);
  els.attendanceBackdrop.addEventListener('click', (event) => { if (event.target === els.attendanceBackdrop) closeAttendance(); });
  document.querySelectorAll('[data-att-tab]').forEach((button) => button.addEventListener('click', () => setAttendanceTab(button.dataset.attTab)));
  els.refreshAttendance.addEventListener('click', loadAttendance);
  els.reportSearch.addEventListener('input', renderReportRows);

  // remove modal
  els.cancelRemove.addEventListener('click', closeRemoveModal);
  els.removeModal.addEventListener('click', (event) => { if (event.target === els.removeModal) closeRemoveModal(); });
  els.confirmRemove.addEventListener('click', () => {
    if (!state.removeTarget) return;
    state.socket.emit('moderator-remove', { targetSocketId: state.removeTarget.socketId, reason: els.removeReason.value.trim() || 'Removed for violating live-class rules.' });
    closeRemoveModal();
  });

  // global: close popovers on outside click, Esc, shortcuts, resize
  document.addEventListener('click', (event) => {
    if (event.target.closest('.popover, .float-menu, .reaction-menu, .tile-menu-btn, .row-menu, #moreButton, #securityButton, #reactionButton, #leaveCall')) return;
    closeAllPopovers();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.removeModal.hidden) closeRemoveModal();
      else if (!els.attendanceBackdrop.hidden) closeAttendance();
      else closeAllPopovers();
      return;
    }
    if (!state.joined || !event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'a') { event.preventDefault(); setMic(!state.micOn); }
    if (key === 'v') { event.preventDefault(); setCamera(!state.camOn); }
    if (key === 's') { event.preventDefault(); els.shareScreen.click(); }
    if (key === 'h') { event.preventDefault(); els.raiseHand.click(); }
  });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { closeAllPopovers(); scheduleRender(); }, 120); });
  window.addEventListener('orientationchange', () => setTimeout(scheduleRender, 250));
  document.addEventListener('fullscreenchange', () => { els.fullscreenToggle.innerHTML = `<i class="fas fa-${document.fullscreenElement ? 'compress' : 'expand'}"></i>`; scheduleRender(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) unlockAudioQuietly(); });
  window.addEventListener('beforeunload', () => cleanup());
}

function unlockAudioQuietly() {
  state.audioCtx?.resume?.().catch(() => {});
}

function toggleView() {
  const feat = featured();
  if (feat.kind === 'screen' || feat.kind === 'spotlight') {
    return showNotice(feat.kind === 'screen' ? 'A screen is being shared. Gallery view returns when sharing stops.' : 'The host has spotlighted someone. Gallery view returns when the spotlight is removed.', 'info', 3500);
  }
  state.layout = state.layout === 'gallery' && feat.kind === 'none' ? 'speaker' : 'gallery';
  if (state.layout === 'gallery') { state.pinned = null; state.galleryPage = 0; }
  scheduleRender();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => showNotice('Full screen is not available in this browser.', 'info'));
  if (!document.fullscreenEnabled) showNotice('Full screen is not available in this browser.', 'info');
}

async function initialise() {
  wireEvents();
  try {
    await loadSession();
    showPrejoin();
    pollForStart();
    await startPreview();
    updatePrejoinState();
  } catch (error) {
    console.error(error);
    els.prejoinMessage.textContent = error.message || 'Unable to open the live classroom.';
    els.prejoinMessage.dataset.fixed = '1';
    els.prejoinJoin.disabled = true;
    els.prejoinTitle.textContent = 'Unable to open classroom';
  }
}

initialise();
