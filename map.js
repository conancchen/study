// Map: Princeton's campus, drawn plain like the university's own map
// (grounds, lawns, paths, roads and buildings from campus.js, with no tiles
// or labels),
// and a pin wherever you and your friends are studying right now. Only places
// from places.js can be pinned, so a turn somewhere typed in by hand shows on
// the board but not here. Drag to move around; + and −, the scroll wheel, a
// trackpad pinch and a double click all zoom. It shows once you're signed in,
// and only loads and draws while its section is unfolded.
(function () {
  var social = window.studySocial;
  if (!social) return;

  var SVG = 'http://www.w3.org/2000/svg';
  // The middle of campus, Nassau Street down to the stadium, in metres
  var HOME = { x: 0, y: -60, width: 1300 };
  var MIN_WIDTH = 120;
  var MAX_WIDTH = 2800;

  var section = document.getElementById('map');
  var box = document.getElementById('friends-map');
  var svg = null;
  var pinsEl = null;
  var card = null;
  var view = null;  // { x, y, width }: the middle of the view, and how many metres across it is
  var loading = null;
  var framed = false;  // whether the view has been brought to the pins since opening

  function load() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var js = document.createElement('script');
      js.src = './campus.js';
      js.onload = resolve;
      js.onerror = function () { loading = null; reject(); };
      document.head.appendChild(js);
    });
    return loading;
  }

  // Metres from the campus origin, for a [lat, lon]
  function project(spot) {
    var c = window.STUDY_CAMPUS;
    return { x: (spot[1] - c.origin[1]) * c.metres[0], y: (c.origin[0] - spot[0]) * c.metres[1] };
  }

  function build() {
    svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('aria-hidden', 'true');
    ['grounds', 'green', 'wood', 'field', 'water', 'parking', 'path', 'drive', 'road', 'building'].forEach(function (layer) {
      var path = document.createElementNS(SVG, 'path');
      path.setAttribute('class', 'map-' + layer);
      path.setAttribute('d', window.STUDY_CAMPUS.layers[layer]);
      svg.appendChild(path);
    });
    pinsEl = document.createElement('div');
    pinsEl.className = 'map-pins';
    card = document.createElement('div');
    card.className = 'map-card';
    card.hidden = true;

    var zoom = document.createElement('div');
    zoom.className = 'map-zoom';
    [['+', 'Zoom in', 0.6], ['−', 'Zoom out', 1 / 0.6]].forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b[0];
      btn.setAttribute('aria-label', b[1]);
      btn.onclick = function () { zoomBy(b[2]); };
      zoom.appendChild(btn);
    });

    box.appendChild(svg);
    box.appendChild(pinsEl);
    box.appendChild(card);
    box.appendChild(zoom);
    interact();
  }

  function draw() {
    var w = box.clientWidth, h = box.clientHeight;
    if (!w || !view) return;
    var height = view.width * h / w;
    svg.setAttribute('viewBox', [view.x - view.width / 2, view.y - height / 2, view.width, height].join(' '));
    pinsEl.querySelectorAll('.map-pin').forEach(function (pin) {
      pin.style.left = (pin.dataset.x - view.x) / view.width * w + w / 2 + 'px';
      pin.style.top = (pin.dataset.y - view.y) / height * h + h / 2 + 'px';
    });
  }

  // Zooms by factor (under 1 is in), keeping the spot at (px, py) in the box
  // where it is; with no spot, around the middle
  function zoomBy(factor, px, py) {
    var w = box.clientWidth, h = box.clientHeight;
    if (px === undefined) { px = w / 2; py = h / 2; }
    var width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, view.width * factor));
    var shift = (view.width - width) / w;
    view.x += (px - w / 2) * shift;
    view.y += (py - h / 2) * shift;
    view.width = width;
    draw();
  }

  function interact() {
    // Dragging pans; two fingers on a touch screen pinch to zoom
    var touches = {};
    var last = null;
    function spread() {
      var p = Object.keys(touches).map(function (k) { return touches[k]; });
      return p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : null;
    }
    box.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, .map-card')) return;
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      last = spread();
      box.setPointerCapture(e.pointerId);
      box.classList.add('map-dragging');
    });
    box.addEventListener('pointermove', function (e) {
      var was = touches[e.pointerId];
      if (!was) return;
      var count = Object.keys(touches).length;
      touches[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (count === 1) {
        var k = view.width / box.clientWidth;
        view.x -= (e.clientX - was.x) * k;
        view.y -= (e.clientY - was.y) * k;
        draw();
      } else if (count === 2) {
        var now = spread();
        var r = box.getBoundingClientRect();
        if (last && now) zoomBy(last / now, e.clientX - r.left, e.clientY - r.top);
        last = now;
      }
    });
    function end(e) {
      delete touches[e.pointerId];
      last = spread();
      if (!Object.keys(touches).length) box.classList.remove('map-dragging');
    }
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);

    box.addEventListener('dblclick', function (e) {
      if (e.target.closest('button, .map-card')) return;
      var r = box.getBoundingClientRect();
      zoomBy(0.5, e.clientX - r.left, e.clientY - r.top);
    });
    // The wheel (and a trackpad pinch, which arrives as a wheel with ctrl held)
    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = box.getBoundingClientRect();
      zoomBy(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    box.addEventListener('click', function (e) {
      if (!e.target.closest('.map-pin, .map-card')) card.hidden = true;
    });
  }

  function showing() {
    return !section.hidden && !section.classList.contains('collapsed');
  }

  function open() {
    if (!showing()) return;
    load().then(function () {
      if (!svg) build();
      view = Object.assign({}, HOME);
      framed = false;
      card.hidden = true;
      pins();
    }, function () {
      toast('Couldn\'t load the map');
    });
  }

  // One pin per place, labeled with everyone there; clicking it says what
  // each of them is doing
  function pins() {
    if (!svg || !showing()) return;
    pinsEl.innerHTML = '';
    var me = social.me();
    if (!me) return;
    var statuses = social.statuses();
    var at = {};
    social.friends().forEach(function (row) {
      var st = statuses[row.id];
      if (!social.active(st) || !st.place || !window.STUDY_PLACES[st.place]) return;
      (at[st.place] = at[st.place] || []).push({ name: row.id === me.id ? 'You' : row.display_name.split(' ')[0], st: st });
    });
    var spots = [];
    Object.keys(at).forEach(function (place) {
      var people = at[place];
      var spot = project(window.STUDY_PLACES[place]);
      spots.push(spot);
      var pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'map-pin' + (people.some(function (p) { return p.st.kind === 'study'; }) ? '' : ' map-pin-break');
      pin.dataset.x = spot.x;
      pin.dataset.y = spot.y;
      var label = document.createElement('span');
      label.className = 'map-label';
      label.textContent = people.map(function (p) { return p.name; }).join(', ');
      pin.appendChild(label);
      pin.setAttribute('aria-label', label.textContent + ' at ' + place);
      pin.onclick = function () { show(place, people); };
      pinsEl.appendChild(pin);
    });

    // The first pins since opening bring the view to them; after that it's
    // left where it was put
    if (spots.length && !framed) {
      framed = true;
      var xs = spots.map(function (s) { return s.x; });
      var ys = spots.map(function (s) { return s.y; });
      var aspect = box.clientWidth / box.clientHeight || 1;
      view = {
        x: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2,
        y: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2,
        width: Math.min(MAX_WIDTH, Math.max(700,
          (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * 1.6,
          (Math.max.apply(null, ys) - Math.min.apply(null, ys)) * 1.6 * aspect))
      };
    }
    draw();
  }

  function show(place, people) {
    card.innerHTML = '';
    var title = document.createElement('strong');
    title.textContent = place;
    card.appendChild(title);
    people.forEach(function (p) {
      var line = document.createElement('div');
      line.textContent = p.name + ' · ' + social.describe(Object.assign({}, p.st, { place: null }));
      card.appendChild(line);
    });
    card.hidden = false;
  }

  document.addEventListener('study:signed-in', function () {
    section.hidden = false;
    open();
  });
  document.addEventListener('study:signed-out', function () {
    section.hidden = true;
  });
  section.addEventListener('study:fold', function (e) {
    if (!e.detail.collapsed) open();
  });

  // Pins move as statuses change and as the board reloads
  document.addEventListener('study:status', pins);
  document.addEventListener('study:friends', pins);
  window.addEventListener('resize', draw);
})();
