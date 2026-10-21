import { api, escapeHtml, formatDate, showNotice, classStatus, wireLogout } from './portal.js';

const state = { announcements: [], materials: [], courses: [], liveClasses: [], students: [], staff: [], me: null };

const el = (id) => document.getElementById(id);
const statAllowed = el('statAllowed');
const statRegistered = el('statRegistered');
const statAnnouncements = el('statAnnouncements');
const statMaterials = el('statMaterials');
const announcementForm = el('announcementForm');
const annDestination = el('annDestination');
const annAudienceType = el('annAudienceType');
const annLevels = el('annLevels');
const annSingleStudent = el('annSingleStudent');
const annTitle = el('annTitle');
const annBody = el('annBody');
const announcementList = el('announcementList');
const materialForm = el('materialForm');
const matCode = el('matCode');
const matTitle = el('matTitle');
const matLevel = el('matLevel');
const matDescription = el('matDescription');
const matFile = el('matFile');
const matUrl = el('matUrl');
const materialList = el('materialList');
const courseForm = el('courseForm');
const courseLevel = el('courseLevel');
const courseSemester = el('courseSemester');
const courseCode = el('courseCode');
const courseUnits = el('courseUnits');
const courseTitle = el('courseTitle');
const courseGuide = el('courseGuide');
const courseOrder = el('courseOrder');
const courseList = el('courseList');
const liveForm = el('liveForm');
const liveCode = el('liveCode');
const liveTopic = el('liveTopic');
const liveType = el('liveType');
const liveStart = el('liveStart');
const liveEnd = el('liveEnd');
const liveLink = el('liveLink');
const liveLinkHint = el('liveLinkHint');
const liveAudience = el('liveAudience');
const liveCapacity = el('liveCapacity');
const liveThreshold = el('liveThreshold');
const recordingLink = el('recordingLink');
const liveDetails = el('liveDetails');
const liveList = el('liveList');
const studentSearch = el('studentSearch');
const studentStatus = el('studentStatus');
const studentList = el('studentList');
const resetForm = el('resetForm');
const resetReg = el('resetReg');
const inviteForm = el('inviteForm');
const inviteName = el('inviteName');
const inviteEmail = el('inviteEmail');
const inviteCodeBox = el('inviteCodeBox');
const staffList = el('staffList');
const attendanceModal = el('attendanceModal');
const closeAttendanceModal = el('closeAttendanceModal');
const attendanceModalTitle = el('attendanceModalTitle');
const attendanceModalMeta = el('attendanceModalMeta');
const downloadAttendanceCsv = el('downloadAttendanceCsv');
const reportAttendanceRows = el('reportAttendanceRows');

function activateTab(name) {
  document.querySelectorAll('.admin-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${name}`));
  document.querySelectorAll('.tab-button').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('.tab-button').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)));
document.querySelectorAll('.tab-jump').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.target)));

function empty(message) { return `<div class="empty"><i class="fas fa-inbox"></i><br>${escapeHtml(message)}</div>`; }

async function loadMe() {
  const { staff } = await api('/api/admin/me');
  state.me = staff;
  document.getElementById('staffIdentity').textContent = `${staff.full_name} · ${staff.role.toUpperCase()}`;
  if (staff.role !== 'hod') document.querySelectorAll('.hod-only').forEach((el) => el.style.display = 'none');
}

async function loadOverview() {
  const data = await api('/api/admin/overview');
  statAllowed.textContent = data.allowedStudents;
  statRegistered.textContent = data.registeredStudents;
  statAnnouncements.textContent = data.announcements;
  statMaterials.textContent = data.materials;
}

function getAnnouncementAudienceDetails(item) {
  const audienceType = String(item.audience_type || 'all_students');
  if (audienceType === 'single_student') return `Single student · ${escapeHtml(item.audience_student || 'Student')}`;
  if (audienceType === 'specific_level') return `Level · ${escapeHtml(item.audience_levels || '—')}`;
  if (audienceType === 'multiple_levels') return `Levels · ${escapeHtml(item.audience_levels || '—')}`;
  return 'All students';
}

async function loadAnnouncements() {
  const data = await api('/api/admin/announcements');
  state.announcements = Array.isArray(data.announcements) ? data.announcements : [];
  announcementList.innerHTML = state.announcements.length ? state.announcements.map((item) => `
    <article class="list-item">
      <div><div class="meta">${formatDate(item.created_at)} · ${escapeHtml(item.author_name)}</div><h3>${escapeHtml(item.title)}</h3><div class="body-text">${escapeHtml(item.body)}</div><div class="meta">${getAnnouncementAudienceDetails(item)}</div></div>
      <div class="actions"><span class="badge ${item.destination}">${item.destination === 'public' ? 'Main Website' : item.destination === 'student' ? 'Students' : 'Both'}</span><button class="btn btn-danger btn-small" data-delete-announcement="${item.id}"><i class="fas fa-trash"></i></button></div>
    </article>`).join('') : empty('No announcements have been published.');
}

