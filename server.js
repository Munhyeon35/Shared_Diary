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

function serveFile(res, filePath, downloadAs) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return json(res, 404, { error: 'not_found' });
    const head = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.includes('photos') ? 'private, max-age=31536000' : 'no-cache',
    };
    // Saving a photo: iOS Safari ignores the link's download attribute, so the
    // header is what actually makes it save instead of navigate.
    if (downloadAs) head['Content-Disposition'] = `attachment; filename="${downloadAs}"`;
    res.writeHead(200, head);
    res.end(buf);
  });
}
const safeFilename = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);

// ---- a page is a set of things laid on it ----
// Every item carries where it sits (x, y as a share of the page), how it is
// turned and how big it is, so the same page looks the same on any screen.
const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Pages written before the canvas stored a run of text plus a photo list and a
// separate decor array. Lay those out top to bottom so nothing is lost.
function itemsOf(entry) {
  if (Array.isArray(entry.items)) return entry.items;
  const laid = [];
  const parts = String(entry.text || '').split(/\n?\[\[photo(?::\d{1,3})?\]\]\n?/);
  const photos = entry.photos || [];
  let p = 0;
  parts.forEach((t, i) => {
    if (t.trim()) laid.push({ k: 'text', v: t.trim(), w: 76, fs: 3.2 });
    if (i < parts.length - 1 && p < photos.length) laid.push({ k: 'photo', src: photos[p++], w: 40 });
  });
  while (p < photos.length) laid.push({ k: 'photo', src: photos[p++], w: 40 });
  // spread them down the page so nothing lands off the edge
  const step = laid.length > 1 ? 62 / (laid.length - 1) : 0;
  const items = laid.map((it, i) => ({
    ...it, x: 50, y: laid.length > 1 ? 20 + i * step : 40, r: 0, s: 1, by: entry.author,
  }));
  for (const d of entry.decor || []) {
    items.push({ k: d.k, v: d.v, x: d.x, y: d.y, r: d.r, s: d.s, by: d.by || entry.author });
  }
  return items;
}

