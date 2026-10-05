// Rooms: study together with friends. A room has a short code and a link;
// anyone signed in who has either can join. Inside, everyone in the room is
// listed with what their own timer is doing, live, and the room plays music
// from a shared queue of YouTube and Spotify links that stays in step for everyone: any
// member can add a song, play, pause or skip, and the change reaches the
// others at once. It runs on the same sign-in and statuses as Friends
// (friends.js), which tells it who is where.
//
// Spotify plays through its embed player: whole songs for anyone signed into
// Spotify in that browser, and 30-second previews for anyone who isn't.
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
  var youtubeEl = document.getElementById('room-player-youtube');
  var spotifyEl = document.getElementById('room-player-spotify');

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

  // A song from a pasted link: a YouTube video (any usual link, or a bare
  // id) or a Spotify track or episode (a link or a spotify: uri)
  function parseLink(text) {
    text = text.trim();
    var sp = text.match(/(?:open\.spotify\.com\/(?:intl-[\w-]+\/)?|spotify:)(track|episode)[\/:]([A-Za-z0-9]{22})/);
    if (sp) return { source: 'spotify', id: 'spotify:' + sp[1] + ':' + sp[2] };
    if (/^[\w-]{11}$/.test(text)) return { source: 'youtube', id: text };
    var yt = text.match(/(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|live)\/)([\w-]{11})/);
    return yt ? { source: 'youtube', id: yt[1] } : null;
  }

  // Songs added before Spotify came along are all YouTube
  function sourceOf(song) {
    return song.source || 'youtube';
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
    view();
    renderRoom();
    social.pushStatus();
  }

  function leave() {
    if (channel) { db.removeChannel(channel); channel = null; }
    stopAll();
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
    nowEl.textContent = song ? (m.playing ? 'Playing · ' : 'Paused · ') + song.title : 'Nothing playing. Paste a YouTube or Spotify link below.';
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

  // The two players, each made the first time a song of its kind comes up and
  // driven the same way: load a song at a spot, playing or not; keep it in
  // step; stop; say where it is and whether it's making sound
  var players = {
    youtube: {
      player: null, ready: false, loaded: null,
      start: function () {
        var self = this;
        if (self.started) return;
        self.started = true;
        window.onYouTubeIframeAPIReady = function () {
          self.player = new YT.Player('room-youtube', {
            width: '100%',
            height: '100%',
            // Its own controls are off, so every change goes through the
            // buttons and is shared
            playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
            events: {
              onReady: function () { self.ready = true; applyMusic(); },
              onStateChange: function (e) {
                if (e.data === YT.PlayerState.ENDED) ended('youtube');
                if (e.data === YT.PlayerState.PLAYING) unmuteEl.hidden = true;
              }
            }
          });
        };
        load('https://www.youtube.com/iframe_api');
      },
      load: function (id, at, playing) {
        this.loaded = id;
        if (playing) this.player.loadVideoById(id, at);
        else this.player.cueVideoById(id, at);
      },
      sync: function (at, playing) {
        if (Math.abs(this.player.getCurrentTime() - at) > 2) this.player.seekTo(at, true);
        if (playing) this.player.playVideo();
        else this.player.pauseVideo();
      },
      stop: function () {
        if (this.loaded) this.player.stopVideo();
        this.loaded = null;
      },
      time: function () { return this.player.getCurrentTime(); },
      sounding: function () {
        var state = this.player.getPlayerState();
        return state === 1 || state === 3;  // playing or buffering
      }
    },

    // Spotify's embed holds commands while a song loads and runs them once
    // it's ready, so a load can be followed straight away by play
    spotify: {
      ctl: null, ready: false, loaded: null, state: null,
      start: function () {
        var self = this;
        if (self.started) return;
        self.started = true;
        window.onSpotifyIframeApiReady = function (api) {
          api.createController(document.getElementById('room-spotify'), { width: '100%', height: 80 }, function (ctl) {
            self.ctl = ctl;
            self.ready = true;
            ctl.addListener('playback_update', function (e) {
              var was = self.state;
              self.state = e.data;
              if (!e.data.isPaused) unmuteEl.hidden = true;
              // Reaching the end of a whole song moves the room on. A
              // 30-second preview ending doesn't, or listeners who aren't
              // signed into Spotify would cut the song short for everyone.
              var full = e.data.duration > 31000;
              if (full && was && !was.isPaused && e.data.position >= e.data.duration - 1500) ended('spotify');
            });
            applyMusic();
          });
        };
        load('https://open.spotify.com/embed/iframe-api/v1');
      },
      load: function (id, at, playing) {
        this.loaded = id;
        this.state = null;
        this.ctl.loadUri(id, false, Math.floor(at));
        if (playing) this.ctl.play();
      },
      sync: function (at, playing) {
        if (this.state && Math.abs(this.state.position / 1000 - at) > 3) this.ctl.seek(at);
        if (playing && (!this.state || this.state.isPaused)) this.ctl.resume();
        if (!playing && this.state && !this.state.isPaused) this.ctl.pause();
      },
      stop: function () {
        if (this.loaded) this.ctl.pause();
        this.loaded = null;
      },
      time: function () { return this.state ? this.state.position / 1000 : null; },
      sounding: function () { return !!(this.state && !this.state.isPaused); }
    }
  };

  function load(src) {
    var script = document.createElement('script');
    script.src = src;
    document.head.appendChild(script);
  }

  function stopAll() {
    Object.keys(players).forEach(function (k) {
      if (players[k].ready) players[k].stop();
    });
    unmuteEl.hidden = true;
  }

  // Brings the players in line with the room: the right song in the right
  // player, at the right spot, playing or not, and the other player quiet
  function applyMusic() {
    if (!room) return;
    var m = room.music;
    var song = current();
    var kind = song && sourceOf(song);
    youtubeEl.hidden = kind !== 'youtube';
    spotifyEl.hidden = kind !== 'spotify';
    Object.keys(players).forEach(function (k) {
      if (k !== kind && players[k].ready) players[k].stop();
    });
    if (!song) { unmuteEl.hidden = true; return; }

    var p = players[kind];
    if (!p.ready) { p.start(); return; }  // comes back here once it's ready
    var at = expected(m);
    if (song.id !== p.loaded) p.load(song.id, at, m.playing);
    else p.sync(at, m.playing);

    // Browsers hold back sound until the page has been clicked, so a room
    // already playing on arrival may need one
    clearTimeout(applyMusic.check);
    applyMusic.check = setTimeout(function () {
      unmuteEl.hidden = !(room && room.music.playing && current() === song && !p.sounding());
    }, 2500);
  }

  // A song finished in the player of this kind; moves on if it's still the
  // room's current song
  function ended(kind) {
    var song = current();
    if (room && song && sourceOf(song) === kind) skip(room.music.index);
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
    var song = current();
    var p = song && players[sourceOf(song)];
    var t = p && p.ready && p.loaded === song.id ? p.time() : null;
    return t === null ? expected(room.music) : t;
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
    var song = current();
    if (song) players[sourceOf(song)].loaded = null;  // loads it afresh, now that sound is allowed
    applyMusic();
  });

  document.getElementById('music-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    var song = parseLink(linkInput.value);
    if (!song) { alert('Paste a YouTube video, or a Spotify song or podcast episode.'); return; }
    linkInput.value = '';
    // Titles come from each site's oEmbed, which pages can read directly
    var spotify = song.source === 'spotify';
    var url = spotify
      ? 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/' + song.id.split(':').slice(1).join('/'))
      : 'https://noembed.com/embed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + song.id);
    song.title = spotify ? 'Spotify song' : 'YouTube video';
    try {
      var info = await (await fetch(url)).json();
      if (info.title) song.title = info.title;
    } catch (err) {}
    var m = Object.assign({}, room.music);
    var idle = m.index >= m.queue.length;
    m.queue = m.queue.concat([song]);
    if (idle) Object.assign(m, { playing: true, position: 0, at: Date.now() });
    writeMusic(m);
  });

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
