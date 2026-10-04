// Friends: sign in with Google, and your study sessions are copied up to
// Supabase so friends can see them on a leaderboard next to their own. The
// timer itself still runs entirely from this browser's storage; this only
// reads the history it keeps and uploads the study turns in it, whenever the
// timer says the history changed (and once on every visit). Friends are added
// by sending an invite link, which makes you friends as soon as it's opened,
// or by username, which the other person then accepts.
(function () {
  var config = window.STUDY_CONFIG || {};
  var section = document.getElementById('friends');
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) return;
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

  var db = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  var me = null;  // the signed-in profile
  var sort = 'week';
  var rows = [];

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
    if (!me) return;
    var history;
    try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { history = []; }
    var turns = history
      .filter(function (t) { return t.kind === 'study' && t.ms > 0 && t.at; })
      .map(function (t) { return { started_at: new Date(t.at).toISOString(), ms: Math.min(Math.round(t.ms), 86400000) }; });
    for (var i = 0; i < turns.length; i += 500) {
      var res = await db.from('sessions').upsert(turns.slice(i, i + 500), { onConflict: 'user_id,started_at', ignoreDuplicates: true });
      if (res.error) { console.error(res.error); return; }
    }
    await refresh();
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
    var board = await db.rpc('leaderboard', { tz: TZ });
    if (board.error) { console.error(board.error); return; }
    rows = board.data;
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
      li.className = 'row board-row' + (row.id === me.id ? ' board-me' : '');
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
      li.appendChild(name);
      li.appendChild(value);
      boardEl.appendChild(li);
    });
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

  async function signedIn(user) {
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
    await sync();
  }

  function signedOut() {
    me = null;
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
  }

  document.getElementById('sign-in').addEventListener('click', function () {
    db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  });

  document.getElementById('sign-out').addEventListener('click', async function () {
    await db.auth.signOut();
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

  // The timer fires this whenever its history gains or loses turns
  document.addEventListener('study:history', sync);
  // Friends' totals move while they study, so the board refreshes now and then
  setInterval(function () { if (me && !document.hidden) refresh(); }, 60000);

  db.auth.getSession().then(function (res) {
    if (res.data.session) signedIn(res.data.session.user);
    else signedOut();
  });
  db.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN' && session && !me) signedIn(session.user);
    if (event === 'SIGNED_OUT') signedOut();
  });
})();