// Validate what a client sends, and turn any freshly pasted photo into a file.
function cleanItems(raw, by, entryId, was, allEntries) {
  const known = new Set();
  for (const e of allEntries) for (const it of itemsOf(e)) if (it.k === 'photo') known.add(it.src);
  const out = [];
  for (const d of (Array.isArray(raw) ? raw : []).slice(0, 80)) {
    if (!d || typeof d !== 'object') continue;
    const base = {
      x: num(d.x, -20, 120, 50), y: num(d.y, -20, 120, 50),
      r: num(d.r, -180, 180, 0), s: num(d.s, 0.2, 6, 1),
      by: String(d.by || by).slice(0, 30),
    };
    if (d.k === 'text') {
      const v = String(d.v || '').slice(0, 8000);
      if (!v.trim()) continue;
      out.push({ k: 'text', v, ...base, w: num(d.w, 8, 110, 80), fs: num(d.fs, 1.5, 12, 3.4) });
    } else if (d.k === 'photo') {
      const src = String(d.src || '');
      if (src.startsWith('data:')) {
        const name = savePhoto(src, entryId, crypto.randomBytes(4).toString('hex'));
        if (name) out.push({ k: 'photo', src: name, ...base, w: num(d.w, 5, 110, 50) });
      } else if (known.has(src)) {                 // a photo already on some page
        out.push({ k: 'photo', src, ...base, w: num(d.w, 5, 110, 50) });
      }
    } else if (d.k === 'tape' || d.k === 'sticker') {
      const v = String(d.v || '').slice(0, 16);
      if (v) out.push({ k: d.k, v, ...base });
    }
  }
  return out;
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
      // Pages are readable as soon as they are written. An earlier version
      // gated a partner's page behind writing your own for the same day, but
      // that punished the person whose day starts later (Korea/SF are ~16h
      // apart) and was trivially bypassed by saving a placeholder character.
      // Writing daily is encouraged in the UI instead, never enforced here.
      const entries = loadEntries();
      entries.sort((a, b) => (a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date)));
      // Pages written before the canvas are laid out here, so the migration
      // lives in one place and every client sees the same page.
      return json(res, 200, { entries: entries.map((e) => ({ ...e, items: itemsOf(e) })) });
    }

    if (p === '/api/entries' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      const author = String(body.author || '').slice(0, 30);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : new Date().toISOString().slice(0, 10);
      if (!author) return json(res, 400, { error: 'who' });

      // One page per person per day: a repeat POST for the same author+date
      // updates that page instead of adding another entry.
      const entries = loadEntries();
      const existing = entries.find((e) => e.author === author && e.date === date);
      const id = existing ? existing.id : crypto.randomBytes(8).toString('hex');
      const was = existing ? itemsOf(existing) : [];

      // A page is a set of things laid on it. Everything the owner put down
      // is replaced wholesale; stickers their partner left are kept, since
      // those are not the owner's to rewrite.
      const kept = was.filter((it) => it.by && it.by !== author);
      const mine = cleanItems(body.items, author, id, was, entries);
      const items = mine.concat(kept);
      if (!items.length) return json(res, 400, { error: 'empty' });

      const photos = items.filter((it) => it.k === 'photo').map((it) => it.src);
      if (existing) {
        (existing.photos || []).filter((n) => !photos.includes(n))
          .forEach((n) => fs.rm(path.join(PHOTO_DIR, n), () => {}));
      }
      const now = new Date().toISOString();
      const mood = String(body.mood || '').slice(0, 8);
      const tz = String(body.tz || '').slice(0, 50); // author's time zone (to show "their time" on the partner's screen)
      const text = items.filter((it) => it.k === 'text').map((it) => it.v).join('\n');
      // Edit log: one stamp per save that actually changed something, so
      // "edited" is always backed by a visible when. edits[0] is the writing.
      const changed = !existing
        || JSON.stringify(was.filter((it) => !it.by || it.by === author)) !== JSON.stringify(mine)
        || existing.mood !== mood;
      const edits = (existing && Array.isArray(existing.edits) ? existing.edits
        : existing ? [{ at: existing.createdAt, tz: existing.tz }] : []).slice(-99);
      if (changed) edits.push({ at: now, tz });
      const entry = {
        id, author, date, items, photos, text, mood, tz, edits,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: changed ? now : (existing ? existing.updatedAt : now),
      };
      if (existing) entries[entries.indexOf(existing)] = entry;
      else entries.push(entry);
      saveEntries(entries);
      return json(res, 200, { entry });
    }

    // A sticker left on your partner's page belongs to their page, so it is
    // saved with their entry. Only stickers, and only your own: the server
    // rebuilds the page from what its owner put down plus your stickers, so a
    // request can never rewrite or remove someone else's things.
    const stickMatch = /^\/api\/entries\/([a-f0-9]{16})\/stickers$/.exec(p);
    if (stickMatch && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const by = String(body.by || '').slice(0, 30);
      if (!by) return json(res, 400, { error: 'who' });
      const entries = loadEntries();
      const entry = entries.find((e) => e.id === stickMatch[1]);
      if (!entry) return json(res, 404, { error: 'not_found' });

      const theirs = itemsOf(entry).filter((it) => (it.by || entry.author) !== by);
      const mine = (Array.isArray(body.stickers) ? body.stickers : [])
        .slice(0, 40)
        .filter((d) => d && d.k === 'sticker' && String(d.v || '').trim())
        .map((d) => ({
          k: 'sticker', v: String(d.v).slice(0, 16),
          x: num(d.x, -20, 120, 50), y: num(d.y, -20, 120, 50),
          r: num(d.r, -180, 180, 0), s: num(d.s, 0.2, 6, 1), by,
        }));
      entry.items = theirs.concat(mine);
      entry.photos = entry.items.filter((it) => it.k === 'photo').map((it) => it.src);
      saveEntries(entries);
      return json(res, 200, { items: entry.items });
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
      const asName = url.searchParams.get('download');
      return serveFile(res, path.join(PHOTO_DIR, name),
        asName ? (safeFilename(asName) || name) : null);
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
