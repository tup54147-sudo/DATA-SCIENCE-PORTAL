function wantsJson(req) {
  return req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json');
}

function requireStudent(req, res, next) {
  if (req.session?.studentId) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Please log in as a student.' });
  return res.redirect('/learning-area-access.html');
}

function requireStaff(req, res, next) {
  if (req.session?.staffId) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Please log in as a staff member.' });
  return res.redirect('/admin-login.html');
}

function requirePortalUser(req, res, next) {
  if (req.session?.studentId || req.session?.staffId) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Please log in to access the portal.' });
  return res.redirect('/learning-area-access.html');
}

function requireHod(req, res, next) {
  if (req.session?.staffId && req.session?.staffRole === 'hod') return next();
  return res.status(403).json({ error: 'Only the Head of Department can perform this action.' });
}

module.exports = { requireStudent, requireStaff, requirePortalUser, requireHod };
