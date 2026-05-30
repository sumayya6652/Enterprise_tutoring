/**
 * PBOS — db.js  (v3 — API + localStorage fallback)
 * ─────────────────────────────────────────────────────────────────────────────
 * When server.js is running  →  all data is stored in data.json on the server.
 *   Any device that logs into the same account sees the same data.
 *
 * When server.js is NOT running  →  automatically falls back to localStorage
 *   so the app still works offline (data stays on this device only).
 *
 * The UI never needs to know which mode it's in — the API is identical.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DB = (() => {

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const API_BASE    = 'http://localhost:3000/api';
  const SESSION_KEY = 'pbos_session';
  const USERS_KEY   = 'pbos_users';

  // Tracks whether the server is reachable
  let serverOnline = false;
  let serverChecked = false;

  // ── HELPERS ─────────────────────────────────────────────────────────────────
  function read(key)        { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
  function write(key, val)  { localStorage.setItem(key, JSON.stringify(val)); }
  function uid()            { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
    if (typeof AbortController === 'undefined') return undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  function currentEmail() {
    const s = session.get();
    return s ? s.email.toLowerCase().trim() : null;
  }

  function userKey(entity) {
    const e = currentEmail();
    return e ? `pbos_${e}_${entity}` : null;
  }

  // ── SERVER HEALTH CHECK ──────────────────────────────────────────────────────
  async function checkServer() {
    if (serverChecked) return serverOnline;
    try {
      const res = await fetch(API_BASE + '/health', { signal: timeoutSignal(1500) });
      serverOnline = res.ok; // health response = server is up
    } catch {
      serverOnline = false;
    }
    serverChecked = true;

    // Show indicator in page
    const indicator = document.getElementById('server-status');
    if (indicator) {
      indicator.textContent = serverOnline ? '🟢 Server connected — data syncs across devices' : '🟡 Offline mode — data stored locally on this device';
      indicator.style.color = serverOnline ? '#57ff9a' : '#ffbe57';
    }
    return serverOnline;
  }

  // Reset server check (called after network errors)
  function resetServerCheck() { serverChecked = false; }

  // ── API CALL WRAPPER ─────────────────────────────────────────────────────────
  async function api(method, path, body) {
    const online = await checkServer();
    if (!online) return null; // caller will use localStorage fallback

    const email = currentEmail();
    const url   = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}email=${encodeURIComponent(email || '')}`;

    try {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: timeoutSignal(5000)
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(url, opts);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { _error: err.error || 'Server error' };
      }
      return await res.json();
    } catch (e) {
      // Server went offline mid-session
      serverOnline = false;
      serverChecked = false;
      return null;
    }
  }

  // ── SESSION ──────────────────────────────────────────────────────────────────
  const session = {
    get()      { return read(SESSION_KEY); },
    set(user)  { write(SESSION_KEY, { email: user.email.toLowerCase().trim(), name: user.name }); },
    clear()    { localStorage.removeItem(SESSION_KEY); }
  };

  // ── USERS (auth) ─────────────────────────────────────────────────────────────
  const users = {
    // localStorage fallback store
    _all()  { return read(USERS_KEY) || {}; },
    _save(u){ write(USERS_KEY, u); },
    all()   { return this._all(); },

    async create(name, email, password) {
      const key = email.toLowerCase().trim();
      // Try server first
      const result = await api('POST', '/auth/signup', { name, email: key, password });
      if (result && !result._error) {
        // Also save locally so offline login works
        const all = this._all();
        all[key] = { name, email: key, password, createdAt: new Date().toISOString() };
        this._save(all);
        return { ok: true, user: result.user || { name, email: key } };
      }
      if (result && result._error) return { ok: false, error: result._error };

      // Offline fallback
      const all = this._all();
      if (all[key]) return { ok: false, error: 'Email already registered.' };
      if (password.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
      all[key] = { name, email: key, password, createdAt: new Date().toISOString() };
      this._save(all);
      return { ok: true, user: { name, email: key } };
    },

    async verify(email, password) {
      const key = email.toLowerCase().trim();
      // Try server first
      const result = await api('POST', '/auth/login', { email: key, password });
      if (result && !result._error) return { ok: true, user: result.user };
      if (result && result._error) return { ok: false, error: result._error };

      // Offline fallback
      const all  = this._all();
      const user = all[key];
      if (!user) return { ok: false, error: 'No account found with that email.' };
      if (user.password !== password) return { ok: false, error: 'Incorrect password.' };
      return { ok: true, user: { name: user.name, email: key } };
    }
  };

  // ── GENERIC COLLECTION ────────────────────────────────────────────────────────
  // Returns an async-compatible object. All methods return Promises.
  // The UI can call them with .then() OR with await (if async context).
  // For backwards compat with existing sync calls, they also expose .allSync().

  function collection(entity) {
    const lsKey = () => userKey(entity);

    // localStorage CRUD
    const ls = {
      all()       { return read(lsKey()) || []; },
      save(items) { const k = lsKey(); if(k) write(k, items); },
      get(id)     { return this.all().find(x => x.id === id) || null; },
      add(item)   {
        const record = { ...item, id: uid(), createdAt: new Date().toISOString() };
        const items  = this.all(); items.unshift(record); this.save(items); return record;
      },
      update(id, patch) {
        const items = this.all(); const idx = items.findIndex(x => x.id === id); if (idx===-1) return null;
        items[idx] = { ...items[idx], ...patch, updatedAt: new Date().toISOString() }; this.save(items); return items[idx];
      },
      remove(id)  { this.save(this.all().filter(x => x.id !== id)); },
      clear()     { this.save([]); }
    };

    return {
      // Synchronous reads (always from localStorage cache)
      all()    { return ls.all(); },
      get(id)  { return ls.get(id); },

      // Write operations — write to LS immediately, then sync to server
      add(item) {
        const record = ls.add(item);
        api('POST', `/${entity}`, item).then(serverRecord => {
          if (serverRecord && !serverRecord._error) {
            // Replace local record with server record (gets server-generated id if any)
            const items = ls.all();
            const idx = items.findIndex(x => x.id === record.id);
            if (idx > -1) { items[idx] = { ...items[idx], ...serverRecord }; ls.save(items); }
          }
        });
        return record;
      },

      update(id, patch) {
        const updated = ls.update(id, patch);
        api('PUT', `/${entity}/${id}`, patch);
        return updated;
      },

      remove(id) {
        ls.remove(id);
        api('DELETE', `/${entity}/${id}`);
      },

      clear() { ls.clear(); },

      // Pull latest from server into localStorage (call on page load / navigation)
      async sync() {
        const items = await api('GET', `/${entity}`);
        if (items && Array.isArray(items)) { ls.save(items); }
        return ls.all();
      }
    };
  }

  // ── ACTIVITY ─────────────────────────────────────────────────────────────────
  const activity = {
    _lsKey() { return userKey('activity'); },
    _lsAll() { return read(this._lsKey()) || []; },
    _lsSave(items) { const k = this._lsKey(); if(k) write(k, items.slice(0,50)); },

    all()  { return this._lsAll().slice(0, 50); },

    log(platform, text) {
      const record = { id: uid(), platform, text, time: new Date().toISOString(), createdAt: new Date().toISOString() };
      const items  = this._lsAll();
      items.unshift(record);
      this._lsSave(items);
      // Sync to server (fire and forget)
      api('POST', '/activity', { platform, text });
      return record;
    },

    async sync() {
      const items = await api('GET', '/activity');
      if (items && Array.isArray(items)) this._lsSave(items);
      return this._lsAll();
    },

    relativeTime(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1)  return 'Just now';
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      return d === 1 ? 'Yesterday' : `${d} days ago`;
    }
  };

  // ── SOCIAL STATS ──────────────────────────────────────────────────────────────
  const socialStats = {
    _lsKey() { return userKey('socialStats'); },
    _defaults() {
      return {
        instagram: { followers:0,views:0,likes:0,comments:0,engagementRate:0,handle:'',posts:[] },
        tiktok:    { followers:0,views:0,likes:0,comments:0,engagementRate:0,handle:'',posts:[] },
        facebook:  { followers:0,views:0,likes:0,comments:0,engagementRate:0,handle:'',posts:[] }
      };
    },
    all()         { return read(this._lsKey()) || this._defaults(); },
    get(platform) { return this.all()[platform] || {}; },

    update(platform, patch) {
      const all = this.all();
      all[platform] = { ...all[platform], ...patch };
      write(this._lsKey(), all);
      // Sync to server
      api('PUT', `/social/${platform}`, patch);
      return all[platform];
    },

    addPost(platform, post) {
      const all   = this.all();
      const posts = all[platform].posts || [];
      const newPost = { ...post, id: uid(), date: new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short'}), addedAt: new Date().toISOString() };
      posts.unshift(newPost);
      all[platform].posts = posts;
      write(this._lsKey(), all);
      api('POST', `/social/${platform}/posts`, post);
    },

    removePost(platform, postId) {
      const all = this.all();
      all[platform].posts = (all[platform].posts || []).filter(p => p.id !== postId);
      write(this._lsKey(), all);
      api('DELETE', `/social/${platform}/posts/${postId}`);
    },

    async sync() {
      const stats = await api('GET', '/social');
      if (stats && !stats._error) { write(this._lsKey(), stats); }
      return this.all();
    },

    totalFollowers() {
      const all = this.all();
      return (all.instagram.followers||0)+(all.tiktok.followers||0)+(all.facebook.followers||0);
    },
    totalViews() {
      const all = this.all();
      return (all.instagram.views||0)+(all.tiktok.views||0)+(all.facebook.views||0);
    },
    avgEngagement() {
      const all   = this.all();
      const rates = [all.instagram.engagementRate, all.tiktok.engagementRate, all.facebook.engagementRate].filter(r => r > 0);
      if (!rates.length) return 0;
      return (rates.reduce((a,b) => a+b, 0) / rates.length).toFixed(1);
    }
  };

  // ── COMPUTED STATS ────────────────────────────────────────────────────────────
  const stats = {
    summary() {
      const allPosts = collection('posts').all();
      const allDeals = collection('deals').all();
      const allTasks = collection('tasks').all();
      return {
        totalFollowers:   socialStats.totalFollowers(),
        totalViews:       socialStats.totalViews(),
        avgEngagement:    socialStats.avgEngagement(),
        scheduledPosts:   allPosts.filter(p => p.status==='scheduled').length,
        dealRevenue:      allDeals.reduce((a,d) => a+Number(d.value||0), 0),
        pendingTasks:     allTasks.filter(t => !t.done).length,
        totalPosts:       allPosts.length,
        totalDeals:       allDeals.length,
        totalTasks:       allTasks.length,
        doneTasks:        allTasks.filter(t => t.done).length
      };
    }
  };

  // ── SYNC ALL (called on login and page focus) ─────────────────────────────────
  async function syncAll() {
    await checkServer();
    if (!serverOnline) return;
    await Promise.all([
      collection('posts').sync(),
      collection('deals').sync(),
      collection('tasks').sync(),
      activity.sync(),
      socialStats.sync()
    ]);
  }

  // ── DEMO DATA LOADER ──────────────────────────────────────────────────────────
  const demo = {
    load() {
      const email = currentEmail(); if (!email) return;

      function agoIso(h) { return new Date(Date.now() - h*3600000).toISOString(); }
      function mk(data)  { return { ...data, id: uid(), createdAt: new Date().toISOString() }; }

      const socData = {
        instagram: {
          handle:'@yourbrand', followers:48200, views:312000, likes:28400, comments:4100, engagementRate:5.9,
          posts:[
            { id:uid(), title:'Morning routine vlog 🌅',   views:42100, likes:6800, date:'22 May', addedAt:agoIso(2) },
            { id:uid(), title:'Top 5 productivity apps',    views:38700, likes:5900, date:'20 May', addedAt:agoIso(4) },
            { id:uid(), title:'Brand unboxing — NordVPN',   views:29400, likes:3200, date:'18 May', addedAt:agoIso(6) },
            { id:uid(), title:'Q&A: Growing your brand',    views:51000, likes:8100, date:'15 May', addedAt:agoIso(9) },
          ]
        },
        tiktok: {
          handle:'@yourbrand', followers:31500, views:890000, likes:112000, comments:18700, engagementRate:12.6,
          posts:[
            { id:uid(), title:'Day in my life as a creator',      views:240000, likes:42000, date:'21 May', addedAt:agoIso(3) },
            { id:uid(), title:'Productivity hack that changed me', views:189000, likes:31000, date:'19 May', addedAt:agoIso(5) },
            { id:uid(), title:'Rate my desk setup 💻',             views:320000, likes:58000, date:'17 May', addedAt:agoIso(7) },
            { id:uid(), title:'Responding to your comments',       views:141000, likes:19000, date:'14 May', addedAt:agoIso(10) },
          ]
        },
        facebook: {
          handle:'YourBrand Official', followers:14800, views:67000, likes:8900, comments:2100, engagementRate:3.2,
          posts:[
            { id:uid(), title:'Behind the scenes: content day',    views:12400, likes:1800, date:'22 May', addedAt:agoIso(2) },
            { id:uid(), title:'Community poll: what content next?', views:9800,  likes:2400, date:'20 May', addedAt:agoIso(4) },
            { id:uid(), title:'Live stream recap highlights',       views:18700, likes:2200, date:'16 May', addedAt:agoIso(8) },
          ]
        }
      };

      const postsData = [
        mk({title:'Morning routine vlog',      platform:'instagram',type:'Reel',      date:'2026-05-25',status:'published',reach:'42K',  notes:'Performed above average'}),
        mk({title:'Productivity apps review',  platform:'youtube',  type:'Video',     date:'2026-05-26',status:'scheduled',reach:'60K+', notes:'Notion sponsored segment'}),
        mk({title:'Day in my life',            platform:'tiktok',   type:'Short',     date:'2026-05-26',status:'published',reach:'240K', notes:''}),
        mk({title:'June newsletter drop',      platform:'facebook', type:'Post',      date:'2026-05-28',status:'draft',    reach:'14K',  notes:'Link to blog in comments'}),
        mk({title:'Behind the scenes reel',    platform:'instagram',type:'Story',     date:'2026-05-29',status:'scheduled',reach:'30K',  notes:''}),
        mk({title:'NordVPN integration ad',    platform:'youtube',  type:'Integrated',date:'2026-06-01',status:'scheduled',reach:'55K+', notes:'Read brief before filming'}),
        mk({title:'Q&A live session',          platform:'instagram',type:'Live',      date:'2026-06-03',status:'draft',    reach:'20K',  notes:'Collect questions via story'}),
        mk({title:'Tech unboxing haul',        platform:'tiktok',   type:'Short',     date:'2026-06-05',status:'scheduled',reach:'180K+',notes:''}),
      ];

      const dealsData = [
        mk({brand:'NordVPN',       type:'Integrated Ad',   platform:'youtube',  value:600,  deadline:'2026-05-30',status:'in-progress',progress:70, notes:'30-second read in video'}),
        mk({brand:'Squarespace',   type:'Sponsored Post',  platform:'instagram',value:350,  deadline:'2026-06-03',status:'pending',    progress:30, notes:'Awaiting brand brief'}),
        mk({brand:'Notion',        type:'Brand Deal',      platform:'tiktok',   value:250,  deadline:'2026-06-07',status:'paid',       progress:100,notes:'Invoice paid'}),
        mk({brand:'Canva Pro',     type:'Affiliate',       platform:'all',      value:480,  deadline:'2026-06-10',status:'in-progress',progress:50, notes:'Affiliate link in bio'}),
        mk({brand:'Epidemic Sound',type:'Licensing Deal',  platform:'youtube',  value:320,  deadline:'2026-06-15',status:'pending',    progress:10, notes:'Contract review pending'}),
        mk({brand:'Samsung AU',    type:'Product Placement',platform:'instagram',value:1200, deadline:'2026-06-20',status:'negotiation',progress:5,  notes:'Negotiating usage rights'}),
      ];

      const tasksData = [
        mk({text:'Write script for YouTube Q&A video', due:'2026-05-26',priority:'high',  category:'Content',done:false,notes:'Reference the comments section for questions'}),
        mk({text:'Send NordVPN content brief',         due:'2026-05-25',priority:'high',  category:'Deals',  done:true, notes:'Sent via email to brand manager'}),
        mk({text:'Film TikTok day-in-life segment',    due:'2026-05-27',priority:'medium',category:'Content',done:false,notes:'Film at morning and evening for variety'}),
        mk({text:'Design thumbnail for IG reel',       due:'2026-05-27',priority:'medium',category:'Creative',done:false,notes:'Use brand colours — yellow accent'}),
        mk({text:'Schedule June newsletter',           due:'2026-05-28',priority:'low',   category:'Admin',  done:false,notes:''}),
        mk({text:'Review Squarespace deal contract',   due:'2026-05-29',priority:'high',  category:'Deals',  done:false,notes:'Check exclusivity clause page 3'}),
        mk({text:'Update monthly analytics report',    due:'2026-05-30',priority:'low',   category:'Admin',  done:true, notes:''}),
        mk({text:'Film Samsung AU product shoot',      due:'2026-06-10',priority:'high',  category:'Deals',  done:false,notes:'Use studio lighting kit'}),
      ];

      const activityData = [
        {id:uid(),platform:'ig',    text:'Instagram "Morning routine vlog" reached 42K views 🎉',time:agoIso(2), createdAt:agoIso(2)},
        {id:uid(),platform:'tt',    text:'TikTok "Rate my desk setup" hit 320K views and trending in AU',time:agoIso(4),createdAt:agoIso(4)},
        {id:uid(),platform:'fb',    text:'Facebook poll received 340 votes — engagement up 18%',time:agoIso(6),createdAt:agoIso(6)},
        {id:uid(),platform:'ig',    text:'New milestone: 48,000 followers on Instagram 🏆',time:agoIso(24),createdAt:agoIso(24)},
        {id:uid(),platform:'system',text:'Brand deal with Notion marked as Paid — $250 received',time:agoIso(48),createdAt:agoIso(48)},
        {id:uid(),platform:'system',text:'Demo data loaded — welcome to PBOS! 🚀',time:agoIso(96),createdAt:agoIso(96)},
      ];

      // Write to localStorage immediately
      const lsBase = `pbos_${email}`;
      write(`${lsBase}_socialStats`, socData);
      write(`${lsBase}_posts`,       postsData);
      write(`${lsBase}_deals`,       dealsData);
      write(`${lsBase}_tasks`,       tasksData);
      write(`${lsBase}_activity`,    activityData);

      // Sync to server if online
      api('PUT', '/sync', {
        socialStats: socData,
        posts:       postsData,
        deals:       dealsData,
        tasks:       tasksData,
        activity:    activityData
      });
    }
  };

  // ── PUBLIC API ────────────────────────────────────────────────────────────────
  return {
    users,
    session,
    activity,
    socialStats,
    stats,
    demo,
    syncAll,
    checkServer,
    serverOnline: () => serverOnline,
    posts:  () => collection('posts'),
    deals:  () => collection('deals'),
    tasks:  () => collection('tasks'),
    uid
  };

})();

// ── AUTO-SYNC on page focus (re-fetches server data when user returns to tab) ──
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) DB.syncAll();
});
