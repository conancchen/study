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
// localhost, where it runs as a preview: signing in shows the board with just
// you on it, live from this timer, and nothing is sent anywhere. Adding
// ?preview to a localhost address gets the same preview even with a project
// set up, so everything behind sign-in can be tried without a Google login.
// The preview comes with a few made-up friend requests, so the notifications
// bell and its count can be tried too, and the one you've "sent" is accepted
// a few seconds in; ?preview=empty starts with none.
(function () {
  var config = window.STUDY_CONFIG || {};
  var section = document.getElementById('friends');
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var PREVIEW = local && (/[?&]preview\b/.test(location.search) || !(config.supabaseUrl && config.supabaseAnonKey));
  var configured = !PREVIEW && !!(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
  if (!configured && !PREVIEW) return;
  section.hidden = false;
  // The account part of settings comes with Friends
  document.getElementById('settings-account-block').hidden = false;

  var HISTORY_KEY = 'study-history';
  var FORGOTTEN_KEY = 'study-forgotten';  // deleted turns, to take down
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
  var scope = 'friends';  // or 'global': everyone, not just friends
  var rows = [];
  var statuses = {};  // each person's timer right now, by user id
  var opened = {};  // board entries left open, by user id
  var uploaded = {};  // turn start times already sent up this visit
  var STALE = 12 * 3600000;  // a status untouched this long is shown as idle
  var LAPSED = 3 * 60000;     // a running status not re-sent this long was left in a closed tab

  var signedOutEl = document.getElementById('friends-signed-out');
  var signedInEl = document.getElementById('friends-signed-in');
  var boardEl = document.getElementById('board');
  var sortEl = document.getElementById('board-sort');
  var scopeEl = document.getElementById('board-scope');
  var requestsEl = document.getElementById('requests');
  var notifyEl = document.getElementById('friends-notify');
  var notifyCountEl = document.getElementById('notify-count');
  var usernameEl = document.getElementById('username');
  var accountEl = document.getElementById('settings-account');
  var accountOutEl = document.getElementById('settings-signed-out');
  var signOutEl = document.getElementById('settings-sign-out');
  var inviteNoteEl = document.getElementById('invite-note');

  // The preview's pretend requests, shaped like the database's, and the
  // pretend friends accepting them adds to the board
  var demoPending = [];
  var demoFriends = [];
  // and pretend strangers, who only show on the global board
  var demoStrangers = [
    { id: 'demo-ana', username: 'ana_p', display_name: 'Ana Park', today_ms: 9000000, week_ms: 41000000, all_ms: 520000000, streak: 21 },
    { id: 'demo-leo', username: 'leo', display_name: 'Leo Grant', today_ms: 5400000, week_ms: 30000000, all_ms: 310000000, streak: 9 },
    { id: 'demo-priya', username: 'priya_s', display_name: 'Priya Shah', today_ms: 7200000, week_ms: 25000000, all_ms: 400000000, streak: 14 },
    { id: 'demo-tom', username: 'tomw', display_name: 'Tom Wu', today_ms: 1800000, week_ms: 12000000, all_ms: 90000000, streak: 3 }
  ];
  var demoTimer;
  function seedDemo() {
    demoFriends = [];
    memory = {};
    clearTimeout(demoTimer);
    if (/[?&]preview=empty\b/.test(location.search)) { demoPending = []; return; }
    var jo = { requester: 'me', addressee: 'demo-jo', receiver: { username: 'jo_k', display_name: 'Jo Kim' } };
    demoPending = [
      { requester: 'demo-maya', addressee: 'me', sender: { username: 'maya', display_name: 'Maya Lin' } },
      { requester: 'demo-sam', addressee: 'me', sender: { username: 'samr', display_name: 'Sam Rivera' } },
      jo
    ];
    demoTimer = setTimeout(function () {
      if (!me || demoPending.indexOf(jo) < 0) return;
      demoPending.splice(demoPending.indexOf(jo), 1);
      demoFriends.push({ id: 'demo-jo', username: 'jo_k', display_name: 'Jo Kim', today_ms: 0, week_ms: 0, all_ms: 0, streak: 0 });
      refresh();
    }, 8000);
  }

  // Requests you've sent, as last seen, and the ones since accepted, kept per
  // account in this browser; the preview keeps them in memory instead
  var memory = {};
  function recall(key) {
    key += '-' + me.id;
    if (PREVIEW) return memory[key] || [];
    try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
  }
  function keep(key, list) {
    key += '-' + me.id;
    if (PREVIEW) { memory[key] = list; return; }
    try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) {}
  }

  // A request you sent that's gone from the waiting list, and whose person is
  // now on the board, was accepted; one that's gone otherwise was declined or
  // cancelled, and says nothing
  function acceptances(outgoing) {
    var accepted = recall('study-accepted');
    recall('study-sent').forEach(function (sent) {
      var still = outgoing.some(function (req) { return req.addressee === sent.id; });
      var friend = rows.some(function (row) { return row.id === sent.id; });
      if (!still && friend && !accepted.some(function (a) { return a.id === sent.id; })) accepted.push(sent);
    });
    keep('study-sent', outgoing.map(function (req) {
      var who = req.receiver || {};
      return { id: req.addressee, username: who.username, display_name: who.display_name, avatar_url: who.avatar_url };
    }));
    keep('study-accepted', accepted);
    return accepted;
  }

  // An invite link is kept until it can be used, through the Google sign-in
  // and its redirect if need be
  var params = new URLSearchParams(location.search);
  if (params.get('invite')) {
    try { localStorage.setItem(INVITE_KEY, params.get('invite')); } catch (e) {}
    params.delete('invite');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  }
  function pendingInvite() {
    try { return localStorage.getItem(INVITE_KEY); } catch (e) { return null; }
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

  // A status worth showing: a turn under way, and touched recently
  function active(st) {
    return st && (st.since || st.banked_ms > 0) && Date.now() - Date.parse(st.updated_at) < STALE;
  }

  // Someone's status, read as paused where it was last sent if a running
  // clock has gone quiet (their tab closed; it's re-sent every minute)
  function status(id) {
    var st = statuses[id];
    if (!st || !st.since) return st;
    var last = Date.parse(st.updated_at);
    if (Date.now() - last < LAPSED) return st;
    var ms = st.banked_ms + Math.max(0, last - Date.parse(st.since));
    return Object.assign({}, st, { since: null, banked_ms: st.target_ms ? Math.min(ms, st.target_ms) : ms });
  }

  // The study turn someone has on the clock right now, which the database
  // only counts once it's finished
  function running(id) {
    var st = status(id);
    if (!active(st) || st.kind !== 'study') return 0;
    return st.banked_ms + (st.since ? Math.max(0, Date.now() - Date.parse(st.since)) : 0);
  }

  // A total with the running turn in it, so the board counts up live
  function live(row, key) {
    var value = row[SORTS[key].field];
    return key === 'streak' ? value : value + running(row.id);
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
    var removed = await unload();
    var history;
    try { history = JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch (e) { history = []; }
    var forgotten = recallForgotten();
    var turns = history
      .filter(function (t) { return t.kind === 'study' && t.ms > 0 && t.at && !uploaded[t.at] && forgotten.indexOf(t.at) < 0; })
      .map(function (t) { return { started_at: new Date(t.at).toISOString(), ms: Math.min(Math.round(t.ms), 86400000) }; });
    for (var i = 0; i < turns.length; i += 500) {
      var res = await db.from('sessions').upsert(turns.slice(i, i + 500), { onConflict: 'user_id,started_at', ignoreDuplicates: true });
      if (res.error) { console.error(res.error); return; }
    }
    history.forEach(function (t) { if (t.at) uploaded[t.at] = true; });
    if (turns.length || removed) await refresh();
  }

  function recallForgotten() {
    try { return JSON.parse(localStorage.getItem(FORGOTTEN_KEY)) || []; } catch (e) { return []; }
  }

  // Takes the turns deleted on the timer out of the database, and lets them
  // go from the list once they're confirmed gone; ones deleted while signed
  // out, or that the database wouldn't let go, wait here for the next try.
  // True if any were taken out.
  var warnedStuck = false;
  async function unload() {
    var forgotten = recallForgotten();
    if (!forgotten.length) return false;
    var times = forgotten.map(function (at) { return new Date(at).toISOString(); });
    var res = await db.from('sessions').delete().eq('user_id', me.id).in('started_at', times);
    if (res.error) { console.error(res.error); return false; }
    // A delete the database's rules don't allow fails without an error, so
    // what's still there is looked up
    var check = await db.from('sessions').select('started_at').eq('user_id', me.id).in('started_at', times);
    if (check.error) { console.error(check.error); return false; }
    var stuck = check.data.map(function (row) { return Date.parse(row.started_at); });
    var done = forgotten.filter(function (at) { return stuck.indexOf(at) < 0; });
    var left = recallForgotten().filter(function (at) { return done.indexOf(at) < 0; });
    try { localStorage.setItem(FORGOTTEN_KEY, JSON.stringify(left)); } catch (e) {}
    if (stuck.length && !warnedStuck) {
      warnedStuck = true;
      console.error('Sessions not deleted; is the "sessions delete own" policy from schema.sql set up?');
      toast('Couldn\'t take deleted sessions off the leaderboard');
    }
    return done.length > 0;
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
      place: now.place,
      updated_at: new Date().toISOString()
    };
    if (!PREVIEW) {
      var res = await db.from('status').upsert(row);
      // Until the place column is added (supabase/schema.sql), the rest still goes up
      if (res.error && res.error.code === 'PGRST204') {
        var rest = Object.assign({}, row);
        delete rest.place;
        res = await db.from('status').upsert(rest);
      }
      if (res.error) { console.error(res.error); return; }
    }
    statuses[me.id] = row;
    announce(row);
    if (rows.length) renderBoard();
  }

  // The map (map.js) shares this sign-in and these statuses
  function announce(row) {
    document.dispatchEvent(new CustomEvent('study:status', { detail: row }));
  }

  window.studySocial = {
    db: db,
    preview: PREVIEW,
    me: function () { return me; },
    statuses: function () { return statuses; },
    friends: function () { return rows; },  // you included, as on the board
    pushStatus: pushStatus,
    signIn: function () { document.getElementById('sign-in').click(); },
    // What someone's doing and where, e.g. "Studying · Firestone Library"
    describe: function (st) {
      var verb = !st.since ? 'Paused' : st.kind === 'brk' ? 'On break' : 'Studying';
      return verb + (st.place ? ' · ' + st.place : '');
    },
    active: active
  };

  // The timer saves in bursts (a lap is a save or two in a row), so the
  // uploads wait for it to settle
  var saveTimer;
  function saved() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { pushStatus(); sync(); }, 800);
  }

  // The invite is only let go once the database has answered for it, so a
  // dropped connection doesn't lose it
  async function useInvite() {
    var code = pendingInvite();
    if (!code) return;
    var res = await db.rpc('accept_invite', { code: code });
    if (res.error && !res.error.code) { console.error(res.error); return; }  // never reached the database
    try { localStorage.removeItem(INVITE_KEY); } catch (e) {}
    if (res.error) toast(res.error.message);
    else if (res.data !== me.display_name) toast('You and ' + res.data + ' are now friends');
  }

  async function refresh() {
    if (PREVIEW) {
      rows = [myTotals()].concat(demoFriends, scope === 'global' ? demoStrangers : []);
      renderBoard();
      renderRequests(demoPending);
      return;
    }
    // (everyone only when asked for, so the friends board still works on a
    // database that hasn't had the global one added yet)
    var board = await db.rpc('leaderboard', scope === 'global' ? { tz: TZ, everyone: true } : { tz: TZ });
    if (board.error) {
      console.error(board.error);
      if (scope === 'global') toast('Couldn\'t load the global leaderboard');
      return;
    }
    rows = board.data;
    var st = await db.from('status').select();
    if (!st.error) {
      statuses = {};
      st.data.forEach(function (row) { statuses[row.user_id] = row; });
      announce(null);
    }
    renderBoard();
    document.dispatchEvent(new CustomEvent('study:friends'));

    // Requests both ways: ones to answer, and ones still waiting on someone
    var pending = await db.from('friendships')
      .select('requester, addressee,'
        + ' sender:profiles!friendships_requester_fkey(username, display_name, avatar_url),'
        + ' receiver:profiles!friendships_addressee_fkey(username, display_name, avatar_url)')
      .eq('accepted', false);
    if (pending.error) console.error(pending.error);
    renderRequests(pending.error ? [] : pending.data);
  }

  function renderBoard() {
    var sorted = rows.slice().sort(function (a, b) { return live(b, sort) - live(a, sort) || a.display_name.localeCompare(b.display_name); });
    boardEl.innerHTML = '';
    if (scope === 'global') {
      // The global board is a podium of the top 3, plus you wherever you place
      boardEl.appendChild(podium(sorted.slice(0, 3)));
      sorted.forEach(function (row, i) {
        if (i >= 3 && row.id === me.id) boardEl.appendChild(boardRow(row, i));
      });
    } else {
      sorted.forEach(function (row, i) { boardEl.appendChild(boardRow(row, i)); });
    }
    tickBoard();

    Object.keys(SORTS).forEach(function (key) {
      sortEl.querySelector('[data-sort="' + key + '"]').classList.toggle('active', key === sort);
    });
    scopeEl.querySelectorAll('[data-scope]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.scope === scope);
    });
  }

  // First in the middle and tallest, second on the left, third on the right
  function podium(top) {
    var li = document.createElement('li');
    li.className = 'podium';
    [1, 0, 2].forEach(function (i) {
      var row = top[i];
      if (!row) return;
      var spot = document.createElement('div');
      spot.className = 'podium-spot podium-' + (i + 1) + (row.id === me.id ? ' board-me' : '');
      spot.title = '@' + row.username;
      if (row.avatar_url) {
        var img = document.createElement('img');
        img.className = 'podium-avatar';
        img.src = row.avatar_url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        spot.appendChild(img);
      }
      var name = document.createElement('span');
      name.className = 'podium-name';
      name.textContent = row.id === me.id ? 'You' : row.display_name;
      spot.appendChild(name);
      var value = document.createElement('span');
      value.className = 'podium-total board-total';
      value.dataset.user = row.id;
      value.dataset.sort = sort;
      spot.appendChild(value);
      var step = document.createElement('div');
      step.className = 'podium-step';
      step.appendChild(medal(i));
      spot.appendChild(step);
      li.appendChild(spot);
    });
    return li;
  }

  // A crown for 1st, then silver and bronze
  function medal(i) {
    var el = document.createElement('span');
    el.className = 'medal';
    el.textContent = ['👑', '🥈', '🥉'][i];
    el.setAttribute('aria-label', ['1st', '2nd', '3rd'][i] + ' place');
    return el;
  }

  // One person's line on the board, opening to their stats and turns
  function boardRow(row, i) {
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
    rank.appendChild(i < 3 ? medal(i) : document.createTextNode(i + 1));
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
    value.className = 'row-year board-total';
    value.dataset.user = row.id;
    value.dataset.sort = sort;
    line.appendChild(name);
    line.appendChild(value);
    summary.appendChild(line);

    // Every friend gets a line, so who's studying and who isn't reads at a
    // glance; on the global board, strangers' clocks stay private (the
    // database only hands over friends' statuses anyway)
    var st = status(row.id);
    var mine = scope === 'friends' || row.id === me.id || !!statuses[row.id];
    if (mine) {
      var now = document.createElement('p');
      now.className = !active(st) ? 'board-now board-now-idle'
        : 'board-now' + (st.kind === 'brk' ? ' board-now-break' : '') + (st.since ? ' board-now-running' : '');
      now.dataset.user = row.id;
      summary.appendChild(now);
    }
    entry.appendChild(summary);
    entry.appendChild(usernameNote(row));
    if (mine) entry.appendChild(turnsNote(st));
    li.appendChild(entry);
    return li;
  }

  // The line under each person: whether they're studying, and where
  // and every total, with any turn still running counted in
  function tickBoard() {
    boardEl.querySelectorAll('.board-now').forEach(function (el) {
      var st = status(el.dataset.user);
      el.textContent = active(st) ? window.studySocial.describe(st) : 'On break';
    });
    var byId = {};
    rows.forEach(function (row) { byId[row.id] = row; });
    boardEl.querySelectorAll('.board-total').forEach(function (el) {
      var row = byId[el.dataset.user];
      if (row) el.textContent = show(live(row, el.dataset.sort), el.dataset.sort);
    });
  }

  // Opening someone shows their username, above their last session
  function usernameNote(row) {
    var note = document.createElement('p');
    note.className = 'row-note board-username';
    note.textContent = '@' + row.username;
    return note;
  }

  // Opening someone shows just their most recent finished study turn
  function turnsNote(st) {
    var note = document.createElement('div');
    note.className = 'row-note';
    var laps = st && Date.now() - Date.parse(st.updated_at) < STALE
      ? st.laps.filter(function (lap) { return lap.kind !== 'brk'; }).slice(-1) : [];
    if (!laps.length) {
      note.textContent = 'No sessions yet';
      return note;
    }
    var heading = document.createElement('p');
    heading.className = 'board-last';
    heading.textContent = 'Last session';
    note.appendChild(heading);
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
      if (lap.at || lap.place) {
        var at = document.createElement('span');
        at.className = 'study-at';
        at.textContent = (lap.at ? ' · ' + new Date(lap.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '')
          + (lap.place ? ' · ' + lap.place : '');
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

  function avatar(who) {
    var img = document.createElement('img');
    img.className = 'board-avatar';
    img.src = who.avatar_url;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    return img;
  }

  // Requests to you come first, each a card with buttons big enough to hit
  // on a phone; ones you've sent sit under them until they're answered
  function renderRequests(pending) {
    requestsEl.innerHTML = '';
    var incoming = pending.filter(function (req) { return req.addressee === me.id; });
    var outgoing = pending.filter(function (req) { return req.requester === me.id; });
    incoming.forEach(function (req) {
      var who = req.sender || {};
      var li = document.createElement('li');
      li.className = 'request';
      if (who.avatar_url) li.appendChild(avatar(who)).classList.add('request-avatar');
      var text = document.createElement('div');
      text.className = 'request-who';
      var name = document.createElement('div');
      name.className = 'request-name';
      name.textContent = who.display_name || 'Someone';
      var sub = document.createElement('div');
      sub.className = 'request-sub';
      sub.textContent = (who.username ? '@' + who.username + ' · ' : '') + 'wants to be friends';
      text.appendChild(name);
      text.appendChild(sub);
      var actions = document.createElement('div');
      actions.className = 'request-actions';
      [['Accept', true], ['Decline', false]].forEach(function (pair) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'study-button request-button' + (pair[1] ? ' request-accept' : '');
        btn.textContent = pair[0];
        btn.onclick = async function () {
          actions.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
          if (PREVIEW) {
            demoPending.splice(demoPending.indexOf(req), 1);
            if (pair[1]) {
              demoFriends.push({ id: req.requester, username: who.username, display_name: who.display_name,
                today_ms: 0, week_ms: 0, all_ms: 0, streak: 0 });
              toast('You and ' + who.display_name + ' are now friends');
            }
            refresh();
            return;
          }
          var q = db.from('friendships');
          q = pair[1] ? q.update({ accepted: true }) : q.delete();
          var res = await q.eq('requester', req.requester).eq('addressee', me.id);
          if (res.error) toast(res.error.message);
          else if (pair[1]) toast('You and ' + (who.display_name || 'them') + ' are now friends');
          refresh();
        };
        actions.appendChild(btn);
      });
      li.appendChild(text);
      li.appendChild(actions);
      requestsEl.appendChild(li);
    });
    // Requests you sent that were accepted, each until it's dismissed
    var accepted = acceptances(outgoing);
    accepted.forEach(function (who) {
      var li = document.createElement('li');
      li.className = 'request';
      if (who.avatar_url) li.appendChild(avatar(who)).classList.add('request-avatar');
      var text = document.createElement('div');
      text.className = 'request-who';
      var name = document.createElement('div');
      name.className = 'request-name';
      name.textContent = who.display_name || 'Someone';
      var sub = document.createElement('div');
      sub.className = 'request-sub';
      sub.textContent = 'accepted your request';
      text.appendChild(name);
      text.appendChild(sub);
      var actions = document.createElement('div');
      actions.className = 'request-actions';
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'study-button request-button';
      ok.textContent = 'OK';
      ok.onclick = function () {
        keep('study-accepted', recall('study-accepted').filter(function (a) { return a.id !== who.id; }));
        refresh();
      };
      actions.appendChild(ok);
      li.appendChild(text);
      li.appendChild(actions);
      requestsEl.appendChild(li);
    });
    outgoing.forEach(function (req) {
      var who = req.receiver || {};
      var li = document.createElement('li');
      li.className = 'row request-sent';
      var name = document.createElement('span');
      name.textContent = 'Waiting on ' + (who.display_name || 'them') + (who.username ? ' (@' + who.username + ')' : '');
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'study-backup-option';
      cancel.textContent = 'Cancel';
      cancel.onclick = async function () {
        if (PREVIEW) {
          demoPending.splice(demoPending.indexOf(req), 1);
          refresh();
          return;
        }
        var res = await db.from('friendships').delete().eq('requester', me.id).eq('addressee', req.addressee);
        if (res.error) toast(res.error.message);
        refresh();
      };
      li.appendChild(name);
      li.appendChild(cancel);
      requestsEl.appendChild(li);
    });
    if (!pending.length && !accepted.length) {
      var empty = document.createElement('li');
      empty.className = 'row requests-empty';
      empty.textContent = 'No friend requests';
      requestsEl.appendChild(empty);
    }
    // The bell counts requests waiting on you and acceptances not yet seen
    var count = incoming.length + accepted.length;
    notifyCountEl.hidden = !count;
    notifyCountEl.textContent = count > 9 ? '9+' : count;
    var label = count ? 'Notifications (' + count + ' new)' : 'Notifications';
    notifyEl.setAttribute('aria-label', label);
    notifyEl.title = label;
  }

  // The bell opens and shuts the requests above the board
  function showRequests(open) {
    requestsEl.hidden = !open;
    notifyEl.setAttribute('aria-expanded', open);
  }
  notifyEl.addEventListener('click', function () {
    showRequests(requestsEl.hidden);
  });

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

  // getSession and the SIGNED_IN event both arrive after a Google redirect;
  // only the first goes through, so a new profile isn't made twice
  var signingIn = null;
  function signedIn(user) {
    if (!signingIn) signingIn = signIn(user).finally(function () { signingIn = null; });
    return signingIn;
  }

  async function signIn(user) {
    if (PREVIEW) {
      me = { id: 'me', username: 'you', display_name: 'You', invite_code: 'preview' };
      seedDemo();
      notifyEl.hidden = false;
      signedOutEl.hidden = true;
      signedInEl.hidden = false;
      accountEl.hidden = false;
      accountOutEl.hidden = true;
      signOutEl.hidden = false;
      usernameEl.value = me.username;
      await pushStatus();
      await refresh();
      document.dispatchEvent(new CustomEvent('study:signed-in'));
      return;
    }
    try {
      me = await loadProfile(user);
    } catch (e) {
      console.error(e);
      toast('Couldn\'t load your Friends profile');
      return;
    }
    notifyEl.hidden = false;
    signedOutEl.hidden = true;
    signedInEl.hidden = false;
    accountEl.hidden = false;
    accountOutEl.hidden = true;
    signOutEl.hidden = false;
    usernameEl.value = me.username;
    await useInvite();
    await pushStatus();
    await sync();
    await refresh();
    listen();
    document.dispatchEvent(new CustomEvent('study:signed-in'));
  }

  // Friends' statuses arrive the moment they change; the database only sends
  // the rows this person is allowed to read
  var channel = null;
  var refreshTimer;
  function soon() {  // turns arrive in batches, so one refresh covers them
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 1000);
  }
  function listen() {
    if (channel) return;
    channel = db.channel('status')
      // A request made, answered or taken back, by either side
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, function () {
        refresh();
      })
      // A friend's finished turn landing, or one deleted, moves their totals
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sessions' }, soon)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'sessions' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'status' }, function (change) {
        var row = change.new;
        if (!row || !row.user_id) return;
        statuses[row.user_id] = row;
        announce(row);
        if (rows.some(function (r) { return r.id === row.user_id; })) renderBoard();
        else refresh();  // someone new, like a friend just added
      })
      .subscribe();
  }

  function signedOut() {
    me = null;
    if (channel) { db.removeChannel(channel); channel = null; }
    document.dispatchEvent(new CustomEvent('study:signed-out'));
    notifyEl.hidden = true;
    showRequests(false);
    signedOutEl.hidden = false;
    signedInEl.hidden = true;
    inviteNoteEl.hidden = !pendingInvite();
    accountEl.hidden = true;
    accountOutEl.hidden = false;
    signOutEl.hidden = true;
  }

  // In the preview, the account buttons only say what they'd do
  if (PREVIEW) {
    ['invite', 'add-friend'].forEach(function (id) {
      document.getElementById(id).addEventListener('click', function (e) {
        e.stopImmediatePropagation();
        toast('Not available in preview');
      }, true);
    });
  }

  document.getElementById('sign-in').addEventListener('click', function () {
    if (PREVIEW) { signedIn(null); return; }
    db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  });

  document.getElementById('settings-sign-in').addEventListener('click', function () {
    document.getElementById('settings').close();
    document.getElementById('sign-in').click();
  });

  document.getElementById('sign-out').addEventListener('click', async function () {
    if (!PREVIEW) await db.auth.signOut();
    signedOut();
  });

  // Copies the link, and if the browser won't allow that, puts it on the
  // page to copy by hand
  document.getElementById('invite').addEventListener('click', function () {
    var link = location.origin + location.pathname + '?invite=' + me.invite_code;
    var shown = this.parentNode.nextElementSibling;
    if (shown && shown.classList.contains('invite-link')) shown.remove();
    copyText(link).then(function () { toast('Invite link copied'); }, function () {
      var field = document.createElement('input');
      field.className = 'music-link invite-link';
      field.readOnly = true;
      field.value = link;
      field.setAttribute('aria-label', 'Invite link');
      field.onfocus = function () { field.select(); };
      document.getElementById('invite').parentNode.after(field);
      field.focus();
      toast('Copy the link below');
    });
  });

  document.getElementById('add-friend').addEventListener('click', function () {
    askInline(this.parentNode, 'Their username', async function (name) {
      name = name.replace(/^@/, '').toLowerCase();
      var found = await db.from('profiles').select('id, display_name').eq('username', name).maybeSingle();
      if (!found.data) { toast('No one goes by @' + name); return; }
      var them = found.data;
      if (them.id === me.id) { toast('That\'s you'); return; }
      // If they've already asked you, asking back accepts theirs
      var theirs = await db.from('friendships').select('accepted')
        .eq('requester', them.id).eq('addressee', me.id).maybeSingle();
      if (theirs.data && theirs.data.accepted) { toast('You and ' + them.display_name + ' are already friends'); return; }
      if (theirs.data) {
        var ok = await db.from('friendships').update({ accepted: true }).eq('requester', them.id).eq('addressee', me.id);
        toast(ok.error ? ok.error.message : 'You and ' + them.display_name + ' are now friends');
        refresh();
        return;
      }
      var res = await db.from('friendships').insert({ requester: me.id, addressee: them.id });
      if (res.error && res.error.code === '23505') {
        var mine = await db.from('friendships').select('accepted').eq('requester', me.id).eq('addressee', them.id).maybeSingle();
        toast(mine.data && mine.data.accepted ? 'You and ' + them.display_name + ' are already friends' : 'You\'ve already asked ' + them.display_name);
      }
      else if (res.error) toast(res.error.message);
      else toast('Request sent to ' + them.display_name);
      refresh();
    });
  });

  // The username is changed in settings; it saves on Enter or clicking away
  usernameEl.addEventListener('change', async function () {
    var name = usernameEl.value.trim().replace(/^@/, '').toLowerCase();
    if (PREVIEW) { usernameEl.value = me.username; toast('Not available in preview'); return; }
    if (!name || name === me.username) { usernameEl.value = me.username; return; }
    var res = await db.from('profiles').update({ username: name }).eq('id', me.id).select().single();
    if (res.error) {
      toast(res.error.code === '23505' ? '@' + name + ' is taken' : 'Usernames are 3–20 letters, numbers or _');
      usernameEl.value = me.username;
      return;
    }
    me = res.data;
    usernameEl.value = me.username;
    toast('Username saved');
  });
  usernameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') usernameEl.blur();
  });

  sortEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-sort]');
    if (!btn) return;
    sort = btn.dataset.sort;
    renderBoard();
  });

  scopeEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-scope]');
    if (!btn || btn.dataset.scope === scope) return;
    scope = btn.dataset.scope;
    refresh();
  });

  // The timer fires this every time it saves
  document.addEventListener('study:save', saved);
  setInterval(function () { if (me) tickBoard(); }, 1000);
  // Re-sends a running clock, so friends can tell an open tab from a closed one
  setInterval(function () { if (me && window.studyNow && window.studyNow.since) pushStatus(); }, 60000);
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
