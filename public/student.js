import { api, escapeHtml, formatDate, classStatus, showNotice, wireLogout } from './portal.js';

const page = document.body.dataset.page;
const state = { me: null, materials: [], courses: [], liveClasses: [], announcementFilter: 'unread' };

const announcementModal = (() => {
  let modal = document.getElementById('announcementModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'announcementModal';
    modal.className = 'announcement-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="announcement-modal-backdrop" data-close-announcement-modal="true"></div>
      <div class="announcement-modal-card" role="dialog" aria-modal="true" aria-labelledby="announcementModalTitle">
        <button class="announcement-modal-close" type="button" aria-label="Close announcement" data-close-announcement-modal="true"><i class="fas fa-times"></i></button>
        <div class="announcement-modal-header">
          <div class="announcement-modal-badge"><i class="fas fa-bell"></i> Department Notice</div>
          <div class="announcement-modal-meta" id="announcementModalMeta"></div>
        </div>
        <h3 id="announcementModalTitle">Announcement</h3>
        <div class="announcement-modal-body" id="announcementModalBody"></div>
        <div class="announcement-modal-footer" id="announcementModalFooter"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  return modal;
})();

const announcementModalTitle = document.getElementById('announcementModalTitle');
const announcementModalMeta = document.getElementById('announcementModalMeta');
const announcementModalBody = document.getElementById('announcementModalBody');
const announcementModalFooter = document.getElementById('announcementModalFooter');

const el = (id) => document.getElementById(id);
const welcomeName = el('welcomeName');
const studentLevel = el('studentLevel');
const countAnnouncements = el('countAnnouncements');
const countMaterials = el('countMaterials');
const countLive = el('countLive');
const dashboardAnnouncements = el('dashboardAnnouncements');
const dashboardLive = el('dashboardLive');
const studentAnnouncements = el('studentAnnouncements');
const materialSearch = el('materialSearch');
const materialLevel = el('materialLevel');
const studentMaterials = el('studentMaterials');
const courseLevelFilter = el('courseLevelFilter');
const studentCourses = el('studentCourses');
const liveStatusFilter = el('liveStatusFilter');
const studentLiveClasses = el('studentLiveClasses');
const settingsForm = el('settingsForm');
const settingsReg = el('settingsReg');
const settingsEmail = el('settingsEmail');
const settingsName = el('settingsName');
const settingsPhone = el('settingsPhone');
const settingsCourse = el('settingsCourse');
const settingsLevel = el('settingsLevel');

function empty(message) { return `<div class="empty"><i class="fas fa-inbox"></i><br>${escapeHtml(message)}</div>`; }

function getAnnouncementReadStorageKey() {
  return `portal.announcementReads.${state.me?.student?.id || state.me?.id || 'guest'}`;
}

function getAnnouncementReadIds() {
  try {
    const key = getAnnouncementReadStorageKey();
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [];
    return new Set(items.map((value) => String(value)));
  } catch (error) {
    return new Set();
  }
}

function persistAnnouncementReadIds(ids) {
  try {
    localStorage.setItem(getAnnouncementReadStorageKey(), JSON.stringify([...ids].sort((a, b) => Number(a) - Number(b))));
  } catch (error) {
    // ignore storage failures for unsupported environments
  }
}

function announcementIsRead(item) {
  if (!item) return false;
  const id = String(item.id);
  if (item.is_read) return true;
  return getAnnouncementReadIds().has(id);
}

function renderAnnouncementFilterButtons() {
  const target = dashboardAnnouncements || studentAnnouncements;
  if (!target) return;
  let toolbar = document.getElementById('announcementFilterBar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = 'announcementFilterBar';
    toolbar.className = 'announcement-filter-bar';
    toolbar.innerHTML = `
      <button type="button" class="announcement-filter-button ${state.announcementFilter === 'unread' ? 'active' : ''}" data-announcement-filter="unread">Unread</button>
      <button type="button" class="announcement-filter-button ${state.announcementFilter === 'all' ? 'active' : ''}" data-announcement-filter="all">All Messages</button>
    `;
    target.parentNode.insertBefore(toolbar, target);
  }
  toolbar.querySelectorAll('.announcement-filter-button').forEach((button) => {
    const isActive = button.dataset.announcementFilter === state.announcementFilter;
    button.classList.toggle('active', isActive);
  });
}

function renderAnnouncementViews() {
  const items = Array.isArray(state.me?.announcements) ? state.me.announcements : [];
  const unreadItems = items.filter((item) => !announcementIsRead(item));

  if (dashboardAnnouncements) {
    const dashboardItems = unreadItems.slice(0, 3);
    renderAnnouncements(dashboardItems, dashboardAnnouncements);
    if (countAnnouncements) countAnnouncements.textContent = String(unreadItems.length);
  }

  if (studentAnnouncements) {
    renderAnnouncements(items, studentAnnouncements);
  }
}

async function setupIdentity() {
  const data = await api('/api/student/me');
  state.me = data;
  if (data.role === 'staff-preview') {
    const banner = document.getElementById('previewBanner');
    if (banner) banner.innerHTML = '<div class="preview-banner"><i class="fas fa-eye"></i> Staff preview: you are viewing the same content students see.</div>';
    const adminBack = document.getElementById('adminBack');
    if (adminBack) adminBack.style.display = 'inline-flex';
    if (page === 'settings') {
      settingsForm.querySelectorAll('input,select,button').forEach((control) => control.disabled = true);
      showNotice('settingsNotice', '<i class="fas fa-lock"></i> Profile editing is disabled in staff preview mode.', 'info');
    }
  }
  return data.student;
}

function previewAnnouncementBody(body, shouldTruncate = false) {
  const text = String(body || '').trim();
  if (!text) return '';
  if (!shouldTruncate || text.length <= 100) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, 100).trim())}... <span class="read-more">read more</span>`;
}

function renderAnnouncements(items, container) {
  const compact = container === dashboardAnnouncements;
  const visibleItems = items.filter((item) => state.announcementFilter === 'all' || !announcementIsRead(item));
  container.innerHTML = visibleItems.length ? visibleItems.map((item) => {
    const isRead = announcementIsRead(item);
    const readState = isRead ? 'is-read' : 'unread';
    const bodyPreview = previewAnnouncementBody(item.body, compact);
    return `<article class="list-item announcement-card ${readState}" tabindex="0" data-announcement-id="${item.id}" data-announcement-title="${escapeHtml(item.title)}" aria-label="Open announcement: ${escapeHtml(item.title)}">
      <div class="announcement-content">
        <div class="meta">${formatDate(item.created_at)} · ${escapeHtml(item.author_name)}</div>
        <h3>${escapeHtml(item.title)}</h3>
        <div class="body-text">${bodyPreview}</div>
        <div class="announcement-footer-row">
          <span class="announcement-read-state">${isRead ? '<i class="fas fa-check-circle"></i> Read' : '<i class="fas fa-circle"></i> New'}</span>
          ${item.read_count ? `<span class="announcement-count">${Number(item.read_count)} read</span>` : ''}
        </div>
      </div>
      <span class="badge student"><i class="fas fa-bell"></i> Notice</span>
    </article>`;
  }).join('') : empty(state.announcementFilter === 'unread' ? 'No unread announcements.' : 'No student announcements have been posted.');
  bindAnnouncementCards();
}

function closeAnnouncementModal() {
  announcementModal.classList.remove('active');
  announcementModal.setAttribute('aria-hidden', 'true');
}

function openAnnouncementModal(item) {
  if (!item) return;
  announcementModalTitle.textContent = item.title || 'Announcement';
  announcementModalMeta.textContent = `${formatDate(item.created_at)} · Posted by ${item.author_name || 'Department'}`;
  announcementModalBody.innerHTML = `<div class="announcement-modal-message">${escapeHtml(String(item.body || '').trim() || 'No announcement message was added.')}</div>`;

  const attachmentHtml = item.attachment_url
    ? `<a class="btn btn-primary btn-small" href="${escapeHtml(item.attachment_url)}" target="_blank" rel="noopener"><i class="fas fa-paperclip"></i> ${escapeHtml(item.attachment_label || 'Download attachment')}</a>`
    : '';
  announcementModalFooter.innerHTML = attachmentHtml;
  announcementModal.classList.add('active');
  announcementModal.setAttribute('aria-hidden', 'false');

  if (announcementIsRead(item)) return;

  const readIds = getAnnouncementReadIds();
  readIds.add(String(item.id));
  persistAnnouncementReadIds(readIds);

  api(`/api/student/announcements/${item.id}/read`, { method: 'POST', body: '{}' })
    .then((response) => {
      item.is_read = true;
      item.read_count = Number(response.count || item.read_count || 0);
      const cards = document.querySelectorAll(`[data-announcement-id="${item.id}"]`);
      cards.forEach((card) => {
        card.classList.add('announcement-exit');
        setTimeout(() => {
          if (state.announcementFilter === 'unread') {
            card.remove();
          } else {
            card.classList.remove('announcement-exit');
            card.classList.remove('unread');
            card.classList.add('is-read');
            const stateBadge = card.querySelector('.announcement-read-state');
            const countBadge = card.querySelector('.announcement-count');
            if (stateBadge) stateBadge.innerHTML = '<i class="fas fa-check-circle"></i> Read';
            if (countBadge) countBadge.textContent = `${Number(item.read_count)} read`;
          }
          renderAnnouncementViews();
        }, 220);
      });
    })
    .catch((error) => {
      const ids = getAnnouncementReadIds();
      ids.delete(String(item.id));
      persistAnnouncementReadIds(ids);
      console.error('Could not mark announcement as read:', error);
    });
}

function bindAnnouncementCards() {
  document.querySelectorAll('.announcement-card').forEach((card) => {
    const open = () => {
      const id = Number(card.dataset.announcementId);
      const item = [...(state.me?.announcements || [])].find((entry) => Number(entry.id) === id)
        || [...(state.materials || [])].find((entry) => Number(entry.id) === id)
        || null;
      const announcement = item || (state.me && state.me.announcementLookup ? state.me.announcementLookup[id] : null);
      if (announcement) openAnnouncementModal(announcement);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
  });
}

function renderLiveCards(items, container) {
  container.innerHTML = items.length ? items.map((item) => {
    const status = classStatus(item);
    const canJoin = status === 'scheduled' || status === 'live';
    const internal = item.type === 'in-app';
    const joinControl = internal
      ? `<a class="btn btn-primary btn-small" href="/live/session?id=${encodeURIComponent(item.id)}"><i class="fas fa-video"></i> ${status === 'live' ? 'Join Live Classroom' : 'Enter Waiting Room'}</a>`
      : `<button class="btn btn-primary btn-small" data-external-session="${item.id}"><i class="fas fa-arrow-up-right-from-square"></i> ${status === 'live' ? 'Join External Class' : 'Open Meeting Link'}</button>`;
    return `<article class="list-item live-card"><div><div class="meta">${escapeHtml(item.course_code)} · ${formatDate(item.start_time)}${item.end_time ? ` – ${formatDate(item.end_time)}` : ''} · ${escapeHtml(item.audience_level || 'All Levels')}</div><h3>${status === 'live' ? '<span class="live-pulse"></span> ' : ''}${escapeHtml(item.topic)}</h3><div class="meta"><strong>${internal ? 'Internal Zoom-style Classroom' : 'External Meeting'}</strong></div><div class="body-text">${escapeHtml(item.details || 'No additional class details.')}</div><div class="actions" style="margin-top:10px">${canJoin ? joinControl : ''}${item.recording_link ? `<a class="btn btn-outline btn-small" href="${escapeHtml(item.recording_link)}" target="_blank" rel="noopener"><i class="fas fa-play"></i> Recording</a>` : ''}</div></div><span class="badge ${status}">${status}</span></article>`;
  }).join('') : empty('No live classes match this view.');
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-external-session]');
  if (!button) return;
  event.preventDefault();
  const popup = window.open('', '_blank', 'noopener');
  try {
    const data = await api(`/api/live/sessions/${button.dataset.externalSession}/external-join`, { method:'POST', body:'{}' });
    if (popup) popup.location.href = data.joinLink;
    else window.location.href = data.joinLink;
  } catch (error) {
    if (popup) popup.close();
    alert(error.message);
  }
});

async function loadDashboard(student) {
  const data = await api('/api/student/dashboard');
  const items = Array.isArray(data.announcements) ? data.announcements.map((item) => ({ ...item, is_read: announcementIsRead(item) })) : [];
  state.me = { ...(state.me || {}), announcements: items, student };
  welcomeName.textContent = `Welcome, ${student.full_name || 'Student'}`;
  studentLevel.textContent = student.level || '—';
  countMaterials.textContent = data.counts.materials;
  countLive.textContent = data.counts.liveClasses;
  renderAnnouncementFilterButtons();
  renderAnnouncementViews();
  const active = data.liveClasses.filter((item) => ['scheduled', 'live'].includes(classStatus(item))).slice(0, 4);
  renderLiveCards(active, dashboardLive);
}

async function loadAnnouncementsPage() {
  const data = await api('/api/student/announcements');
  const items = Array.isArray(data.announcements) ? data.announcements.map((item) => ({ ...item, is_read: announcementIsRead(item) })) : [];
  state.me = { ...(state.me || {}), announcements: items };
  renderAnnouncementFilterButtons();
  renderAnnouncementViews();
}

function buildMaterialLevelOptions(studentLevel) {
  const options = ['All Levels'];
  const allowedLevels = studentLevel ? [studentLevel] : [];
  const choiceList = [...new Set(['All Levels', ...allowedLevels])];
  materialLevel.innerHTML = choiceList.map((level) => `<option value="${level}">${level === 'All Levels' ? 'All Levels' : level}</option>`).join('');
  if (studentLevel && [...materialLevel.options].some((option) => option.value === studentLevel)) materialLevel.value = studentLevel;
  else materialLevel.value = 'All Levels';
}

async function loadMaterialsPage() {
  const data = await api('/api/student/materials');
  state.materials = data.materials;
  const studentLevel = state.me?.student?.level || 'All Levels';
  buildMaterialLevelOptions(studentLevel);
  renderMaterials();
}

function renderMaterials() {
  const query = materialSearch.value.trim().toLowerCase();
  const level = materialLevel.value;
  const rows = state.materials.filter((item) => {
    const matchesQuery = !query || [item.title, item.course_code, item.description].some((value) => String(value || '').toLowerCase().includes(query));
    const effectiveLevel = state.me?.student?.level || 'All Levels';
    const visibleLevels = new Set(['All Levels', effectiveLevel]);
    const matchesLevel = !level || level === 'All Levels' ? visibleLevels.has(item.level) : item.level === effectiveLevel || item.level === 'All Levels';
    return matchesQuery && matchesLevel;
  });
  studentMaterials.innerHTML = rows.length ? rows.map((item) => `<article class="list-item"><div><div class="meta">${escapeHtml(item.course_code)} · ${escapeHtml(item.level)} · ${formatDate(item.created_at, false)}</div><h3>${escapeHtml(item.title)}</h3><div class="body-text">${escapeHtml(item.description || '')}</div><div class="meta">Shared by ${escapeHtml(item.uploaded_by)}${item.original_name ? ` · ${escapeHtml(item.original_name)}` : ''}</div></div><div class="actions">${item.original_name ? `<a class="btn btn-primary btn-small" href="/api/student/materials/${item.id}/download"><i class="fas fa-download"></i> Download</a>` : ''}${item.resource_url ? `<a class="btn btn-outline btn-small" href="${escapeHtml(item.resource_url)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i> Open Link</a>` : ''}</div></article>`).join('') : empty('No materials match the selected filters.');
}

async function loadCoursesPage() {
  const data = await api('/api/student/courses');
  state.courses = data.courses;
  renderCourses();
}

function renderCourses() {
  const level = courseLevelFilter.value;
  const rows = state.courses.filter((course) => !level || course.level === level);
  const groups = rows.reduce((acc, course) => { (acc[course.semester] ||= []).push(course); return acc; }, {});
  studentCourses.innerHTML = Object.keys(groups).length ? Object.entries(groups).map(([semester, courses]) => `<section class="section-card"><h3 class="section-title"><i class="fas fa-layer-group"></i> ${escapeHtml(semester)}</h3><div class="table-wrap"><table><thead><tr><th>Course Code</th><th>Course Title</th><th>Units</th><th>Reading Guide</th></tr></thead><tbody>${courses.map((course) => `<tr><td><strong>${escapeHtml(course.course_code)}</strong></td><td>${escapeHtml(course.course_title)}</td><td>${course.units}</td><td>${course.reading_guide && /^https?:\/\//i.test(course.reading_guide) ? `<a href="${escapeHtml(course.reading_guide)}" target="_blank" rel="noopener">Open guide</a>` : escapeHtml(course.reading_guide || '—')}</td></tr>`).join('')}</tbody></table></div></section>`).join('') : empty('No course structure is available for this level.');
}

async function loadLivePage() {
  const data = await api('/api/student/live-classes');
  state.liveClasses = data.liveClasses;
  renderLivePage();
}

function renderLivePage() {
  const filter = liveStatusFilter.value;
  const rows = state.liveClasses.filter((item) => {
    const status = classStatus(item);
    if (filter === 'all') return true;
    if (filter === 'active') return status === 'scheduled' || status === 'live';
    return status === filter;
  });
  renderLiveCards(rows, studentLiveClasses);
}

async function loadSettings(student) {
  settingsReg.value = student.reg_number || '';
  settingsEmail.value = student.email || '';
  settingsName.value = student.full_name || '';
  settingsPhone.value = student.phone || '';
  settingsCourse.value = student.course || 'B.Sc. Data Science';
  if ([...settingsLevel.options].some((option) => option.value === student.level)) settingsLevel.value = student.level;
  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/student/profile', { method:'PUT', body:JSON.stringify({ fullName:settingsName.value, phone:settingsPhone.value, course:settingsCourse.value, level:settingsLevel.value }) });
      showNotice('settingsNotice', '<i class="fas fa-check-circle"></i> Profile updated successfully.');
    } catch (error) { showNotice('settingsNotice', `<i class="fas fa-exclamation-circle"></i> ${escapeHtml(error.message)}`, 'error'); }
  });
}

async function initialise() {
  wireLogout();
  try {
    const student = await setupIdentity();
    if (page === 'dashboard') await loadDashboard(student);
    if (page === 'announcements') await loadAnnouncementsPage();
    if (page === 'materials') { await loadMaterialsPage(); materialSearch.addEventListener('input', renderMaterials); materialLevel.addEventListener('change', renderMaterials); }
    if (page === 'courses') { await loadCoursesPage(); courseLevelFilter.addEventListener('change', renderCourses); }
    if (page === 'live') { await loadLivePage(); liveStatusFilter.addEventListener('change', renderLivePage); setInterval(renderLivePage, 60000); }
    if (page === 'settings') await loadSettings(student);
  } catch (error) {
    console.error(error);
    const shell = document.querySelector('.page-shell');
    if (shell) shell.innerHTML = `<div class="notice show error">${escapeHtml(error.message)}</div>`;
  }
}

announcementModal.addEventListener('click', (event) => {
  const closeTrigger = event.target.closest('[data-close-announcement-modal]');
  if (closeTrigger || event.target === announcementModal) {
    closeAnnouncementModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && announcementModal.classList.contains('active')) {
    closeAnnouncementModal();
  }
});

document.addEventListener('click', (event) => {
  const filterButton = event.target.closest('[data-announcement-filter]');
  if (filterButton) {
    state.announcementFilter = filterButton.dataset.announcementFilter || 'unread';
    renderAnnouncementFilterButtons();
    renderAnnouncementViews();
    return;
  }
});

initialise();