function syncAnnouncementAudienceFields() {
  const visible = annAudienceType.value === 'single_student';
  const levelVisible = ['specific_level', 'multiple_levels'].includes(annAudienceType.value);
  document.getElementById('annLevelsRow').style.display = levelVisible ? 'block' : 'none';
  document.getElementById('annStudentRow').style.display = visible ? 'block' : 'none';
}

annAudienceType.addEventListener('change', syncAnnouncementAudienceFields);

announcementForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const audienceLevels = Array.from(annLevels.selectedOptions).map((option) => option.value).filter(Boolean);
  try {
    await api('/api/admin/announcements', {
      method:'POST',
      body:JSON.stringify({
        title:annTitle.value,
        body:annBody.value,
        destination:annDestination.value,
        audienceType:annAudienceType.value,
        audienceLevels,
        audienceStudent:annSingleStudent.value
      })
    });
    announcementForm.reset();
    annAudienceType.value = 'all_students';
    syncAnnouncementAudienceFields();
    showNotice('announcementNotice', '<i class="fas fa-check-circle"></i> Announcement published successfully.');
    await Promise.all([loadAnnouncements(), loadOverview()]);
  } catch (error) { showNotice('announcementNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
});

announcementList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-announcement]');
  if (!button || !confirm('Delete this announcement?')) return;
  try { await api(`/api/admin/announcements/${button.dataset.deleteAnnouncement}`, { method:'DELETE' }); await Promise.all([loadAnnouncements(), loadOverview()]); }
  catch (error) { showNotice('announcementNotice', escapeHtml(error.message), 'error'); }
});

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const MAX_BYTES = 100 * 1024 * 1024; // 100 MB
    if (file.size > MAX_BYTES) return reject(new Error('The selected file is larger than 100 MB.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

async function loadMaterials() {
  const data = await api('/api/admin/materials');
  state.materials = Array.isArray(data.materials) ? data.materials : [];
  materialList.innerHTML = state.materials.length ? state.materials.map((item) => `
    <article class="list-item"><div><div class="meta">${escapeHtml(item.course_code)} · ${escapeHtml(item.level)} · ${formatDate(item.created_at)}</div><h3>${escapeHtml(item.title)}</h3><div class="body-text">${escapeHtml(item.description || '')}</div><div class="meta">${item.original_name ? `File: ${escapeHtml(item.original_name)}` : ''}${item.resource_url ? ` · Link attached` : ''}</div></div><button class="btn btn-danger btn-small" data-delete-material="${item.id}"><i class="fas fa-trash"></i></button></article>`).join('') : empty('No course materials have been added.');
}

materialForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = materialForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const formData = new FormData();
    formData.append('courseCode', matCode.value);
    formData.append('title', matTitle.value);
    formData.append('level', matLevel.value);
    formData.append('description', matDescription.value);
    formData.append('resourceUrl', matUrl.value);
    const file = matFile.files[0] || null;
    if (file) formData.append('materialFile', file);
    await api('/api/admin/materials', { method:'POST', body: formData });
    materialForm.reset();
    showNotice('materialNotice', '<i class="fas fa-check-circle"></i> Material saved and is now available on the student materials page.');
    await Promise.all([loadMaterials(), loadOverview()]);
  } catch (error) { showNotice('materialNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
  finally { button.disabled = false; }
});

materialList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-material]');
  if (!button || !confirm('Delete this material and its uploaded file?')) return;
  try { await api(`/api/admin/materials/${button.dataset.deleteMaterial}`, { method:'DELETE' }); await Promise.all([loadMaterials(), loadOverview()]); }
  catch (error) { showNotice('materialNotice', escapeHtml(error.message), 'error'); }
});

function groupCourses(courses) {
  return courses.reduce((groups, course) => { (groups[course.semester] ||= []).push(course); return groups; }, {});
}

