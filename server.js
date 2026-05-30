/**
 * PBOS — server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js + Express backend.
 * All data is stored in data.json on disk — so any device that hits this
 * server with the same login gets exactly the same data.
 *
 * HOW TO RUN
 * ──────────
 * 1. Make sure Node.js is installed  →  https://nodejs.org
 * 2. Open a terminal in this folder
 * 3. Run:  npm install express cors
 * 4. Run:  node server.js
 * 5. Open your browser to:  http://localhost:3000/landing.html
 *
 * For OTHER DEVICES on the same Wi-Fi network:
 *   - Find your computer's local IP  (e.g. 192.168.1.5)
 *   - On the other device open:  http://192.168.1.5:3000/landing.html
 *   - Log in with the same account → same data appears
 *
 * For access from ANYWHERE (internet):
 *   - Use a free tunnel like ngrok:  npx ngrok http 3000
 *   - Share the ngrok URL with any device
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const app      = express();
const PORT     = 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));   // serves landing.html, index.html, db.js etc.


// Simple health route used by db.js to check whether the backend is running.
// This avoids creating dummy userData records just for a connection test.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'PBOS backend' });
});

// Open landing page when visiting http://localhost:3000/
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

// ── DATA FILE HELPERS ─────────────────────────────────────────────────────────
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: {}, userData: {} };
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'pbos_salt_2026').digest('hex');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Ensure every user has default empty data structure
function defaultUserData() {
  return {
    posts:       [],
    deals:       [],
    tasks:       [],
    activity:    [],
    socialStats: {
      instagram: { followers:0, views:0, likes:0, comments:0, engagementRate:0, handle:'', posts:[] },
      tiktok:    { followers:0, views:0, likes:0, comments:0, engagementRate:0, handle:'', posts:[] },
      facebook:  { followers:0, views:0, likes:0, comments:0, engagementRate:0, handle:'', posts:[] }
    }
  };
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

// POST /api/auth/signup
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ ok: false, error: 'All fields are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
  }

  const data = readData();
  const key  = email.toLowerCase().trim();

  if (data.users[key]) {
    return res.status(409).json({ ok: false, error: 'An account with that email already exists.' });
  }

  data.users[key] = {
    name,
    email: key,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  // Initialise empty workspace for new user
  data.userData[key] = defaultUserData();

  // Log welcome activity
  data.userData[key].activity.push({
    id: uid(),
    platform: 'system',
    text: `Welcome to PBOS, ${name}! Your workspace is ready.`,
    time: new Date().toISOString(),
    createdAt: new Date().toISOString()
  });

  writeData(data);
  res.json({ ok: true, user: { name, email: key } });
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: 'Email and password are required.' });
  }

  const data = readData();
  const key  = email.toLowerCase().trim();
  const user = data.users[key];

  if (!user) {
    return res.status(401).json({ ok: false, error: 'No account found with that email.' });
  }
  if (user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ ok: false, error: 'Incorrect password.' });
  }

  // Ensure userData exists (for accounts created before userData init was added)
  if (!data.userData[key]) {
    data.userData[key] = defaultUserData();
    writeData(data);
  }

  res.json({ ok: true, user: { name: user.name, email: key } });
});

// ── GENERIC USER DATA ROUTES ──────────────────────────────────────────────────
// All routes below require ?email=user@example.com in the query string
// (The client sends this from the session)

function getUserData(email) {
  const data = readData();
  const key  = email.toLowerCase().trim();
  if (!data.userData[key]) {
    data.userData[key] = defaultUserData();
    writeData(data);
  }
  return { data, key };
}

// ── POSTS ─────────────────────────────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  res.json(data.userData[key]?.posts || []);
});

app.post('/api/posts', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const post = { ...req.body, id: uid(), createdAt: new Date().toISOString() };
  data.userData[key].posts.unshift(post);
  writeData(data);
  res.json(post);
});

app.put('/api/posts/:id', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const posts = data.userData[key].posts;
  const idx   = posts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  posts[idx] = { ...posts[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeData(data);
  res.json(posts[idx]);
});

app.delete('/api/posts/:id', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  data.userData[key].posts = data.userData[key].posts.filter(p => p.id !== req.params.id);
  writeData(data);
  res.json({ ok: true });
});

// ── DEALS ─────────────────────────────────────────────────────────────────────
app.get('/api/deals', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  res.json(data.userData[key]?.deals || []);
});

app.post('/api/deals', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const deal = { ...req.body, id: uid(), createdAt: new Date().toISOString() };
  data.userData[key].deals.unshift(deal);
  writeData(data);
  res.json(deal);
});

app.put('/api/deals/:id', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const deals = data.userData[key].deals;
  const idx   = deals.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  deals[idx] = { ...deals[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeData(data);
  res.json(deals[idx]);
});

app.delete('/api/deals/:id', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  data.userData[key].deals = data.userData[key].deals.filter(d => d.id !== req.params.id);
  writeData(data);
  res.json({ ok: true });
});

// ── TASKS ─────────────────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  res.json(data.userData[key]?.tasks || []);
});

app.post('/api/tasks', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const task = { ...req.body, id: uid(), createdAt: new Date().toISOString() };
  data.userData[key].tasks.unshift(task);
  writeData(data);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const tasks = data.userData[key].tasks;
  const idx   = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  tasks[idx] = { ...tasks[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeData(data);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  data.userData[key].tasks = data.userData[key].tasks.filter(t => t.id !== req.params.id);
  writeData(data);
  res.json({ ok: true });
});

// ── ACTIVITY ──────────────────────────────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  res.json((data.userData[key]?.activity || []).slice(0, 50));
});

app.post('/api/activity', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const entry = { ...req.body, id: uid(), time: new Date().toISOString(), createdAt: new Date().toISOString() };
  data.userData[key].activity.unshift(entry);
  data.userData[key].activity = data.userData[key].activity.slice(0, 50);
  writeData(data);
  res.json(entry);
});

// ── SOCIAL STATS ──────────────────────────────────────────────────────────────
app.get('/api/social', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  res.json(data.userData[key]?.socialStats || defaultUserData().socialStats);
});

app.put('/api/social/:platform', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const plat = req.params.platform;
  if (!['instagram','tiktok','facebook'].includes(plat)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  data.userData[key].socialStats[plat] = {
    ...data.userData[key].socialStats[plat],
    ...req.body
  };
  writeData(data);
  res.json(data.userData[key].socialStats[plat]);
});

// Add a post to a platform
app.post('/api/social/:platform/posts', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const plat = req.params.platform;
  if (!['instagram','tiktok','facebook'].includes(plat)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  const post = {
    ...req.body,
    id:      uid(),
    date:    new Date().toLocaleDateString('en-AU', { day:'numeric', month:'short' }),
    addedAt: new Date().toISOString()
  };
  data.userData[key].socialStats[plat].posts = [
    post,
    ...(data.userData[key].socialStats[plat].posts || [])
  ];
  writeData(data);
  res.json(post);
});

// Remove a post from a platform
app.delete('/api/social/:platform/posts/:postId', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const plat = req.params.platform;
  data.userData[key].socialStats[plat].posts =
    (data.userData[key].socialStats[plat].posts || []).filter(p => p.id !== req.params.postId);
  writeData(data);
  res.json({ ok: true });
});

// ── FULL DATA SYNC (for demo loader / clear all) ──────────────────────────────
app.put('/api/sync', (req, res) => {
  const { data, key } = getUserData(req.query.email || '');
  const allowed = ['posts','deals','tasks','activity','socialStats'];
  allowed.forEach(entity => {
    if (req.body[entity] !== undefined) {
      data.userData[key][entity] = req.body[entity];
    }
  });
  writeData(data);
  res.json({ ok: true });
});

// ── START SERVER ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║        PBOS Server is running! 🚀         ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}           ║`);
  console.log('  ║  Network: http://<your-ip>:' + PORT + '           ║');
  console.log('  ╠═══════════════════════════════════════════╣');
  console.log('  ║  Data stored in: data.json                ║');
  console.log('  ║  Press Ctrl+C to stop the server          ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
  
  // Show network IPs
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Other devices on your network: http://${net.address}:${PORT}/landing.html`);
      }
    }
  }
  console.log('');
});
