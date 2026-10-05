// Rooms: study together with friends. A room has a short code and a link;
// anyone signed in who has either can join. Inside, everyone in the room is
// listed with what their own timer is doing, live, and the room plays music
// from a shared queue of YouTube links that stays in step for everyone: any
// member can add a song, play, pause or skip, and the change reaches the
// others at once. It runs on the same sign-in and statuses as Friends
// (friends.js), which tells it who is where.
//
// The music state lives on the room as { queue, index, playing, position, at }:
// the song at index was at position seconds at the moment at (ms), so where
// it should be now is worked out the same way on every page.
(function () {
  var social = window.studySocial;
  var section = document.getElementById('rooms');
  if (!social) return;
  section.hidden = false;

  var db = social.db;
  var PREVIEW = social.preview;
  var ROOM_KEY = 'study-room';  // the code of the room you're in, to come back to it
  var STALE = 12 * 3600000;
  var EMPTY = { queue: [], index: 0, playing: false, position: 0, at: 0 };

  var room = null;  // { id, code, name, music }
  var channel = null;
  var names = {};  // display names of people in the room, by user id
  var player = null;
  var playerReady = false;
  var loadedId = null;  // the video the player has, so a change of song is spotted

  var signedOutEl = document.getElementById('rooms-signed-out');
  var lobbyEl = document.getElementById('rooms-lobby');
  var roomEl = document.getElementById('room');
  var listEl = document.getElementById('rooms-list');
  var nameEl = document.getElementById('room-name');
  var membersEl = document.getElementById('room-members');
  var nowEl = document.getElementById('room-now');
  var playBtn = document.getElementById('music-play');
  var skipBtn = document.getElementById('music-skip');
  var queueEl = document.getElementById('music-queue');
  var unmuteEl = document.getElementById('music-unmute');
  var linkInput = document.getElementById('music-link');

  // A room link is kept until it can be used, through sign-in if need be
  var params = new URLSearchParams(location.search);
  if (params.get('room')) {
    try { localStorage.setItem(ROOM_KEY, params.get('room')); } catch (e) {}
    history.replaceState(null, '', location.pathname);
  }

  function stored() {
    try { return localStorage.getItem(ROOM_KEY); } catch (e) { return null; }
  }

  function remember(code) {
    try {
      if (code) localStorage.setItem(ROOM_KEY, code);
      else localStorage.removeItem(ROOM_KEY);
    } catch (e) {}
  }

  function view() {
    var me = social.me();
    signedOutEl.hidden = !!me;
    lobbyEl.hidden = !me || !!room;
    roomEl.hidden = !me || !room;
  }

  // The 11-character id in any usual YouTube link, or a bare id
  function videoId(text) {
    text = text.trim();
    if (/^[\w-]{11}$/.test(text)) return text;
    var m = text.match(/(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|live)\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  // Where the current song should be now, in seconds
  function expected(m) {
    return m.position + (m.playing ? (Date.now() - m.at) / 1000 : 0);
  }

  function current() {
    return room && room.music.queue[room.music.index];
  }

  /* Joining and leaving */

  async function enter(code) {
    var me = social.me();
    if (!me) return;
    if (PREVIEW) {
      // Nothing is stored anywhere, so the room's name doubles as its code
      room = { id: 'preview', code: code || 'My room', name: code || 'My room', music: Object.assign({}, EMPTY) };
    } else {
      var res = await db.rpc('join_room', { code: code });
      if (res.error) {
        alert(res.error.message);
        remember(null);
        return;
      }
      room = res.data;
      room.music = Object.assign({}, EMPTY, room.music);
      subscribe();
    }
    remember(room.code);
    window.studyRoom = { id: room.id, name: room.name, code: room.code };
    names[me.id] = me.display_name;
    loadedId = null;
    view();
    renderRoom();
    social.pushStatus();
    loadPlayer();
  }

  function leave() {
    if (channel) { db.removeChannel(channel); channel = null; }
    if (playerReady) player.stopVideo();
    loadedId = null;
    room = null;
    window.studyRoom = null;
    remember(null);
    unmuteEl.hidden = true;
    social.pushStatus();
    view();
    renderLobby();
  }

  // The room's music and name, as anyone in it changes them
  function subscribe() {
    if (channel) db.removeChannel(channel);
    channel = db.channel('room:' + room.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'id=eq.' + room.id }, function (change) {
        if (!room || change.new.id !== room.id) return;
        room.name = change.new.name;
        room.music = Object.assign({}, EMPTY, change.new.music);
        renderRoom();
      })
      .subscribe();
  }

  document.getElementById('room-new').addEventListener('click', async function () {
    var me = social.me();
    var name = (prompt('Name the room:', me.display_name.split(' ')[0] + '\'s room') || '').trim().slice(0, 40);
    if (!name) return;
    if (PREVIEW) { enter(name); return; }
    var res = await db.from('rooms').insert({ name: name }).select().single();
    if (res.error) { alert(res.error.message); return; }
    enter(res.data.code);
  });

  document.getElementById('room-join').addEventListener('click', function () {
    var code = (prompt('Room code:') || '').trim().toLowerCase();
    if (code) enter(code);
  });

  document.getElementById('room-leave').addEventListener('click', leave);

  document.getElementById('room-copy').addEventListener('click', function () {
    var link = location.origin + location.pathname + '?room=' + room.code;
    copyText(link).then(function () {
      var toast = document.getElementById('copy-toast');
      toast.textContent = 'Room link copied · code ' + room.code;
      toast.style.opacity = '1';
      setTimeout(function () { toast.style.opacity = '0'; }, 2000);
    });
  });

  /* The lobby: rooms friends are in now, then ones you've been in */

  async function renderLobby() {
    var me = social.me();
    if (!me || room) return;
    var statuses = social.statuses();
    var live = {};  // room code to { name, people }
    Object.keys(statuses).forEach(function (id) {
      var st = statuses[id];
      if (id === me.id || !st.room_code || Date.now() - Date.parse(st.updated_at) > STALE) return;
      var r = live[st.room_code] || (live[st.room_code] = { name: st.room_name, people: [] });
      r.people.push(id);
    });

    var recent = [];
    if (!PREVIEW) {
      var res = await db.from('rooms').select('code, name').order('created_at', { ascending: false }).limit(5);
      if (!res.error) recent = res.data.filter(function (r) { return !live[r.code]; });
    }
    if (room) return;  // joined one while that loaded

    listEl.innerHTML = '';
    Object.keys(live).forEach(function (code) {
      listEl.appendChild(lobbyRow(code, live[code].name, live[code].people.length + ' studying', true));
    });
    recent.forEach(function (r) {
      listEl.appendChild(lobbyRow(r.code, r.name, r.code, false));
    });
    if (!listEl.children.length) {
      var hint = document.createElement('li');
      hint.className = 'study-chart-caption';
      hint.textContent = 'Start a room, then send friends its link.';
      listEl.appendChild(hint);
    }
  }

  function lobbyRow(code, name, note, busy) {
    var li = document.createElement('li');
    li.className = 'row';
    var label = document.createElement('span');
    label.className = 'row-label';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'study-backup-option room-open' + (busy ? ' room-busy' : '');
    btn.textContent = name;
    btn.onclick = function () { enter(code); };
    label.appendChild(btn);
    var side = document.createElement('span');
    side.className = 'row-year';
    side.textContent = note;
    li.appendChild(label);
    li.appendChild(side);
    return li;
  }

  /* Inside a room */

  // Who is here: everyone whose status says this room, you first
  function members() {
    var me = social.me();
    var statuses = social.statuses();
    var ids = Object.keys(statuses).filter(function (id) {
      var st = statuses[id];
      return st.room_id === room.id && Date.now() - Date.parse(st.updated_at) < STALE;
    });
    if (ids.indexOf(me.id) < 0) ids.push(me.id);
    return ids.sort(function (a, b) { return (b === me.id) - (a === me.id); });
  }

  // Roommates who aren't friends need their names looked up
  async function lookUp(ids) {
    var missing = ids.filter(function (id) { return !names[id]; });
    if (!missing.length || PREVIEW) return;
    var res = await db.from('profiles').select('id, display_name').in('id', missing);
    if (res.error) return;
    res.data.forEach(function (p) { names[p.id] = p.display_name; });
    renderMembers();
  }

  function renderMembers() {
    if (!room) return;
    var me = social.me();
    var statuses = social.statuses();
    var ids = members();
    lookUp(ids);
    membersEl.innerHTML = '';
    ids.forEach(function (id) {
      var li = document.createElement('li');
      var line = document.createElement('div');
      line.className = 'row';
      var name = document.createElement('span');
      name.className = 'row-label';
      name.textContent = id === me.id ? 'You' : names[id] || '…';
      line.appendChild(name);
      li.appendChild(line);
      var st = statuses[id];
      if (st && social.active(st)) {
        var now = document.createElement('p');
        now.className = 'board-now' + (st.kind === 'brk' ? ' board-now-break' : '') + (st.since ? ' board-now-running' : '');
        now.dataset.user = id;
        li.appendChild(now);
      }
      membersEl.appendChild(li);
    });
    tickMembers();
  }

  function tickMembers() {
    var statuses = social.statuses();
    membersEl.querySelectorAll('.board-now').forEach(function (el) {
      var st = statuses[el.dataset.user];
      if (st) el.textContent = social.describe(st);
    });
  }

  function renderRoom() {
    if (!room) return;
    nameEl.textContent = room.name;
    window.studyRoom = { id: room.id, name: room.name, code: room.code };
    renderMembers();
    renderMusic();
    applyMusic();
  }

  /* Music */

  function renderMusic() {
    var m = room.music;
    var song = current();
    nowEl.textContent = song ? (m.playing ? 'Playing · ' : 'Paused · ') + song.title : 'Nothing playing. Paste a YouTube link below.';
    playBtn.textContent = m.playing ? 'Pause' : 'Play';
    playBtn.disabled = !song;
    skipBtn.disabled = !song;

    queueEl.innerHTML = '';
    m.queue.forEach(function (item, i) {
      if (i < m.index) return;  // already played
      var li = document.createElement('li');
      li.className = 'row study-lap' + (i === m.index ? ' music-current' : ' study-lap-break');
      var label = document.createElement('span');
      label.className = 'study-label';
      var name = document.createElement('span');
      name.className = 'study-name';
      name.textContent = item.title;
      label.appendChild(name);
      li.appendChild(label);
      if (i > m.index) {
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'study-backup-option';
        remove.textContent = 'Remove';
        remove.onclick = function () {
          var next = Object.assign({}, room.music);
          next.queue = next.queue.filter(function (_, j) { return j !== i; });
          writeMusic(next);
        };
        li.appendChild(remove);
      }
      queueEl.appendChild(li);
    });
  }

  // Brings the player in line with the room: the right song, at the right
  // spot, playing or not
  function applyMusic() {
    if (!room || !playerReady) return;
    var m = room.music;
    var song = current();
    if (!song) {
      if (loadedId) player.stopVideo();
      loadedId = null;
      unmuteEl.hidden = true;
      return;
    }
    var at = expected(m);
    if (song.id !== loadedId) {
      loadedId = song.id;
      if (m.playing) player.loadVideoById(song.id, at);
      else player.cueVideoById(song.id, at);
    } else {
      if (Math.abs(player.getCurrentTime() - at) > 2) player.seekTo(at, true);
      if (m.playing) player.playVideo();
      else player.pauseVideo();
    }
    // Browsers hold back sound until the page has been clicked, so a room
    // already playing on arrival may need one
    clearTimeout(applyMusic.check);
    applyMusic.check = setTimeout(function () {
      var state = player.getPlayerState();
      unmuteEl.hidden = !(room && room.music.playing && state !== 1 && state !== 3);
    }, 1500);
  }

  // Changes the music for everyone: here at once, then in the room
  async function writeMusic(m) {
    room.music = m;
    renderMusic();
    applyMusic();
    if (PREVIEW) return;
    var res = await db.from('rooms').update({ music: m }).eq('id', room.id);
    if (res.error) console.error(res.error);
  }

  function position() {
    return playerReady && loadedId ? player.getCurrentTime() : expected(room.music);
  }

  playBtn.addEventListener('click', function () {
    var m = room.music;
    writeMusic(Object.assign({}, m, { playing: !m.playing, position: position(), at: Date.now() }));
  });

  // Moves on from the song at index; a song that ends on every page at once
  // only moves the queue on once
  function skip(from) {
    var m = room.music;
    if (m.index !== from) return;
    writeMusic(Object.assign({}, m, { index: m.index + 1, position: 0, at: Date.now(), playing: m.index + 1 < m.queue.length }));
  }

  skipBtn.addEventListener('click', function () { skip(room.music.index); });

  unmuteEl.addEventListener('click', function () {
    unmuteEl.hidden = true;
    loadedId = null;  // loads the song afresh, now that sound is allowed
    applyMusic();
  });

  document.getElementById('music-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = videoId(linkInput.value);
    if (!id) { alert('That doesn\'t look like a YouTube link.'); return; }
    linkInput.value = '';
    var title = 'YouTube video';
    try {
      var info = await (await fetch('https://noembed.com/embed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))).json();
      if (info.title) title = info.title;
    } catch (err) {}
    var m = Object.assign({}, room.music);
    var idle = m.index >= m.queue.length;
    m.queue = m.queue.concat([{ id: id, title: title }]);
    if (idle) Object.assign(m, { playing: true, position: 0, at: Date.now() });
    writeMusic(m);
  });

  // The YouTube player, made the first time a room is entered. Its own
  // controls are off, so every change goes through the buttons and is shared.
  function loadPlayer() {
    if (player) { applyMusic(); return; }
    window.onYouTubeIframeAPIReady = function () {
      player = new YT.Player('room-player', {
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: function () { playerReady = true; applyMusic(); },
          onStateChange: function (e) {
            if (e.data === YT.PlayerState.ENDED && room) skip(room.music.index);
            if (e.data === YT.PlayerState.PLAYING) unmuteEl.hidden = true;
          }
        }
      });
    };
    var script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  }

  /* Keeping up */

  document.addEventListener('study:signed-in', function () {
    view();
    var code = stored();
    if (code && !room) enter(code);
    else renderLobby();
  });

  document.addEventListener('study:signed-out', function () {
    if (room) leave();
    view();
  });

  // Someone's status changed: maybe in this room, maybe a friend's room
  document.addEventListener('study:status', function () {
    if (room) renderMembers();
    else renderLobby();
  });

  setInterval(function () { if (room) tickMembers(); }, 1000);

  document.getElementById('rooms-sign-in').addEventListener('click', social.signIn);

  view();
  if (social.me()) {
    if (stored()) enter(stored());
    else renderLobby();
  }
})();
