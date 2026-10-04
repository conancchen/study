// Friends: sign in with Google, and your study sessions are copied up to
// Supabase so friends can see them on a leaderboard next to their own. The
// timer itself still runs entirely from this browser's storage; this only
// reads the history it keeps and uploads the study turns in it, whenever the
// timer saves (and once on every visit). It also shares what the clock is
// doing right now, so the board shows who is studying, on which turn, and for
// how long, live; opening a friend lists the turns on their timer. Friends are added
// by sending an invite link, which makes you friends as soon as it's opened,
// or by username, which the other person then accepts.
//
// Without a Supabase project in config.js, Friends stays hidden, except on
// localhost, where it runs as a preview: signing in shows a board of made-up
// friends (with you on it, live from this timer) and nothing is sent anywhere.
(function () {
  var config = window.STUDY_CONFIG || {};
  var section = document.getElementById('friends');
  var configured = !!(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
  var PREVIEW = !configured && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (!configured && !PREVIEW) return;
  section.hidden = false;

  var HISTORY_KEY = 'study-history';
  var INVITE_KEY = 'study-invite';
  var TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  var SORTS = {
    today: { label: 'Today', field: 'today_ms' },
    week: { label: 'This week', field: 'week_ms' },
    all: { label: 'All time', field: 'all_ms' },
    streak: { label: 'Streak', field: 'streak' }
  };

  var db = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;
  var me = null;  // the signed-in profile
  var sort = 'week';
  var rows = [];
  var statuses = {};  // each person's timer right now, by user id
  var opened = {};  // board entries left open, by user id
  var uploaded = {};  // turn start times already sent up this visit
  var STALE = 12 * 3600000;  // a status untouched this long is shown as idle

  var signedOutEl = document.getElementById('friends-signed-out');
  var signedInEl = document.getElementById('friends-signed-in');
  var boardEl = document.getElementById('board');
  var sortEl = document.getElementById('board-sort');
  var requestsEl = document.getElementById('requests');
  var whoEl = document.getElementById('friends-who');

  // An invite link is kept until it can be used, through the Google sign-in
  // and its redirect if need be
  var params = new URLSearchParams(location.search);
  if (params.get('invite')) {
    try { localStorage.setItem(INVITE_KEY, params.get('invite')); } catch (e) {}
    history.replaceState(null, '', location.pathname);
  }

  function duration(ms) {
    var m = Math.floor(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + ('0' + m % 60).slice(-2) + 'm' : m + 'm';
  }

  // "4:05" or "1:04:05", like the clock
  function clock(ms) {
    var s = Math.floor(ms / 1000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var h = Math.floor(s / 3600);
    return h ? h + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) : Math.floor(s / 60) + ':' + pad(s % 60);
  }

  // How long a status's turn has run, counting on from when it last started
  function running(st) {
    return st.banked_ms + (st.since ? Date.now() - Date.parse(st.since) : 0);
  }

  // A status worth showing: a turn under way, and touched recently
  function active(st) {
    return st && (st.since || st.banked_ms > 0) && Date.now() - Date.parse(st.updated_at) < STALE;
  }

  function show(value, key) {
    return key === 'streak' ? value + (value === 1 ? ' day' : ' days') : duration(value);
  }

  // A username from the Google email, made unique with digits if taken
  async function makeProfile(user) {
    var meta = user.user_metadata || {};
    var base = (user.email || 'studier').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 14);
    if (base.length < 3) base = 'studier';
    for (var attempt = 0; attempt < 5; attempt++) {
      var username = attempt ? base + Math.floor(Math.random() * 10000) : base;
      var res = await db.from('profiles').insert({
        id: user.id,
        username: username,
        display_name: meta.full_name || meta.name || username,
        avatar_url: meta.avatar_url || null
      }).select().single();
      if (!res.error) return res.data;
      if (res.error.code !== '23505') throw res.error;  // anything but "taken"
    }
    throw new Error('Couldn\'t pick a username');
  }

  async function loadProfile(user) {
    var res = await db.from('profiles').select().eq('id', user.id).maybeSingle();
    if (res.error) throw res.error;
    return res.data || makeProfile(user);
  }

  // Uploads every study turn in the local history; ones already up there are
  // skipped, so this is safe to run as often as the history changes
  async function sync() {
    if (PREVIEW) return refresh();
    if (!me) return;
    var history;
    try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { history = []; }
    var turns = history
      .filter(function (t) { return t.kind === 'study' && t.ms > 0 && t.at && !uploaded[t.at]; })
      .map(function (t) { return { started_at: new Date(t.at).toISOString(), ms: Math.min(Math.round(t.ms), 86400000) }; });
    for (var i = 0; i < turns.length; i += 500) {
      var res = await db.from('sessions').upsert(turns.slice(i, i + 500), { onConflict: 'user_id,started_at', ignoreDuplicates: true });
      if (res.error) { console.error(res.error); return; }
    }
    history.forEach(function (t) { if (t.at) uploaded[t.at] = true; });
    if (turns.length) await refresh();
  }

  // Writes where the clock stands, from what the timer last saved
  async function pushStatus() {
    var now = window.studyNow;
    if (!me || !now) return;
    var row = {
      user_id: me.id,
      kind: now.kind,
      title: now.title,
      started_at: now.at ? new Date(now.at).toISOString() : null,
      banked_ms: Math.round(now.ms),
      since: now.since ? new Date(now.since).toISOString() : null,
      target_ms: now.target,
      laps: now.laps.slice(-50),
      updated_at: new Date().toISOString()
    };
    if (!PREVIEW) {
      var res = await db.from('status').upsert(row);
      if (res.error) { console.error(res.error); return; }
    }
    statuses[me.id] = row;
    if (rows.length) renderBoard();
  }

  // The timer saves in bursts (a lap is a save or two in a row), so the
  // uploads wait for it to settle
  var saveTimer;
  function saved() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { pushStatus(); sync(); }, 800);
  }

  async function useInvite() {
    var code;
    try { code = localStorage.getItem(INVITE_KEY); localStorage.removeItem(INVITE_KEY); } catch (e) {}
    if (!code) return;
    var res = await db.rpc('accept_invite', { code: code });
    if (res.error) alert(res.error.message);
    else if (res.data !== me.display_name) alert('You and ' + res.data + ' are now friends.');
  }

  async function refresh() {
    if (PREVIEW) {
      rows = preview.rows.concat(myTotals());
      renderBoard();
      return;
    }
    var board = await db.rpc('leaderboard', { tz: TZ });
    if (board.error) { console.error(board.error); return; }
    rows = board.data;
    var st = await db.from('status').select();
    if (!st.error) {
      statuses = {};
      st.data.forEach(function (row) { statuses[row.user_id] = row; });
    }
    renderBoard();

    var pending = await db.from('friendships')
      .select('requester, profiles!friendships_requester_fkey(username, display_name)')
      .eq('addressee', me.id).eq('accepted', false);
    renderRequests(pending.error ? [] : pending.data);
  }

  function renderBoard() {
    var field = SORTS[sort].field;
    var sorted = rows.slice().sort(function (a, b) { return b[field] - a[field] || a.display_name.localeCompare(b.display_name); });
    boardEl.innerHTML = '';
    sorted.forEach(function (row, i) {
      var li = document.createElement('li');
      li.className = row.id === me.id ? 'board-me' : '';
      var entry = document.createElement('details');
      entry.className = 'entry';
      entry.open = !!opened[row.id];
      entry.addEventListener('toggle', function () { opened[row.id] = entry.open; });
      var summary = document.createElement('summary');
      var line = document.createElement('div');
      line.className = 'row';
      var name = document.createElement('span');
      name.className = 'row-label';
      var rank = document.createElement('span');
      rank.className = 'board-rank';
      rank.textContent = i + 1;
      name.appendChild(rank);
      if (row.avatar_url) {
        var img = document.createElement('img');
        img.className = 'board-avatar';
        img.src = row.avatar_url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        name.appendChild(img);
      }
      name.appendChild(document.createTextNode(row.id === me.id ? 'You' : row.display_name));
      name.title = '@' + row.username;
      var value = document.createElement('span');
      value.className = 'row-year';
      value.textContent = show(row[field], sort);
      line.appendChild(name);
      line.appendChild(value);
      summary.appendChild(line);

      var st = statuses[row.id];
      if (active(st)) {
        var now = document.createElement('p');
        now.className = 'board-now' + (st.kind === 'brk' ? ' board-now-break' : '') + (st.since ? ' board-now-running' : '');
        now.dataset.user = row.id;
        summary.appendChild(now);
      }
      entry.appendChild(summary);
      entry.appendChild(turnsNote(st));
      li.appendChild(entry);
      boardEl.appendChild(li);
    });
    tickBoard();
    if (sorted.length < 2) {
      var hint = document.createElement('li');
      hint.className = 'study-chart-caption';
      hint.textContent = 'No friends yet. Send someone your invite link.';
      boardEl.appendChild(hint);
    }

    Object.keys(SORTS).forEach(function (key) {
      sortEl.querySelector('[data-sort="' + key + '"]').classList.toggle('active', key === sort);
    });
  }

  // The live line under someone studying: what the turn is, and its time
  // (out of its length, in timer mode). Runs every second.
  function tickBoard() {
    boardEl.querySelectorAll('.board-now').forEach(function (el) {
      var st = statuses[el.dataset.user];
      if (!st) return;
      var verb = !st.since ? 'Paused' : st.kind === 'brk' ? 'On break' : 'Studying';
      el.textContent = verb + ' · ' + st.title + ' · ' + clock(running(st)) + (st.target_ms ? ' / ' + clock(st.target_ms) : '');
    });
  }

  // Opening someone lists the turns on their timer, newest first
  function turnsNote(st) {
    var note = document.createElement('div');
    note.className = 'row-note';
    var laps = st && Date.now() - Date.parse(st.updated_at) < STALE ? st.laps.slice().reverse() : [];
    if (!laps.length) {
      note.textContent = 'No finished turns on their timer right now.';
      return note;
    }
    var list = document.createElement('ol');
    list.className = 'study-laps';
    laps.forEach(function (lap) {
      var li = document.createElement('li');
      li.className = 'row study-lap' + (lap.kind === 'brk' ? ' study-lap-break' : '');
      var label = document.createElement('span');
      label.className = 'study-label';
      var name = document.createElement('span');
      name.className = 'study-name';
      name.textContent = lap.title;
      label.appendChild(name);
      if (lap.at) {
        var at = document.createElement('span');
        at.className = 'study-at';
        at.textContent = ' · ' + new Date(lap.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        label.appendChild(at);
      }
      var time = document.createElement('span');
      time.className = 'row-year';
      time.textContent = clock(lap.ms);
      li.appendChild(label);
      li.appendChild(time);
      list.appendChild(li);
    });
    note.appendChild(list);
    return note;
  }

  function renderRequests(pending) {
    requestsEl.innerHTML = '';
    pending.forEach(function (req) {
      var who = req.profiles || {};
      var li = document.createElement('li');
      li.className = 'row';
      var name = document.createElement('span');
      name.textContent = (who.display_name || 'Someone') + ' wants to be friends';
      var actions = document.createElement('span');
      actions.className = 'study-backup';
      [['Accept', true], ['Ignore', false]].forEach(function (pair, n) {
        if (n) actions.appendChild(document.createTextNode(' · '));
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'study-backup-option';
        btn.textContent = pair[0];
        btn.onclick = async function () {
          var q = db.from('friendships');
          q = pair[1] ? q.update({ accepted: true }) : q.delete();
          var res = await q.eq('requester', req.requester).eq('addressee', me.id);
          if (res.error) alert(res.error.message);
          refresh();
        };
        actions.appendChild(btn);
      });
      li.appendChild(name);
      li.appendChild(actions);
      requestsEl.appendChild(li);
    });
  }

  // Your own row in the preview, worked out from this browser's history the
  // way the database would
  function myTotals() {
    var history;
    try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { history = []; }
    var day = function (t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    var today = day(Date.now());
    var week = new Date(today);
    week.setDate(week.getDate() - (week.getDay() + 6) % 7);
    var row = { id: me.id, username: me.username, display_name: me.display_name, today_ms: 0, week_ms: 0, all_ms: 0, streak: 0 };
    var days = {};
    history.forEach(function (t) {
      if (t.kind !== 'study' || !(t.ms > 0)) return;
      row.all_ms += t.ms;
      if (!t.at) return;
      days[day(t.at)] = true;
      if (day(t.at) === today) row.today_ms += t.ms;
      if (t.at >= week.getTime()) row.week_ms += t.ms;
    });
    var d = new Date(days[today] ? today : today - 86400000);
    while (days[day(d)]) { row.streak++; d.setDate(d.getDate() - 1); }
    return row;
  }

  // Made-up friends for the preview, mid-study, on break, paused and idle
  var preview = (function () {
    var now = Date.now();
    var min = 60000;
    var ago = function (m) { return new Date(now - m * min).toISOString(); };
    var lap = function (kind, title, m, startedAgo) { return { kind: kind, title: title, ms: m * min, at: now - startedAgo * min }; };
    var people = [
      { id: 'maya', username: 'maya', display_name: 'Maya', today_ms: 142 * min, week_ms: 610 * min, all_ms: 5230 * min, streak: 9,
        status: { kind: 'study', title: 'Linear algebra pset', banked_ms: 0, since: ago(23), target_ms: 50 * min,
          laps: [lap('study', 'Reading: ch. 4', 50, 145), lap('brk', 'Break 1', 10, 95), lap('study', 'Session 2', 50, 85), lap('brk', 'Lunch', 12, 35)] } },
      { id: 'sam', username: 'samk', display_name: 'Sam', today_ms: 95 * min, week_ms: 480 * min, all_ms: 3100 * min, streak: 4,
        status: { kind: 'brk', title: 'Break 2', banked_ms: 0, since: ago(4), target_ms: 10 * min,
          laps: [lap('study', 'Orgo flashcards', 45, 110), lap('brk', 'Break 1', 10, 65), lap('study', 'Problem set 3', 50, 54)] } },
      { id: 'priya', username: 'priya_r', display_name: 'Priya', today_ms: 38 * min, week_ms: 720 * min, all_ms: 8800 * min, streak: 21,
        status: { kind: 'study', title: 'Thesis draft', banked_ms: 38 * min, since: null, target_ms: null, laps: [] } },
      { id: 'leo', username: 'leo', display_name: 'Leo', today_ms: 0, week_ms: 130 * min, all_ms: 940 * min, streak: 0 }
    ];
    var statuses = {};
    people.forEach(function (p) {
      if (p.status) statuses[p.id] = Object.assign({ user_id: p.id, updated_at: new Date(now).toISOString() }, p.status);
      delete p.status;
    });
    return { rows: people, statuses: statuses };
  })();

  async function signedIn(user) {
    if (PREVIEW) {
      me = { id: 'me', username: 'you', display_name: 'You', invite_code: 'preview' };
      statuses = Object.assign({}, preview.statuses);
      signedOutEl.hidden = true;
      signedInEl.hidden = false;
      whoEl.textContent = '@you (preview)';
      await pushStatus();
      await refresh();
      return;
    }
    try {
      me = await loadProfile(user);
    } catch (e) {
      console.error(e);
      alert('Couldn\'t load your Friends profile.');
      return;
    }
    signedOutEl.hidden = true;
    signedInEl.hidden = false;
    whoEl.textContent = '@' + me.username;
    await useInvite();
    await pushStatus();
    await sync();
    await refresh();
    listen();
  }

  // Friends' statuses arrive the moment they change; the database only sends
  // the rows this person is allowed to read
  var channel = null;
  function listen() {
    if (channel) return;
    channel = db.channel('status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'status' }, function (change) {
        var row = change.new;
        if (!row || !row.user_id) return;
        statuses[row.user_id] = row;
        if (rows.some(function (r) { return r.id === row.user_id; })) renderBoard();
        else refresh();  // someone new, like a friend just added
      })
      .subscribe();
  }

  function signedOut() {
    me = null;
    if (channel) { db.removeChannel(channel); channel = null; }
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
  }

  // In the preview, the account buttons only say what they'd do
  if (PREVIEW) {
    ['invite', 'add-friend', 'rename'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function (e) {
        e.stopImmediatePropagation();
        alert('Preview only: this works once Supabase is set up (see the README).');
      }, true);
    });
  }

  document.getElementById('sign-in').addEventListener('click', function () {
    if (PREVIEW) { signedIn(null); return; }
    db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  });

  document.getElementById('sign-out').addEventListener('click', async function () {
    if (!PREVIEW) await db.auth.signOut();
    signedOut();
  });

  document.getElementById('invite').addEventListener('click', function () {
    var link = location.origin + location.pathname + '?invite=' + me.invite_code;
    copyText(link).then(function () {
      var toast = document.getElementById('copy-toast');
      toast.textContent = 'Invite link copied';
      toast.style.opacity = '1';
      setTimeout(function () { toast.style.opacity = '0'; }, 2000);
    });
  });

  document.getElementById('add-friend').addEventListener('click', async function () {
    var name = (prompt('Their username:') || '').trim().replace(/^@/, '').toLowerCase();
    if (!name) return;
    var found = await db.from('profiles').select('id, display_name').eq('username', name).maybeSingle();
    if (!found.data) { alert('No one goes by @' + name + '.'); return; }
    var res = await db.from('friendships').insert({ requester: me.id, addressee: found.data.id });
    if (res.error && res.error.code === '23505') alert('You\'ve already asked ' + found.data.display_name + '.');
    else if (res.error) alert(res.error.message);
    else alert('Asked ' + found.data.display_name + '. They\'ll show up once they accept.');
  });

  document.getElementById('rename').addEventListener('click', async function () {
    var name = (prompt('New username (3–20 letters, numbers or _):', me.username) || '').trim().toLowerCase();
    if (!name || name === me.username) return;
    var res = await db.from('profiles').update({ username: name }).eq('id', me.id).select().single();
    if (res.error) { alert(res.error.code === '23505' ? '@' + name + ' is taken.' : 'Usernames are 3–20 letters, numbers or _.'); return; }
    me = res.data;
    whoEl.textContent = '@' + me.username;
  });

  sortEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-sort]');
    if (!btn) return;
    sort = btn.dataset.sort;
    renderBoard();
  });

  // The timer fires this every time it saves
  document.addEventListener('study:save', saved);
  setInterval(function () { if (me) tickBoard(); }, 1000);
  // Friends' totals move while they study, so the board refreshes now and then
  setInterval(function () { if (me && !document.hidden) refresh(); }, 60000);

  if (PREVIEW) {
    signedOut();
    return;
  }

  db.auth.getSession().then(function (res) {
    if (res.data.session) signedIn(res.data.session.user);
    else signedOut();
  });
  db.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN' && session && !me) signedIn(session.user);
    if (event === 'SIGNED_OUT') signedOut();
  });
})();
