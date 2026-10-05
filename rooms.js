// Rooms: study together with friends. A room has a short code and a link;
// anyone signed in who has either can join. Inside, everyone in the room is
// listed with what their own timer is doing, live, and the room plays music
// from a shared queue of YouTube and Spotify links that stays in step for everyone: any
// member can add a song, play, pause or skip, and the change reaches the
// others at once. It runs on the same sign-in and statuses as Friends
// (friends.js), which tells it who is where.
//
// Spotify plays through its embed player: whole songs for anyone signed into
// Spotify in that browser, and 30-second previews for anyone who isn't. A
// Spotify playlist or album goes in the queue as one item that plays through
// on its own (only play and pause are shared, since each listener's player
// keeps its own place in it). Spotify Jams can't be embedded, so the room's
// own queue stands in for one.
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
  var shuffleBtn = document.getElementById('music-shuffle');
  var sizeBtn = document.getElementById('music-size');
  var BIG_KEY = 'study-player-big';
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

  // What a pasted link is: a Spotify track, episode, playlist, album or show
  // (a link or a spotify: uri), or a YouTube video (any usual link, or a
  // bare id)
  function parseLink(text) {
    text = text.trim();
    var sp = text.match(/(?:open\.spotify\.com\/(?:intl-[\w-]+\/)?|spotify:)(track|episode|playlist|album|show)[\/:]([A-Za-z0-9]{22})/);
    if (sp) {
      var song = { source: 'spotify', id: 'spotify:' + sp[1] + ':' + sp[2] };
      if (!/track|episode/.test(sp[1])) song.kind = sp[1];
      return song;
    }
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

  // A playlist, album or show: it plays through by itself, with no one place
  // to keep everyone at
  function collection(song) {
    return !!(song && song.kind);
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
        toast(res.error.message);
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

  // A new room starts with a default name; click the name to change it
  document.getElementById('room-new').addEventListener('click', async function () {
    var me = social.me();
    var name = me.display_name.split(' ')[0] + '\'s room';
    if (PREVIEW) { enter(name); return; }
    var res = await db.from('rooms').insert({ name: name }).select().single();
    if (res.error) { toast(res.error.message); return; }
    enter(res.data.code);
  });

  document.getElementById('room-join').addEventListener('click', function () {
    askInline(this.parentNode, 'Room code', function (code) { enter(code.toLowerCase()); });
  });

  // The room's name is edited in place, like a turn's: click and type, then
  // Enter or click away to save (Escape backs out). Anyone in it can rename it.
  nameEl.contentEditable = 'plaintext-only';
  nameEl.spellcheck = false;
  nameEl.title = 'Rename';
  nameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    else if (e.key === 'Escape') { nameEl.textContent = room.name; nameEl.blur(); }
  });
  nameEl.addEventListener('blur', async function () {
    if (!room) return;
    var name = nameEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
    nameEl.textContent = name || room.name;
    if (!name || name === room.name) return;
    room.name = name;
    window.studyRoom = { id: room.id, name: room.name, code: room.code };
    social.pushStatus();
    if (PREVIEW) return;
    var res = await db.from('rooms').update({ name: name }).eq('id', room.id);
    if (res.error) toast(res.error.message);
  });

  document.getElementById('room-leave').addEventListener('click', leave);

  document.getElementById('room-copy').addEventListener('click', function () {
    var link = location.origin + location.pathname + '?room=' + room.code;
    copyText(link).then(function () { toast('Room link copied · code ' + room.code); });
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
    if (document.activeElement !== nameEl) nameEl.textContent = room.name;
    window.studyRoom = { id: room.id, name: room.name, code: room.code };
    renderMembers();
    renderMusic();
    applyMusic();
  }

  /* Music */

  function renderMusic() {
    var m = room.music;
    var song = current();
    // The player shows what's on; this only speaks up when nothing is
    nowEl.textContent = 'Nothing playing';
    nowEl.hidden = !!song;
    playBtn.textContent = m.playing ? 'Pause' : 'Play';
    playBtn.disabled = !song;
    skipBtn.disabled = !song;
    shuffleBtn.disabled = m.queue.length - m.index < 3;  // fewer than two waiting

    queueEl.innerHTML = '';
    m.queue.forEach(function (item, i) {
      if (i <= m.index) return;  // played, or on now (the player shows that)
      var li = document.createElement('li');
      li.className = 'row study-lap' + (i === m.index ? ' music-current' : ' study-lap-break');
      var label = document.createElement('span');
      label.className = 'study-label';
      var name = document.createElement('span');
      name.className = 'study-name';
      name.textContent = item.title;
      label.appendChild(name);
      if (item.kind) {
        var kind = document.createElement('span');
        kind.className = 'study-at';
        kind.textContent = ' · ' + item.kind;
        label.appendChild(kind);
      }
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

    // Spotify's embed drops commands sent while a song is still loading, so a
    // load waits for the song to be ready (or to first report its position)
    // and only then seeks and plays, to wherever the room has got to by then
    spotify: {
      ctl: null, ready: false, loaded: null, state: null, pending: false,
      start: function () {
        var self = this;
        if (self.started) return;
        self.started = true;
        window.onSpotifyIframeApiReady = function (api) {
          api.createController(document.getElementById('room-spotify'), { width: '100%', height: 352 }, function (ctl) {
            self.ctl = ctl;
            self.ready = true;
            ctl.addListener('ready', function () { self.settle(); });
            ctl.addListener('playback_update', function (e) {
              var was = self.state;
              self.state = e.data;
              if (e.data.duration) self.settle();
              if (!e.data.isPaused) unmuteEl.hidden = true;
              // Reaching the end of a whole song moves the room on. A
              // 30-second preview ending doesn't, or listeners who aren't
              // signed into Spotify would cut the song short for everyone.
              var full = e.data.duration > 31000;
              if (full && was && !was.isPaused && !collection(current()) && e.data.position >= e.data.duration - 1500) ended('spotify');
            });
            applyMusic();
          });
        };
        load('https://open.spotify.com/embed/iframe-api/v1');
      },
      load: function (id) {
        this.loaded = id;
        this.state = null;
        this.pending = true;
        this.ctl.loadUri(id);
      },
      // The song just loaded: catch up with the room
      settle: function () {
        if (!this.pending || !room) return;
        this.pending = false;
        var at = expected(room.music);
        if (at > 1 && !collection(current())) this.ctl.seek(Math.floor(at));
        if (room.music.playing) this.ctl.play();
      },
      sync: function (at, playing) {
        if (this.pending) return;  // settle() catches up once it's loaded
        if (this.state && !collection(current()) && Math.abs(this.state.position / 1000 - at) > 3) this.ctl.seek(at);
        if (playing && (!this.state || this.state.isPaused)) this.ctl.resume();
        if (!playing && this.state && !this.state.isPaused) this.ctl.pause();
      },
      stop: function () {
        if (this.loaded) this.ctl.pause();
        this.loaded = null;
        this.pending = false;
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
    sizeBtn.hidden = kind !== 'spotify';
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

  // Mixes up everything waiting to play, for everyone; what's on now carries on
  shuffleBtn.addEventListener('click', function () {
    var m = Object.assign({}, room.music);
    var waiting = m.queue.slice(m.index + 1);
    for (var i = waiting.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = waiting[i]; waiting[i] = waiting[j]; waiting[j] = swap;
    }
    m.queue = m.queue.slice(0, m.index + 1).concat(waiting);
    writeMusic(m);
  });

  // The Spotify player starts at its smaller size and opens up to its
  // larger one; it stays that way next time
  function size(big) {
    spotifyEl.classList.toggle('room-player-big', big);
    sizeBtn.textContent = big ? '· Smaller' : '· Bigger';
  }
  try { size(!!localStorage.getItem(BIG_KEY)); } catch (e) { size(false); }
  sizeBtn.addEventListener('click', function () {
    var big = !spotifyEl.classList.contains('room-player-big');
    size(big);
    try {
      if (big) localStorage.setItem(BIG_KEY, '1');
      else localStorage.removeItem(BIG_KEY);
    } catch (e) {}
  });

  unmuteEl.addEventListener('click', function () {
    unmuteEl.hidden = true;
    var song = current();
    if (song) players[sourceOf(song)].loaded = null;  // loads it afresh, now that sound is allowed
    applyMusic();
  });

  document.getElementById('music-add').addEventListener('submit', async function (e) {
    e.preventDefault();
    // Enter on a search picks the highlighted result
    if (results.length && picked >= 0) { pick(picked); return; }
    var song = parseLink(linkInput.value);
    if (!song) {
      if (/spotify\.link|socialsession/.test(linkInput.value)) toast('Jams can\'t play here; add songs to the queue');
      else if (/^\s*https?:/.test(linkInput.value) || !searchDb) toast('Not a YouTube or Spotify link');
      return;
    }
    linkInput.value = '';
    showResults([]);
    // Titles come from each site's oEmbed, which pages can read directly
    var spotify = song.source === 'spotify';
    var url = spotify
      ? 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/' + song.id.split(':').slice(1).join('/'))
      : 'https://noembed.com/embed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + song.id);
    song.title = spotify ? 'Spotify ' + (song.kind || 'song') : 'YouTube video';
    try {
      var info = await (await fetch(url)).json();
      if (info.title) song.title = info.title;
    } catch (err) {}
    queueSong(song);
  });

  // Adds to the end of the queue, and starts it if nothing was playing
  function queueSong(song) {
    var m = Object.assign({}, room.music);
    var idle = m.index >= m.queue.length;
    m.queue = m.queue.concat([song]);
    if (idle) Object.assign(m, { playing: true, position: 0, at: Date.now() });
    writeMusic(m);
  }

  /* Searching */

  // Typing anything that isn't a link searches Spotify, through the
  // spotify-search function (supabase/functions), and lists what it finds
  // under the box. Click one, or move with the arrows and press Enter, to
  // queue it. Searching works in the preview too, as it needs no sign-in.
  var resultsEl = document.getElementById('music-results');
  var config = window.STUDY_CONFIG || {};
  var searchDb = db || (config.supabaseUrl && config.supabaseAnonKey && window.supabase
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false } })
    : null);
  var results = [];
  var picked = -1;
  var searchTimer;
  var searchSeq = 0;
  var searchWarned = false;

  linkInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    var text = linkInput.value.trim();
    if (!searchDb || text.length < 2 || /^https?:|^spotify:/.test(text)) { showResults([]); return; }
    searchTimer = setTimeout(function () { find(text); }, 250);
  });

  async function find(text) {
    var seq = ++searchSeq;
    var res = await searchDb.functions.invoke('spotify-search', { body: { q: text } });
    if (seq !== searchSeq) return;  // a newer search has gone out since
    var error = res.error || (res.data && res.data.error);
    if (error) {
      console.error(error);
      if (!searchWarned) { searchWarned = true; toast('Song search isn\'t set up yet; paste a link instead'); }
      showResults([]);
      return;
    }
    showResults(res.data.results || []);
  }

  function showResults(list) {
    results = list;
    picked = list.length ? 0 : -1;
    resultsEl.innerHTML = '';
    list.forEach(function (r, i) {
      var li = document.createElement('li');
      li.className = 'music-result';
      if (r.art) {
        var img = document.createElement('img');
        img.src = r.art;
        img.alt = '';
        li.appendChild(img);
      }
      var title = document.createElement('span');
      title.className = 'music-result-title';
      title.textContent = r.title;
      var by = document.createElement('span');
      by.className = 'music-result-by';
      by.textContent = (r.kind ? r.kind + ' · ' : '') + r.by;
      var text = document.createElement('span');
      text.className = 'music-result-text';
      text.appendChild(title);
      text.appendChild(by);
      li.appendChild(text);
      // On press rather than click, so the box losing focus doesn't clear the list first
      li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(i); });
      li.addEventListener('mouseenter', function () { picked = i; mark(); });
      resultsEl.appendChild(li);
    });
    resultsEl.hidden = !list.length;
    mark();
  }

  function mark() {
    Array.prototype.forEach.call(resultsEl.children, function (li, i) {
      li.classList.toggle('picked', i === picked);
    });
  }

  function pick(i) {
    var r = results[i];
    if (!r) return;
    var song = { source: 'spotify', id: r.id, title: r.kind ? r.title : r.title + ' · ' + r.by };
    if (r.kind) song.kind = r.kind;
    linkInput.value = '';
    showResults([]);
    queueSong(song);
  }

  linkInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { showResults([]); return; }
    if (!results.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    mark();
  });
  linkInput.addEventListener('blur', function () { showResults([]); });

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
