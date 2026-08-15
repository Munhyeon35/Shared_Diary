#!/usr/bin/env node
// Our Diary (couple-diary) — zero-dependency Node.js server PoC
// Run:   COUPLE_CODE=yoursecretcode node server.js
// Data:  ./data/entries.json (entries), ./data/photos/ (photo files)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const COUPLE_CODE = process.env.COUPLE_CODE || 'loveu';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');
const MAX_BODY = 30 * 1024 * 1024; // 30MB request cap, enough for several photos

fs.mkdirSync(PHOTO_DIR, { recursive: true });
if (!fs.existsSync(ENTRIES_FILE)) fs.writeFileSync(ENTRIES_FILE, '[]');

function loadEntries() {
  return JSON.parse(fs.readFileSync(ENTRIES_FILE, 'utf8'));
}
function saveEntries(entries) {
  const tmp = ENTRIES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
  fs.renameSync(tmp, ENTRIES_FILE); // atomic swap so a crash mid-write can't corrupt the file
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function authorized(req) {
  return req.headers['x-couple-code'] === COUPLE_CODE;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Save a data URL (base64 JPEG/PNG/WebP) as a file and return its filename
function savePhoto(dataUrl, entryId, index) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${entryId}-${index}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), Buffer.from(m[2], 'base64'));
  return name;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return json(res, 404, { error: 'not_found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.includes('photos') ? 'private, max-age=31536000' : 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- API ----
    if (p === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.code === COUPLE_CODE) return json(res, 200, { ok: true });
      return json(res, 401, { error: 'wrong_code' });
    }

    if (p.startsWith('/api/') && !authorized(req)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    if (p === '/api/entries' && req.method === 'GET') {
      // Exchange-diary rule: a partner's page for date D is readable only if
      // the requester ("me") has also written a page for D. Otherwise it is
      // returned masked ({locked: true}, no text/photos/mood).
      const me = url.searchParams.get('me') || '';
      const entries = loadEntries();
      const myDates = new Set(entries.filter((e) => e.author === me).map((e) => e.date));
      const visible = entries.map((e) =>
        e.author === me || myDates.has(e.date)
          ? e
          : { id: e.id, author: e.author, date: e.date, createdAt: e.createdAt, tz: e.tz, locked: true });
      visible.sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));
      return json(res, 200, { entries: visible });
    }

    if (p === '/api/entries' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const text = String(body.text || '').slice(0, 20000);
      const author = String(body.author || '').slice(0, 30);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
      if (!author || (!text.trim() && !(body.photos || []).length)) {
        return json(res, 400, { error: 'empty' });
      }
      // One page per person per day: a repeat POST for the same author+date
      // updates that page instead of adding another entry.
      const entries = loadEntries();
      const existing = entries.find((e) => e.author === author && e.date === date);
      const id = existing ? existing.id : crypto.randomBytes(8).toString('hex');
      const photos = [];
      (body.photos || []).slice(0, 10).forEach((item, i) => {
        if (typeof item !== 'string') return;
        if (item.startsWith('data:')) {
          // new photo: save under a unique suffix so edits never collide
          const name = savePhoto(item, id, crypto.randomBytes(4).toString('hex'));
          if (name) photos.push(name);
        } else if (existing && existing.photos.includes(item)) {
          photos.push(item); // kept photo from the previous version of this page
        }
      });
      if (existing) {
        existing.photos.filter((n) => !photos.includes(n))
          .forEach((n) => fs.rm(path.join(PHOTO_DIR, n), () => {}));
      }
      const entry = {
        id, author, date, text, photos,
        mood: String(body.mood || '').slice(0, 8),
        createdAt: existing ? existing.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tz: String(body.tz || '').slice(0, 50), // author's time zone (to show "their time" on the partner's screen)
      };
      if (existing) entries[entries.indexOf(existing)] = entry;
      else entries.push(entry);
      saveEntries(entries);
      return json(res, 200, { entry });
    }

    const delMatch = /^\/api\/entries\/([a-f0-9]{16})$/.exec(p);
    if (delMatch && req.method === 'DELETE') {
      const entries = loadEntries();
      const idx = entries.findIndex((e) => e.id === delMatch[1]);
      if (idx === -1) return json(res, 404, { error: 'not_found' });
      const [removed] = entries.splice(idx, 1);
      saveEntries(entries);
      (removed.photos || []).forEach((name) => {
        fs.rm(path.join(PHOTO_DIR, name), () => {});
      });
      return json(res, 200, { ok: true });
    }

    // ---- static files ----
    if (p.startsWith('/photos/')) {
      const name = path.basename(p); // prevent path traversal
      // Photos are also gated behind the couple code, checked via query parameter
      if (url.searchParams.get('code') !== COUPLE_CODE) return json(res, 401, { error: 'unauthorized' });
      return serveFile(res, path.join(PHOTO_DIR, name));
    }
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    const staticFile = path.join(ROOT, 'public', path.basename(p));
    if (fs.existsSync(staticFile)) return serveFile(res, staticFile);

    return json(res, 404, { error: 'not_found' });
  } catch (e) {
    return json(res, e.message === 'too_large' ? 413 : 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Our Diary server running: http://localhost:${PORT} (couple code: ${COUPLE_CODE})`);
});