async function loadCourses() {
  const data = await api('/api/admin/courses');
  state.courses = Array.isArray(data.courses) ? data.courses : [];
  const groups = groupCourses(state.courses);
  courseList.innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([semester, courses]) => `
    <section class="section-card"><h3 class="section-title"><i class="fas fa-layer-group"></i> ${escapeHtml(semester)}</h3><div class="table-wrap"><table><thead><tr><th>Code</th><th>Title</th><th>Units</th><th>Guide</th><th></th></tr></thead><tbody>${courses.map((course) => `<tr><td><strong>${escapeHtml(course.course_code)}</strong></td><td>${escapeHtml(course.course_title)}</td><td>${course.units}</td><td>${escapeHtml(course.reading_guide || '')}</td><td><button class="btn btn-danger btn-small" data-delete-course="${course.id}"><i class="fas fa-trash"></i></button></td></tr>`).join('')}</tbody></table></div></section>`).join('') : empty('No course structure has been created.');
}

courseLevel.addEventListener('change', () => {
  const desired = `${courseLevel.value} First Semester`;
  if ([...courseSemester.options].some((option) => option.value === desired)) courseSemester.value = desired;
});

courseForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/admin/courses', { method:'POST', body:JSON.stringify({ level:courseLevel.value, semester:courseSemester.value, courseCode:courseCode.value, courseTitle:courseTitle.value, units:Number(courseUnits.value), readingGuide:courseGuide.value, sortOrder:Number(courseOrder.value) }) });
    courseForm.reset(); courseUnits.value = 2; courseOrder.value = 0;
    showNotice('courseNotice', '<i class="fas fa-check-circle"></i> Course added to the student course structure page.');
    await loadCourses();
  } catch (error) { showNotice('courseNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
});

courseList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-delete-course]');
  if (!button || !confirm('Delete this course from the structure?')) return;
  try { await api(`/api/admin/courses/${button.dataset.deleteCourse}`, { method:'DELETE' }); await loadCourses(); }
  catch (error) { showNotice('courseNotice', escapeHtml(error.message), 'error'); }
});

