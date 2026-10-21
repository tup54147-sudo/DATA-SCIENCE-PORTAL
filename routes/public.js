const express = require('express');
const { db } = require('../lib/db');
const router = express.Router();

router.get('/announcements', (req, res) => {
  const rows = db.prepare("SELECT id, title, body, author_name, created_at FROM announcements WHERE destination IN ('public','both') ORDER BY datetime(created_at) DESC, id DESC LIMIT 12").all();
  res.set('Cache-Control', 'no-store');
  return res.json({ announcements: rows });
});

module.exports = router;