function reportDuration(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${secs}s` : `${secs}s`;
}

async function loadLiveClasses() {
  const data = await api('/api/admin/live-classes');
  state.liveClasses = Array.isArray(data.liveClasses) ? data.liveClasses : [];
  liveList.innerHTML = state.liveClasses.length ? state.liveClasses.map((item) => {
    const status = classStatus(item);
    const internal = item.type === 'in-app';
    const joinTarget = internal ? `/live/session?id=${item.id}` : escapeHtml(item.join_link);
    const joinAttrs = internal ? '' : ' target="_blank" rel="noopener"';
    const audience = item.audience_level || 'All Levels';
    return `<article class="list-item live-card"><div><div class="meta">${escapeHtml(item.course_code)} · ${formatDate(item.start_time)} · ${escapeHtml(audience)}</div><h3>${status === 'live' ? '<span class="live-pulse"></span> ' : ''}${escapeHtml(item.topic)}</h3><small class="muted">${internal ? 'Internal Zoom-style Classroom' : 'External Meeting Link'}</small><div class="body-text">${escapeHtml(item.details || '')}</div><div class="actions" style="margin-top:9px"><a class="btn btn-secondary btn-small" href="${joinTarget}"${joinAttrs}><i class="fas fa-${internal ? 'video' : 'arrow-up-right-from-square'}"></i> ${internal ? 'Join as Admin' : 'Open External Link'}</a><button class="btn btn-outline btn-small" data-live-report="${item.id}"><i class="fas fa-chart-column"></i> Attendance</button>${item.recording_link ? `<a class="btn btn-outline btn-small" href="${escapeHtml(item.recording_link)}" target="_blank" rel="noopener"><i class="fas fa-play"></i> Recording</a>` : ''}</div></div><div class="actions"><span class="badge ${status}">${status}</span><select data-live-status="${item.id}" aria-label="Change class status"><option value="scheduled" ${item.status==='scheduled'?'selected':''}>Scheduled</option><option value="live" ${item.status==='live'?'selected':''}>Live</option><option value="ended" ${item.status==='ended'?'selected':''}>Ended</option><option value="cancelled" ${item.status==='cancelled'?'selected':''}>Cancelled</option></select><button class="btn btn-danger btn-small" data-delete-live="${item.id}"><i class="fas fa-trash"></i></button></div></article>`;
  }).join('') : empty('No live classes are scheduled.');
}

liveType.addEventListener('change', () => {
  if (liveType.value === 'in-app') {
    liveLink.removeAttribute('required');
    liveLink.value = '';
    liveLink.disabled = true;
    liveLink.placeholder = 'Automatically created inside the portal';
    liveLinkHint.textContent = 'The internal room is generated automatically. Staff join as Host or Co-host and student attendance is recorded.';
    document.getElementById('liveTypeHelp').textContent = 'Internal meetings include video tiles, screen sharing, chat, student spotlight, moderation and attendance.';
  } else {
    liveLink.disabled = false;
    liveLink.setAttribute('required', 'required');
    liveLink.placeholder = 'https://zoom.us/j/...';
    liveLinkHint.textContent = 'Provide a Zoom, Google Meet, Teams or other external meeting URL. Portal link openings are recorded for attendance.';
    document.getElementById('liveTypeHelp').textContent = 'External meetings open in a new tab. Use the internal option for full portal controls.';
  }
});

liveForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const payload = {
      courseCode: liveCode.value,
      topic: liveTopic.value,
      title: liveTopic.value,
      type: liveType.value,
      audienceLevel: liveAudience.value,
      capacityLimit: liveCapacity.value ? Number(liveCapacity.value) : null,
      attendanceThresholdMinutes: Number(liveThreshold.value || 1),
      startTime: liveStart.value,
      endTime: liveEnd.value,
      joinLink: liveLink.value,
      recordingLink: recordingLink.value,
      details: liveDetails.value
    };
    if (payload.type === 'in-app') delete payload.joinLink;
    await api('/api/admin/live-classes', { method:'POST', body:JSON.stringify(payload) });
    liveForm.reset();
    liveType.value = 'in-app';
    liveThreshold.value = 1;
    liveType.dispatchEvent(new Event('change'));
    showNotice('liveNotice', '<i class="fas fa-check-circle"></i> Live class scheduled. The creator will join as Host and other staff can join as Co-hosts.');
    await Promise.all([loadLiveClasses(), loadOverview()]);
  } catch (error) { showNotice('liveNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
});

liveList.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-live-status]');
  if (!select) return;

  const selectedStatus = select.value;
  const current = state.liveClasses.find((item) => String(item.id) === String(select.dataset.liveStatus));
  const previousStatus = current?.status || 'scheduled';

  if (selectedStatus === 'cancelled' && !window.confirm('Cancel this live class? Students will no longer be able to join it.')) {
    select.value = previousStatus;
    return;
  }

  select.disabled = true;
  try {
    await api(`/api/admin/live-classes/${select.dataset.liveStatus}`, {
      method:'PUT',
      body:JSON.stringify({ status:selectedStatus })
    });
    showNotice(
      'liveNotice',
      `<i class="fas fa-check-circle"></i> Live class status changed to ${escapeHtml(selectedStatus)}.`
    );
    await loadLiveClasses();
  } catch (error) {
    select.value = previousStatus;
    showNotice('liveNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error');
  } finally {
    select.disabled = false;
  }
});

async function openAttendanceReport(id) {
  try {
    const report = await api(`/api/live/sessions/${id}/report`);
    attendanceModalTitle.textContent = `${report.session.course_code} — ${report.session.topic}`;
    attendanceModalMeta.textContent = `${formatDate(report.session.start_time)} · Minimum attendance: ${report.summary.attendanceThresholdMinutes} minute(s)`;
    el('reportExpected').textContent = report.summary.expectedStudents;
    el('reportJoined').textContent = report.summary.totalJoined;
    el('reportPresent').textContent = report.summary.present;
    el('reportAbsent').textContent = report.summary.absent;
    el('reportLate').textContent = report.summary.late;
    el('reportRate').textContent = `${report.summary.attendanceRate}%`;
    downloadAttendanceCsv.href = `/api/live/sessions/${id}/report.csv`;
    reportAttendanceRows.innerHTML = report.students.length ? report.students.map((student) => `<tr><td><strong>${escapeHtml(student.fullName)}</strong><br><small>${escapeHtml(student.email || '')}</small></td><td>${escapeHtml(student.registrationNumber)}</td><td>${escapeHtml(student.level)}</td><td><span class="attendance-status ${escapeHtml(student.status)}">${escapeHtml(student.status)}</span></td><td>${student.firstJoin ? formatDate(student.firstJoin) : '—'}</td><td>${reportDuration(student.durationSeconds)}</td><td>${student.late ? 'Yes' : 'No'}</td><td>${escapeHtml(student.removalReason || (student.joinCount > 1 ? `${student.joinCount} connections` : ''))}</td></tr>`).join('') : '<tr><td colspan="8">No students are available for this report.</td></tr>';
    setAttendanceModalOpen(true);
  } catch (error) { showNotice('liveNotice', escapeHtml(error.message), 'error'); }
}

liveList.addEventListener('click', async (event) => {
  const reportButton = event.target.closest('[data-live-report]');
  if (reportButton) return openAttendanceReport(reportButton.dataset.liveReport);
  const button = event.target.closest('[data-delete-live]');
  if (!button || !confirm('Delete this live class and its attendance history?')) return;
  try { await api(`/api/admin/live-classes/${button.dataset.deleteLive}`, { method:'DELETE' }); await Promise.all([loadLiveClasses(), loadOverview()]); }
  catch (error) { showNotice('liveNotice', escapeHtml(error.message), 'error'); }
});

function setAttendanceModalOpen(open) {
  attendanceModal.hidden = !open;
  attendanceModal.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.style.overflow = open ? 'hidden' : '';
}

closeAttendanceModal.addEventListener('click', () => setAttendanceModalOpen(false));
attendanceModal.addEventListener('click', (event) => {
  if (event.target === attendanceModal) setAttendanceModalOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !attendanceModal.hidden) setAttendanceModalOpen(false);
});
setAttendanceModalOpen(false);
liveType.value = 'in-app';
liveType.dispatchEvent(new Event('change'));

async function loadStudents() {
  const data = await api('/api/admin/students');
  state.students = Array.isArray(data.students) ? data.students : [];
  renderStudents();
}

function renderStudents() {
  const query = studentSearch.value.trim().toLowerCase();
  const status = studentStatus.value;
  const rows = state.students.filter((student) => {
    const matchesQuery = !query || [student.reg_number, student.full_name, student.email].some((value) => String(value || '').toLowerCase().includes(query));
    const matchesStatus = status === 'all' || (status === 'registered' && student.registered) || (status === 'pending' && !student.registered);
    return matchesQuery && matchesStatus;
  });
  studentList.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Registration No.</th><th>Name</th><th>Email</th><th>Level</th><th>Status</th></tr></thead><tbody>${rows.map((student) => `<tr><td><strong>${escapeHtml(student.reg_number)}</strong></td><td>${escapeHtml(student.full_name || 'Not registered')}</td><td>${escapeHtml(student.email || '—')}</td><td>${escapeHtml(student.level || '—')}</td><td><span class="badge ${student.registered ? 'student' : ''}">${student.registered ? 'Registered' : 'Pending'}</span></td></tr>`).join('')}</tbody></table></div>` : empty('No students match this filter.');
}
studentSearch.addEventListener('input', renderStudents); studentStatus.addEventListener('change', renderStudents);

resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/admin/students/reset-password', { method:'POST', body:JSON.stringify({ regNumber:resetReg.value }) });
    showNotice('resetNotice', `<i class="fas fa-key"></i> Temporary password for <strong>${escapeHtml(data.studentName)}</strong>: <span class="code-box">${escapeHtml(data.temporaryPassword)}</span>`, 'success');
    resetForm.reset();
  } catch (error) { showNotice('resetNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
});

async function loadStaff() {
  if (state.me?.role !== 'hod') return;
  const data = await api('/api/admin/staff');
  state.staff = Array.isArray(data.staff) ? data.staff : [];
  staffList.innerHTML = state.staff.map((member) => `<article class="list-item"><div><h3>${escapeHtml(member.full_name)}</h3><div class="meta">${escapeHtml(member.email || '')} · ${escapeHtml(member.login_code || '')}</div></div><span class="badge ${member.role === 'hod' ? 'both' : 'public'}">${member.role}</span></article>`).join('');
}

inviteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/auth/admin/invite-lecturer', { method:'POST', body:JSON.stringify({ fullName:inviteName.value, email:inviteEmail.value }) });
    inviteCodeBox.style.display = 'block';
    inviteCodeBox.innerHTML = `<div class="code-box"><strong>One-time invite code:</strong><br>${escapeHtml(data.inviteCode)}</div><p class="muted" style="margin-top:8px">Send this code privately to the lecturer. They should open <strong>/accept-invite.html</strong>.</p>`;
    showNotice('inviteNotice', '<i class="fas fa-check-circle"></i> Lecturer invitation generated.');
    inviteForm.reset();
  } catch (error) { showNotice('inviteNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
});

async function initialise() {
  wireLogout();
  try {
    await loadMe();
    await Promise.all([loadOverview(), loadAnnouncements(), loadMaterials(), loadCourses(), loadLiveClasses(), loadStudents(), loadStaff()]);
    const requested = location.hash.replace('#', '');
    if (requested && document.getElementById(`panel-${requested}`)) activateTab(requested);
  } catch (error) {
    console.error(error);
    alert(error.message);
  }
}

initialise();
