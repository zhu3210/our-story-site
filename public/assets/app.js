// 网站前端：地图、相册、视频三个页面，数据来自 data/story.json（由 tools/build.py 生成）。
const $ = (sel, el = document) => el.querySelector(sel);

const state = {
  data: null,
  places: [],
  byId: new Map(),
  map: null,
  mapReady: false,
  markers: new Map(),
  selected: null,
  albumYear: 'all',
  lb: { list: [], i: 0 },
  hls: null,
  enabled: false, // 网站上传功能是否可用（Cloudflare 上配置了 KV 和 D1）
  labelField: null,
  sel: new Set(), // 相册里多选的照片 id
  selAnchor: null,
  albumFlat: [],
};

const DEFAULT_STYLE = 'https://tiles.openfreemap.org/styles/positron';

init();

async function init() {
  try {
    await loadStory();
  } catch (e) {
    if (e.message === 'auth') return;
    $('main').replaceChildren(h('div', { class: 'empty', text: '还没有生成数据：请先运行 npm run build' }));
    return;
  }
  renderHeader();
  initLightbox();
  initPlayer();
  initModal();
  initPhotoMenu();
  const up = $('#upload-btn');
  up.hidden = !state.enabled;
  up.addEventListener('click', () => openUpload(state.selected));
  window.addEventListener('hashchange', route);
  route();
}

// ---------- 数据：电脑上生成的 story.json + 网站上上传的内容 ----------
async function loadStory() {
  const res = await fetch('data/story.json', { cache: 'no-cache' });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('auth');
  }
  const stat = await res.json();
  const dyn = await fetch('api/story', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) || { enabled: false, places: [], photos: [] };
  state.data = stat;
  state.enabled = !!dyn.enabled;
  // 视频：电脑上加的（HLS）+ 网站上传的（MP4）
  state.videos = [
    ...stat.videos.map((v) => ({ ...v, kind: 'hls' })),
    ...(dyn.videos || []).map((v) => ({
      ...v, kind: 'mp4', uploaded: true, src: `vid/${v.id}.mp4`, poster: `vid/${v.id}.jpg`, text: v.text || '',
    })),
  ];
  state.labelField ??= labelField(stat.site.map_language || 'zh');
  state.places = mergePlaces(stat.places, dyn);
  state.byId = new Map(state.places.map((p) => [p.id, p]));
}

const PLACE_KEYS = ['title', 'city', 'country', 'lat', 'lng', 'date', 'end_date', 'text', 'cover', 'kind'];
// 想去的地方：kind = 'wish' 而且还没有照片；一旦有了照片就自动算「去过的地方」
const isWish = (p) => p.kind === 'wish' && !p.photos.length;
const visitedPlaces = () => state.places.filter((p) => !p.wish);
const wishPlaces = () => state.places.filter((p) => p.wish);

function mergePlaces(staticPlaces, dyn) {
  const map = new Map();
  for (const p of staticPlaces) {
    map.set(p.id, { ...p, photos: p.photos.map((ph) => ({ ...ph })), source: 'local', coverSrc: p.cover?.src || null });
  }
  for (const row of dyn.places || []) {
    let p = map.get(row.id);
    if (!p) {
      p = { id: row.id, title: '', city: '', country: '', lat: null, lng: null, zoom: null, date: null, end_date: null, text: '', photos: [], source: 'web', coverSrc: null };
      map.set(row.id, p);
    }
    for (const k of PLACE_KEYS) {
      const v = row[k];
      if (v === null || v === undefined) continue;
      if (k === 'cover') p.coverSrc = v || null;
      else if (v === '' && ['lat', 'lng', 'date', 'end_date'].includes(k)) p[k] = null;
      else p[k] = v;
    }
  }
  for (const ph of dyn.photos || []) {
    const p = map.get(ph.place_id);
    if (!p) continue;
    p.photos.push({
      id: ph.id, src: `img/${ph.id}.jpg`, thumb: `img/${ph.id}_t.jpg`, w: ph.w, h: ph.h,
      taken: ph.taken, caption: ph.caption || '', lat: ph.lat, lng: ph.lng, uploaded: true,
    });
  }
  for (const p of map.values()) {
    p.photos.sort((a, b) => (a.taken || '9999').localeCompare(b.taken || '9999'));
    // 地点在地图上的位置（连线也经过这里）：
    // 只有一张带定位的照片 → 就在这张照片的拍摄地点；否则 → 城市（行政区）中心
    const g = p.photos.filter(hasCoords);
    if (g.length === 1) {
      p.lat = g[0].lat;
      p.lng = g[0].lng;
    } else if (!hasCoords(p) && g.length) {
      p.lat = g.reduce((s, x) => s + x.lat, 0) / g.length;
      p.lng = g.reduce((s, x) => s + x.lng, 0) / g.length;
    }
    // 日期范围 = 地点写的日期 + 所有照片的拍摄日期，取最早到最晚（同一个城市去了好几次也能显示全）
    const days = [p.date, p.end_date, ...p.photos.map((x) => x.taken?.slice(0, 10))]
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort();
    if (days.length) {
      p.date = days[0];
      p.end_date = days.at(-1) !== days[0] ? days.at(-1) : null;
    }
    const c = (p.coverSrc && p.photos.find((x) => x.src === p.coverSrc)) || p.photos[0];
    p.cover = c ? { src: c.src, thumb: c.thumb } : null;
    if (!p.title) p.title = p.city || '未命名的地方';
    p.wish = isWish(p);
  }
  return [...map.values()].sort(byDate);
}

// 上传/修改之后重新读取数据并刷新页面
async function reload(hash) {
  await loadStory();
  rebuildMapData();
  if (hash && location.hash !== hash) location.hash = hash;
  else route();
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 不是 JSON */
  }
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) throw new Error(data.error || `出错了（${res.status}）`);
  return data;
}
const jsonBody = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, Math.max(2600, msg.length * 140));
}

// ---------- 小工具 ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// 和 replaceChildren 一样，但会跳过 null / false（否则会显示成文字 "null"）
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return d ? `${y}年${m}月${d}日` : m ? `${y}年${m}月` : `${y}年`;
}

function fmtRange(a, b) {
  if (!a) return '';
  if (!b || b === a) return fmtDate(a);
  const [y2, m2, d2] = b.split('-').map(Number);
  const tail = String(y2) === a.slice(0, 4) ? (d2 ? `${m2}月${d2}日` : `${m2}月`) : fmtDate(b);
  return `${fmtDate(a)} – ${tail}`;
}

const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
const hasCoords = (p) => p.lat != null && p.lng != null;
const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

function renderHeader() {
  const { site } = state.data;
  document.title = site.title;
  $('#site-title').textContent = site.title;
  const sub = $('#site-sub');
  const daysEl = h('b', { class: 'days' });
  fill(sub,
    site.couple ? h('span', { class: 'couple', text: site.couple }) : null,
    site.start_date ? h('span', { class: 'together', title: `从 ${fmtDate(site.start_date)} 开始` }, '在一起的第 ', daysEl, ' 天') : null,
  );
  if (!site.start_date) return;
  // 按本地日期计算，第一天算第 1 天；页面开着也会在午夜自动翻到新的一天
  const update = () => {
    const [y, m, d] = site.start_date.split('-').map(Number);
    const now = new Date();
    const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) / 86400000) + 1;
    daysEl.textContent = days > 0 ? days.toLocaleString('zh-CN') : '0';
  };
  update();
  setInterval(update, 60 * 1000);
}

// ---------- 路由：#/map、#/map/<地点>、#/album、#/album/<地点>、#/videos ----------
function route() {
  const [, rawView, rawId] = (location.hash || '#/map').split('/');
  const view = ['map', 'album', 'videos'].includes(rawView) ? rawView : 'map';
  const id = rawId ? decodeURIComponent(rawId) : null;
  document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${view}`));
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  closePhotoMenu();
  if (view !== 'album') clearSelection();
  if (view === 'map') showMap(id);
  if (view === 'album') showAlbum(id);
  if (view === 'videos') showVideos();
}

// ---------- 地图 ----------
function ensureMap() {
  if (state.map) return;
  const { site } = state.data;
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [] }, // 真正的风格马上由 setTheme 换上
    center: [110, 30],
    zoom: 1.4,
    attributionControl: false,
    localIdeographFontFamily: CJK_FONT,
  });
  state.map = map;
  window.storyMap = map; // 方便在浏览器控制台里调试
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('style.load', () => {
    try {
      map.setProjection({ type: 'globe' });
    } catch {
      /* 旧浏览器不支持地球模式时退回平面地图 */
    }
    addAtmosphere(map);
    addRouteLine(map);
    clearPhotoMarkers();
    addPhotoSource(map);
    setupCityHover(map);
  });
  map.once('load', () => {
    state.mapReady = true;
    if (!state.selected) fitAll(false);
  });
  // 放大到城市附近时，每张照片显示在它自己的 GPS 位置
  map.on('moveend', updatePhotoMarkers);
  map.on('idle', updatePhotoMarkers); // 新的地图块加载完后再刷新一次
  map.on('sourcedata', (e) => {
    if (e.sourceId === 'photos' && e.isSourceLoaded) updatePhotoMarkers();
  });
  addMarkers(map);
  $('#globe-btn').addEventListener('click', () => go('#/map'));
  document.querySelectorAll('.theme-switch button').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.theme)));
  setTheme(savedTheme()).catch(() => {
    // 风格加载失败时退回原来的底图
    map.setStyle(site.map_style || DEFAULT_STYLE);
  });
  window.addEventListener('resize', debounce(paintStars, 200));
}

const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// 地图镜头避开右侧漂浮面板
function camPadding() {
  const el = state.map.getContainer();
  const panel = $('#panel');
  const desktop = window.innerWidth > 760;
  const side = Math.max(20, Math.min(60, el.clientWidth / 12));
  const right = desktop ? Math.min(panel.offsetWidth + 40, el.clientWidth - side - 160) : side;
  const strip = $('#tl-strip');
  const bottom = side + (strip && !strip.hidden ? Math.min(strip.offsetHeight + 12, el.clientHeight / 3) : 0); // 避开下面的时光轴
  return { top: side, bottom, left: side, right: Math.max(side, right) };
}

// ---------- 星空背景（地球以外的部分） ----------
function paintStars() {
  const space = $('#space');
  const w = space.clientWidth;
  const h = space.clientHeight;
  if (!w || !h || (space.dataset.size === `${w}x${h}`)) return;
  space.dataset.size = `${w}x${h}`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const [still, twinkle] = space.querySelectorAll('canvas');
  const draw = (cv, density, maxR, glow) => {
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const n = Math.round((w * h) / density);
    for (let k = 0; k < n; k++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = Math.random() ** 2.2 * maxR + 0.25;
      const a = 0.35 + Math.random() * 0.65;
      const tint = Math.random();
      const color = tint < 0.15 ? `255,200,220` : tint < 0.3 ? `200,215,255` : `255,250,245`;
      if (glow && r > maxR * 0.45) {
        const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
        g.addColorStop(0, `rgba(${color},${a * 0.5})`);
        g.addColorStop(1, `rgba(${color},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${color},${a})`;
      ctx.fill();
    }
  };
  draw(still, 1800, 1.2, false);
  draw(twinkle, 9000, 1.9, true);
}

function showMap(id) {
  ensureMap();
  state.map.resize();
  paintStars();
  renderStrip();
  if (id && state.byId.has(id)) {
    selectPlace(id);
  } else {
    state.selected = null;
    highlight(null);
    renderPlaceList();
    if (state.mapReady) fitAll(true);
  }
}

function addMarkers(map) {
  for (const p of state.places) {
    if (!hasCoords(p)) continue;
    // 想去的地方：虚线的小爱心标记；去过的地方：照片头像
    const pin = p.wish
      ? h('button', { class: 'marker wish-pin', type: 'button', 'aria-label': `想去：${p.title}` }, h('span', { class: 'ph' }, '♡'))
      : h('button', { class: 'marker', type: 'button', 'aria-label': p.title },
          h('span', { class: 'ring' }),
          h('span', { class: 'ph' }, p.cover ? h('img', { src: p.cover.thumb, alt: '' }) : null));
    const label = h('div', { class: 'mk-label' },
      h('b', { text: p.wish ? `想去 · ${p.city || p.title}` : p.city || p.title }),
      h('span', {
        text: p.wish
          ? (p.city && p.city !== p.title ? p.title : p.country || '')
          : [p.city ? p.title : null, fmtRange(p.date, p.end_date)].filter(Boolean).join(' · '),
      }));
    const wrap = h('div', { class: `mk${p.wish ? ' wish' : ''}` }, pin, label);
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      go(`#/map/${encodeURIComponent(p.id)}`);
    });
    state.markers.set(p.id, new maplibregl.Marker({ element: wrap }).setLngLat([p.lng, p.lat]).addTo(map));
  }
}

// 数据变了之后，重画地图上的标记和连线
function rebuildMapData() {
  if (!state.map) return;
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  addMarkers(state.map);
  const src = state.map.getSource('route');
  if (src) src.setData(routeGeoJSON());
  else if (state.map.isStyleLoaded()) addRouteLine(state.map);
  const ps = state.map.getSource('photos');
  clearPhotoMarkers();
  if (ps) ps.setData(photoGeoJSON());
  else if (state.map.isStyleLoaded()) addPhotoSource(state.map);
}

// ---------- 照片的真实位置：放大后每张照片显示在拍摄地点，靠得近的合成一个带数字的小圆 ----------
// （连线还是连城市中心，这里只是把照片画在它自己的 GPS 位置上）
const PHOTO_MIN_ZOOM = 7;
let photoMarkers = new Map();

function photoGeoJSON() {
  const features = [];
  for (const p of visitedPlaces()) {
    for (const ph of p.photos) {
      if (!hasCoords(ph)) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ph.lng, ph.lat] },
        properties: {
          pid: ph.id || ph.src, place: p.id, thumb: ph.thumb,
          label: [ph.caption, p.title, ph.taken ? fmtDate(ph.taken.slice(0, 10)) : ''].filter(Boolean).join(' · '),
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function addPhotoSource(map) {
  if (map.getSource('photos')) return;
  map.addSource('photos', { type: 'geojson', data: photoGeoJSON(), cluster: true, clusterRadius: 46, clusterMaxZoom: 16 });
  // 看不见的图层：只是为了让地图引擎去计算哪些照片在当前画面里
  map.addLayer({ id: 'photo-points', type: 'circle', source: 'photos', minzoom: PHOTO_MIN_ZOOM, paint: { 'circle-radius': 1, 'circle-opacity': 0 } });
}

function clearPhotoMarkers() {
  for (const m of photoMarkers.values()) m.remove();
  photoMarkers = new Map();
}

function updatePhotoMarkers() {
  const map = state.map;
  if (!map) return;
  const z = map.getZoom();
  // 照片出现后，城市标记变小变淡、退到照片下面，免得挡住照片
  for (const m of state.markers.values()) m.getElement().classList.toggle('dim', z >= PHOTO_MIN_ZOOM);
  const next = new Map();
  if (z >= PHOTO_MIN_ZOOM && map.getSource('photos')) {
    for (const f of map.querySourceFeatures('photos')) {
      const pr = f.properties;
      const key = pr.cluster ? `c${pr.cluster_id}` : `p${pr.pid}`;
      if (next.has(key)) continue;
      const coords = f.geometry.coordinates;
      next.set(key, photoMarkers.get(key)
        || new maplibregl.Marker({ element: pr.cluster ? clusterPin(pr, coords) : photoPin(pr) }).setLngLat(coords));
    }
  }
  for (const [k, m] of photoMarkers) if (!next.has(k)) m.remove();
  for (const [k, m] of next) if (!photoMarkers.has(k)) m.addTo(map);
  photoMarkers = next;
}

function photoPin(pr) {
  const btn = h('button', { class: 'photo-pin', type: 'button', title: pr.label || '' }, h('img', { src: pr.thumb, alt: '' }));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPhotoList([pr], 0);
  });
  return h('div', { class: 'pp' }, btn);
}

function clusterPin(pr, coords) {
  const src = state.map.getSource('photos');
  const img = h('img', { alt: '' });
  const btn = h('button', { class: 'photo-pin cluster', type: 'button', title: `这里有 ${pr.point_count} 张照片，点一下放大` },
    img, h('span', { class: 'cnt', text: pr.point_count_abbreviated }));
  src.getClusterLeaves(pr.cluster_id, 1, 0).then((leaves) => {
    if (leaves[0]) img.src = leaves[0].properties.thumb;
  }).catch(() => {});
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const leaves = await src.getClusterLeaves(pr.cluster_id, 500, 0).catch(() => []);
    const [x0, y0] = leaves[0]?.geometry.coordinates || coords;
    const samePlace = leaves.every((l) => Math.abs(l.geometry.coordinates[0] - x0) < 1e-5 && Math.abs(l.geometry.coordinates[1] - y0) < 1e-5);
    const z = await src.getClusterExpansionZoom(pr.cluster_id).catch(() => 99);
    if (samePlace || z > 19) {
      // 这些照片拍在同一个位置，放大也分不开：直接看这些照片
      openPhotoList(leaves.map((l) => l.properties), 0);
    } else {
      state.map.easeTo({ center: coords, zoom: Math.max(z, state.map.getZoom() + 1) });
    }
  });
  return h('div', { class: 'pp' }, btn);
}

// 从地图上的照片点打开大图：同一个地点的照片可以左右翻
function openPhotoList(props, i) {
  const first = props[i];
  const p = state.byId.get(first?.place);
  if (!p) return;
  const list = (props.length > 1 ? props : p.photos.map((ph) => ({ pid: ph.id || ph.src, place: p.id })))
    .map((x) => {
      const place = state.byId.get(x.place);
      const ph = place?.photos.find((y) => (y.id || y.src) === x.pid);
      return ph ? { ...ph, place } : null;
    })
    .filter(Boolean);
  const start = Math.max(0, list.findIndex((x) => (x.id || x.src) === first.pid));
  openLightbox(list, start);
}

// 「在地图上看」：照片有定位就飞到拍摄的那个点
function showPhotoOnMap(ph) {
  if (hasCoords(ph)) state.focusPhoto = [ph.lng, ph.lat];
  go(`#/map/${encodeURIComponent(ph.place.id)}`);
}

function highlight(id) {
  for (const [pid, m] of state.markers) m.getElement().classList.toggle('active', pid === id);
  markStrip(id);
}

function fitAll(animate) {
  const pts = state.places.filter(hasCoords);
  if (!pts.length) return;
  const map = state.map;
  if (pts.length === 1) {
    map.jumpTo({ center: [pts[0].lng, pts[0].lat], zoom: 3 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  pts.forEach((p) => bounds.extend([p.lng, p.lat]));
  map.fitBounds(bounds, { padding: camPadding(), maxZoom: 5, duration: animate ? 1500 : 0 });
}

function selectPlace(id) {
  const p = state.byId.get(id);
  state.selected = id;
  renderPlaceDetail(p);
  highlight(id);
  if (!hasCoords(p)) return;
  const focus = state.focusPhoto;
  state.focusPhoto = null;
  const opts = { speed: 1.2, curve: 1.6, essential: true, padding: camPadding() };
  const fly = () => {
    // 从照片的「在地图上看」过来：飞到拍摄的那个点
    if (focus) return state.map.flyTo({ ...opts, center: focus, zoom: 15 });
    // 否则把这个城市所有照片的拍摄地点都框进画面
    const gps = p.photos.filter(hasCoords);
    if (gps.length >= 2) {
      const b = new maplibregl.LngLatBounds();
      gps.forEach((x) => b.extend([x.lng, x.lat]));
      return state.map.fitBounds(b, { padding: camPadding(), maxZoom: 13, linear: false, duration: 2200 });
    }
    if (gps.length === 1) return state.map.flyTo({ ...opts, center: [gps[0].lng, gps[0].lat], zoom: 12 });
    return state.map.flyTo({ ...opts, center: [p.lng, p.lat], zoom: p.zoom ?? 10 });
  };
  if (state.mapReady) fly();
  else state.map.once('load', fly);
}

// 地名尽量显示中文（OSM 的中文名常写成「芬兰 / 芬蘭」，只取前半部分）
function labelField(lang) {
  const keys = lang === 'zh' ? ['name:zh-Hans', 'name:zh'] : [`name:${lang}`];
  const n = ['var', 'n'];
  return ['let', 'n', ['to-string', ['coalesce', ...keys.map((k) => ['get', k]), ['get', 'name'], '']],
    ['case', ['>', ['index-of', ' / ', n], 0], ['slice', n, 0, ['index-of', ' / ', n]], n]];
}

// ---------- 地图风格：水彩手绘 / 复古纸地图 ----------
// 水彩：Stamen Watercolor 底图（史密森尼库珀·休伊特博物馆永久保存的版本，可免费使用，需署名），
//      上面叠加我们自己的国界和中文地名。
// 复古：在 OpenFreeMap 的矢量地图上重新配色成米黄旧纸、灰青海洋、砖红道路、深褐色虚线国界。
const THEMES = {
  watercolor: {
    name: '水彩',
    sky: { horizon: '#d3eaf2', fog: '#f4ead9' },
    route: { glow: '#ff8db0', from: '#ffc4d6', mid: '#f06b93', to: '#b8325c' },
    hover: { text: '#b8325c', glow: '#ff7aa2' },
    label: { text: '#3d2f2a', halo: 'rgba(255,250,240,0.88)', water: '#2b5c78' },
  },
  vintage: {
    name: '复古',
    sky: { horizon: '#ead3a4', fog: '#efe2c4' },
    route: { glow: '#d9925e', from: '#d98a4e', mid: '#b4522f', to: '#7a2416' },
    hover: { text: '#8b2e1f', glow: '#e0a060' },
    label: { text: '#4b3621', halo: '#f1e6cc', water: '#2f5f5a' },
  },
};
const THEME_KEY = 'ourstory.mapTheme';
// 水彩瓦片经过我们自己的 Worker 转发（原站不允许跨域），见 src/worker.js 的 proxyWatercolor
const WATERCOLOR_TILES = `${location.origin}/tiles/watercolor/{z}/{x}/{y}.jpg`;
// 中文地名用楷体/宋体，更像手写
const CJK_FONT = "'Kaiti SC','STKaiti','KaiTi','BiauKai','Songti SC','STSong','SimSun',serif";

function savedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (THEMES[t]) return t;
  } catch {
    /* 浏览器不允许存储就用默认 */
  }
  return THEMES[state.data?.site?.map_theme] ? state.data.site.map_theme : 'watercolor';
}

let baseStyleJson = null;
const themeStyleCache = new Map();

async function buildStyle(theme) {
  if (!themeStyleCache.has(theme)) {
    themeStyleCache.set(theme, (async () => {
      baseStyleJson ??= fetch(state.data.site.map_style || DEFAULT_STYLE).then((r) => r.json());
      const s = structuredClone(await baseStyleJson);
      let layers = s.layers;
      if (theme === 'watercolor') {
        s.sources.watercolor = {
          type: 'raster', tiles: [WATERCOLOR_TILES], tileSize: 256, maxzoom: 13,
          attribution: 'Map tiles by <a href="https://stamen.com">Stamen Design</a> (CC BY 3.0), hosted by <a href="https://watercolormaps.collection.cooperhewitt.org/">Cooper Hewitt, Smithsonian Design Museum</a>',
        };
        layers = [
          { id: 'paper', type: 'background', paint: { 'background-color': '#f4ead8' } },
          { id: 'watercolor', type: 'raster', source: 'watercolor', paint: { 'raster-fade-duration': 250 } },
          ...s.layers.filter((l) => /^boundary_(2|disputed)$/.test(l.id) || /^(label_|water_name)/.test(l.id)),
        ];
      }
      s.layers = layers.map((l) => themeLayer(structuredClone(l), theme));
      return s;
    })().catch((e) => {
      themeStyleCache.delete(theme);
      throw e;
    }));
  }
  return structuredClone(await themeStyleCache.get(theme));
}

// 按风格给每个图层换颜色
function themeLayer(l, theme) {
  const t = THEMES[theme];
  const id = l.id;
  l.paint ??= {};
  l.layout ??= {};
  if (l.type === 'symbol') {
    const tf = l.layout['text-field'];
    if (tf && JSON.stringify(tf).includes('name')) l.layout['text-field'] = state.labelField;
    const isWater = /water|ocean|sea|lake|river/.test(id);
    l.paint['text-color'] = isWater ? t.label.water : t.label.text;
    l.paint['text-halo-color'] = t.label.halo;
    l.paint['text-halo-width'] = 1.6;
    l.paint['text-halo-blur'] = 0.8;
    if (theme === 'watercolor' && /^label_(city|town|village|other)/.test(id)) l.layout['text-font'] = ['Noto Sans Italic'];
    return l;
  }
  if (l.type === 'line' && /^boundary/.test(id)) {
    l.paint['line-color'] = theme === 'watercolor' ? '#7a5a48' : '#8b5e3c';
    l.paint['line-dasharray'] = [3, 2];
    l.paint['line-opacity'] = theme === 'watercolor' ? 0.4 : 0.7;
    return l;
  }
  if (theme !== 'vintage') return l;
  const V = {
    background: '#efe2c4', park: '#e2dcb8', water: '#a9c5bd', landcover_ice_shelf: '#f6efdc', landcover_glacier: '#f6efdc',
    landuse_residential: '#e8d7b5', landcover_wood: '#d9d6ae', building: '#e3cfa6', road_area_pier: '#efe2c4', 'aeroway-area': '#e6d4b0',
  };
  if (l.type === 'background') l.paint['background-color'] = V.background;
  else if (l.type === 'fill' && V[id]) {
    l.paint['fill-color'] = V[id];
    if (id === 'building') l.paint['fill-outline-color'] = '#cdb486';
  } else if (l.type === 'line') {
    let c = null;
    if (id === 'waterway') c = '#8fb0a8';
    else if (/motorway.*casing/.test(id)) c = '#9c4a32';
    else if (/motorway/.test(id)) c = '#d07a4f';
    else if (/major_casing/.test(id)) c = '#b98a62';
    else if (/major_inner/.test(id)) c = '#f3e3c0';
    else if (/major_subtle/.test(id)) c = '#c9a67c';
    else if (/minor|path/.test(id)) c = '#d3b88c';
    else if (/dashline/.test(id)) c = '#efe2c4';
    else if (/railway/.test(id)) c = '#8c7356';
    else if (/pier|aeroway|tunnel/.test(id)) c = '#d9c49d';
    if (c) l.paint['line-color'] = c;
  }
  return l;
}

// 地球边缘一圈淡淡的光晕（颜色跟着风格变）
function addAtmosphere(map) {
  const t = THEMES[state.theme];
  try {
    map.setSky({
      'sky-color': 'rgba(0,0,0,0)',
      'horizon-color': t.sky.horizon,
      'fog-color': t.sky.fog,
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.9,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0],
    });
  } catch {
    /* 不支持就算了 */
  }
}

// 切换地图风格（每个人的浏览器会记住自己上次选的）
async function setTheme(theme) {
  if (!THEMES[theme]) return;
  state.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 不能存就算了 */
  }
  document.querySelectorAll('.theme-switch button').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
  $('#view-map').dataset.theme = theme;
  if (state.map) state.map.setStyle(await buildStyle(theme), { diff: false });
}

// 鼠标移到城市名上时，城市发光并放大显示
function setupCityHover(map) {
  const layers = map.getStyle().layers.filter((l) =>
    l.type === 'symbol' && l['source-layer'] === 'place' && !/country|state|continent|ocean|sea/.test(l.id));
  if (!layers.length || map.getLayer('city-hover')) return;
  const ids = layers.map((l) => l.id);
  const { source } = layers[0];
  const font = map.getLayoutProperty(ids[ids.length - 1], 'text-font') || ['Noto Sans Regular'];
  const none = ['==', ['get', 'name'], '\u0000'];
  const hc = THEMES[state.theme]?.hover || THEMES.watercolor.hover;
  map.addLayer({
    id: 'city-glow', type: 'circle', source, 'source-layer': 'place', filter: none,
    paint: { 'circle-radius': 26, 'circle-color': hc.glow, 'circle-opacity': 0.3, 'circle-blur': 0.9, 'circle-translate': [0, -10] },
  });
  map.addLayer({
    id: 'city-hover', type: 'symbol', source, 'source-layer': 'place', filter: none,
    layout: {
      'text-field': state.labelField, 'text-font': font, 'text-size': 17, 'text-anchor': 'bottom', 'text-offset': [0, -0.1],
      'text-allow-overlap': true, 'text-ignore-placement': true,
    },
    paint: { 'text-color': hc.text, 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 },
  });
  // 每次换风格都会重新加图层，但鼠标事件只绑定一次
  state.hoverIds = ids;
  state.hovered = null;
  if (state.hoverBound) return;
  state.hoverBound = true;
  const set = (name) => {
    if (name === state.hovered || !map.getLayer('city-hover')) return;
    state.hovered = name;
    const filter = name ? ['==', ['get', 'name'], name] : none;
    map.setFilter('city-glow', filter);
    map.setFilter('city-hover', filter);
    map.getCanvas().style.cursor = name ? 'pointer' : '';
  };
  map.on('mousemove', (e) => {
    const ids2 = (state.hoverIds || []).filter((x) => map.getLayer(x));
    if (!ids2.length) return;
    const f = map.queryRenderedFeatures(e.point, { layers: ids2 })[0];
    set(f?.properties?.name || null);
  });
  map.on('mouseout', () => set(null));
}

// 按时间顺序把去过的地方用弧线连起来
function addRouteLine(map) {
  if (map.getSource('route')) return;
  map.addSource('route', { type: 'geojson', lineMetrics: true, data: routeGeoJSON() });
  const layout = { 'line-cap': 'round', 'line-join': 'round' };
  const c = THEMES[state.theme]?.route || THEMES.watercolor.route;
  map.addLayer({
    id: 'route-glow', type: 'line', source: 'route', layout,
    paint: { 'line-color': c.glow, 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.45 },
  });
  map.addLayer({
    id: 'route', type: 'line', source: 'route', layout,
    paint: {
      'line-width': 2.4,
      'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, c.from, 0.5, c.mid, 1, c.to],
    },
  });
}

function routeGeoJSON() {
  const pts = visitedPlaces().filter(hasCoords).sort(byDate); // 只连去过的地方
  if (pts.length < 2) return { type: 'FeatureCollection', features: [] };
  const coords = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = greatCircle([pts[i].lng, pts[i].lat], [pts[i + 1].lng, pts[i + 1].lat], 64);
    if (coords.length) seg.shift();
    coords.push(...seg);
  }
  for (let i = 1; i < coords.length; i++) {
    let d = coords[i][0] - coords[i - 1][0];
    while (d > 180) { coords[i][0] -= 360; d -= 360; }
    while (d < -180) { coords[i][0] += 360; d += 360; }
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
}

function greatCircle([lng1, lat1], [lng2, lat2], n) {
  const r = Math.PI / 180;
  const p1 = lat1 * r, l1 = lng1 * r, p2 = lat2 * r, l2 = lng2 * r;
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (d < 1e-6 || Math.abs(d - Math.PI) < 1e-6) return [[lng1, lat1], [lng2, lat2]];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);
    out.push([Math.atan2(y, x) / r, Math.atan2(z, Math.hypot(x, y)) / r]);
  }
  return out;
}

// ---------- 地图右侧面板：去过的地方 / 想去的地方 ----------
function renderPlaceList() {
  const panel = $('#panel');
  const tab = state.panelTab === 'wish' ? 'wish' : 'visited';
  const visited = visitedPlaces().sort((a, b) => byDate(b, a));
  const wishes = wishPlaces().sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  const switchTab = (t) => {
    state.panelTab = t;
    renderPlaceList();
  };
  const tabs = h('div', { class: 'panel-tabs' },
    h('button', { type: 'button', class: tab === 'visited' ? 'active' : null, onclick: () => switchTab('visited') }, `去过 ${visited.length}`),
    h('button', { type: 'button', class: tab === 'wish' ? 'active' : null, onclick: () => switchTab('wish') }, `想去 ${wishes.length}`));

  if (tab === 'wish') {
    const list = h('ul', { class: 'place-list' }, wishes.map((p) =>
      h('li', {},
        h('button', { class: 'place-item', type: 'button', onclick: () => go(`#/map/${encodeURIComponent(p.id)}`) },
          h('span', { class: 'ph wish-ph', 'aria-hidden': 'true' }, '♡'),
          h('div', {},
            h('div', { class: 't', text: p.title }),
            h('div', { class: 'm', text: [[p.city !== p.title ? p.city : null, p.country].filter(Boolean).join(' · '), (p.text || '').split('\n')[0]].filter(Boolean).join('　') }))))));
    fill(panel,
      h('div', { class: 'panel-head' },
        h('h2', { text: '想一起去的地方' }),
        state.enabled ? h('button', { class: 'link-btn', type: 'button', onclick: () => openWishEditor(null) }, '＋ 想去的地方') : null),
      tabs,
      wishes.length
        ? list
        : h('div', { class: 'empty', text: state.enabled ? '还没有想去的地方。点「＋ 想去的地方」，把下一次旅行写下来吧。去过之后上传照片，它会自动变成「去过的地方」。' : '还没有想去的地方。' }),
    );
    panel.scrollTop = 0;
    return;
  }

  const countries = new Set(visited.map((p) => p.country).filter(Boolean));
  const photos = visited.reduce((n, p) => n + p.photos.length, 0);
  const list = h('ul', { class: 'place-list' });
  let year = null;
  for (const p of visited) {
    const y = (p.date || '').slice(0, 4);
    if (y && y !== year) {
      list.append(h('li', { class: 'year-sep', text: `${y} 年` }));
      year = y;
    }
    list.append(h('li', {},
      h('button', { class: 'place-item', type: 'button', onclick: () => go(`#/map/${encodeURIComponent(p.id)}`) },
        p.cover ? h('img', { src: p.cover.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'ph' }),
        h('div', {},
          h('div', { class: 't', text: p.title }),
          h('div', { class: 'm', text: [[p.city, p.country].filter(Boolean).join(' · '), fmtRange(p.date, p.end_date)].filter(Boolean).join('　') })))));
  }
  fill(panel,
    h('div', { class: 'panel-head' },
      h('h2', { text: '我们去过的地方' }),
      state.enabled ? h('button', { class: 'link-btn', type: 'button', onclick: () => openUpload(null, true, true) }, '＋ 新地点') : null),
    tabs,
    h('div', { class: 'stats' }, h('b', { text: visited.length }), ' 个地方 · ', h('b', { text: countries.size }), ' 个国家 · ', h('b', { text: photos }), ' 张照片'),
    visited.length
      ? list
      : h('div', { class: 'empty' },
          state.enabled ? '这里还空着。点「＋ 新地点」或右上角的「＋ 上传」，写下我们的第一个地方吧。' : '还没有地点。',
          state.enabled ? h('div', { style: 'margin-top:16px' }, h('button', { class: 'upload-btn', type: 'button', onclick: () => openUpload(null, true, true) }, '＋ 添加第一个地方')) : null),
  );
  panel.scrollTop = 0;
}

function renderPlaceDetail(p) {
  const panel = $('#panel');
  const paras = (t) => h('div', { class: 'text' }, (t || '').split(/\n\s*\n/).filter((s) => s.trim()).map((s) => h('p', { text: s.trim() })));
  if (p.wish) {
    state.panelTab = 'wish';
    fill(panel,
      h('button', { class: 'back', type: 'button', onclick: () => go('#/map') }, '← 想去的地方'),
      h('div', { class: 'wish-badge', text: '♡ 想一起去' }),
      h('h2', { text: p.title }),
      h('div', { class: 'meta', text: [p.city !== p.title ? p.city : null, p.country].filter(Boolean).join(' · ') }),
      p.text ? paras(p.text) : h('div', { class: 'meta', text: '还没写想在这里做什么。' }),
      state.enabled
        ? h('div', { class: 'panel-actions' },
            h('button', { class: 'link-btn', type: 'button', onclick: () => openUpload(p.id, false, true) }, '去过了！上传照片'),
            h('button', { class: 'link-btn', type: 'button', onclick: () => openWishEditor(p) }, '编辑'))
        : null,
      h('div', { class: 'pos-note', text: '上传在这里拍的照片后，它会自动变成「去过的地方」。' }),
    );
    panel.scrollTop = 0;
    return;
  }
  state.panelTab = 'visited';
  const photos = p.photos.map((ph) => ({ ...ph, place: p }));
  const preview = photos.slice(0, 12);
  const meta = [[p.city, p.country].filter(Boolean).join(' · '), fmtRange(p.date, p.end_date)].filter(Boolean).join('　');
  fill(panel,
    h('button', { class: 'back', type: 'button', onclick: () => go('#/map') }, '← 全部地点'),
    h('h2', { text: p.title }),
    h('div', { class: 'meta', text: meta }),
    state.enabled
      ? h('div', { class: 'panel-actions' },
          h('button', { class: 'link-btn', type: 'button', onclick: () => openUpload(p.id, false, true) }, '＋ 加照片'),
          h('button', { class: 'link-btn', type: 'button', onclick: () => openPlaceEditor(p) }, '编辑'))
      : null,
    h('div', { class: 'text' }, (p.text || '').split(/\n\s*\n/).filter((s) => s.trim()).map((s) => h('p', { text: s.trim() }))),
    preview.length ? h('div', { class: 'thumbs' }, preview.map((ph, i) => photoTile(photos, i))) : null,
    photos.length ? h('button', { class: 'link-btn', type: 'button', onclick: () => go(`#/album/${encodeURIComponent(p.id)}`) }, `在相册里看全部 ${photos.length} 张`) : null,
  );
  panel.scrollTop = 0;
}

// ---------- 时光轴：从在一起那天开始，按时间串起每一次旅行、纪念日和年度视频 ----------
const dayNum = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const addDays = (s, n) => new Date((dayNum(s) + n) * 86400000).toISOString().slice(0, 10);
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 纪念日：在一起第 100、200、300、520、1000、1314… 天，以及每个周年
function milestones(start) {
  if (!start) return [];
  const out = [];
  const special = { 520: '我爱你', 1314: '一生一世' };
  for (const n of [100, 200, 300, 520, 1000, 1314, 1500, 2000, 2500, 3000, 3650, 5000]) {
    out.push({ date: addDays(start, n - 1), label: `在一起第 ${n} 天`, note: special[n] || '' });
  }
  const [y, m, d] = start.split('-');
  const isLeap = (yy) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  for (let k = 1; k <= 60; k++) {
    const yy = +y + k;
    const date = m === '02' && d === '29' && !isLeap(yy) ? `${yy}-02-28` : `${yy}-${m}-${d}`;
    out.push({ date, label: `在一起 ${k} 周年`, note: '' });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// 同一个城市隔了 3 天以上，算另一次旅行
function buildVisits() {
  const visits = [];
  for (const p of visitedPlaces()) {
    const dated = p.photos.filter((ph) => ph.taken).sort((a, b) => a.taken.localeCompare(b.taken));
    const undated = p.photos.filter((ph) => !ph.taken);
    const clusters = [];
    for (const ph of dated) {
      const day = ph.taken.slice(0, 10);
      const last = clusters.at(-1);
      if (last && dayNum(day) - dayNum(last.end) <= 3) {
        last.photos.push(ph);
        last.end = day;
      } else {
        clusters.push({ start: day, end: day, photos: [ph] });
      }
    }
    if (!clusters.length) clusters.push({ start: p.date, end: p.end_date || p.date, photos: [] });
    clusters[0].photos.push(...undated);
    clusters.forEach((c, k) => {
      if (c.start) visits.push({ place: p, start: c.start, end: c.end, photos: c.photos, k, n: clusters.length });
    });
  }
  return visits;
}

// 地图下面的小时光轴：在一起 → 每一次旅行 → 纪念日 → 今天 → 想去的地方，可以左右滑动，点旅行会飞到那个城市
const md = (s) => `${+s.slice(5, 7)}月${+s.slice(8, 10)}日`;

function renderStrip() {
  const el = $('#tl-strip');
  if (!el) return;
  const start = state.data.site.start_date;
  const today = localToday();
  const items = [];
  if (start) items.push({ type: 'start', date: start });
  for (const v of buildVisits()) items.push({ type: 'visit', date: v.start, v });
  for (const m of milestones(start)) if (m.date > start && m.date <= today) items.push({ type: 'mile', date: m.date, m });
  if (start) items.push({ type: 'today', date: today });
  const order = { start: 0, mile: 1, visit: 2, today: 3 };
  items.sort((a, b) => a.date.localeCompare(b.date) || order[a.type] - order[b.type]);
  const wishes = wishPlaces();
  if (!items.length && !wishes.length) {
    el.hidden = true;
    return;
  }

  const nodes = [];
  let year = null;
  const yearTag = (y) => {
    if (y !== year) {
      nodes.push(h('div', { class: 'ts-year', text: y }));
      year = y;
    }
  };
  for (const it of items) {
    yearTag(it.date.slice(0, 4));
    if (it.type === 'start') {
      nodes.push(h('div', { class: 'ts-item ts-heart', title: `${fmtDate(it.date)} · 我们在一起了` },
        h('span', { class: 'ts-dot', text: '♥' }), h('span', { class: 'ts-name', text: '在一起' }), h('span', { class: 'ts-date', text: md(it.date) })));
    } else if (it.type === 'today') {
      const n = dayNum(today) - dayNum(start) + 1;
      const next = milestones(start).find((m) => m.date > today);
      nodes.push(h('div', {
        class: 'ts-item ts-today',
        title: next ? `下一个纪念日：${next.label}${next.note ? `（${next.note}）` : ''}，${fmtDate(next.date)}，还有 ${dayNum(next.date) - dayNum(today)} 天` : '',
      }, h('span', { class: 'ts-dot', text: '♥' }), h('span', { class: 'ts-name', text: '今天' }), h('span', { class: 'ts-date', text: `第 ${n} 天` })));
    } else if (it.type === 'mile') {
      const short = it.m.label.replace('在一起第 ', '').replace(' 天', '天').replace('在一起 ', '');
      nodes.push(h('div', { class: 'ts-item ts-mile', title: `${fmtDate(it.date)} · ${it.m.label}${it.m.note ? ` · ${it.m.note}` : ''}` },
        h('span', { class: 'ts-dot', text: '♥' }), h('span', { class: 'ts-name', text: short }), h('span', { class: 'ts-date', text: md(it.date) })));
    } else {
      const { v } = it;
      const p = v.place;
      const cover = v.photos[0];
      nodes.push(h('button', {
        class: 'ts-item ts-visit', type: 'button', 'data-place': p.id,
        title: `${p.title} · ${fmtRange(v.start, v.end !== v.start ? v.end : null)}${v.n > 1 ? ` · 第 ${v.k + 1} 次去` : ''}`,
        onclick: () => go(`#/map/${encodeURIComponent(p.id)}`),
      },
      h('span', { class: 'ts-dot' }, cover ? h('img', { src: cover.thumb, alt: '', loading: 'lazy' }) : null),
      h('span', { class: 'ts-name', text: p.title }),
      h('span', { class: 'ts-date', text: md(v.start) })));
    }
  }
  if (wishes.length) {
    nodes.push(h('div', { class: 'ts-year ts-future', text: '想去' }));
    for (const p of wishes) {
      nodes.push(h('button', {
        class: 'ts-item ts-wish', type: 'button', 'data-place': p.id, title: `想一起去：${p.title}`,
        onclick: () => go(`#/map/${encodeURIComponent(p.id)}`),
      }, h('span', { class: 'ts-dot', text: '♡' }), h('span', { class: 'ts-name', text: p.title }), h('span', { class: 'ts-date', text: p.country || '' })));
    }
  }
  el.hidden = false;
  fill(el, h('div', { class: 'ts-track' }, nodes));
  if (!el.dataset.wheel) {
    el.dataset.wheel = '1';
    // 鼠标滚轮上下滚也能左右滑
    el.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
  }
  // 默认停在「今天」附近
  const todayEl = el.querySelector('.ts-today');
  el.scrollLeft = todayEl ? Math.max(0, todayEl.offsetLeft - el.clientWidth + 160) : el.scrollWidth;
  markStrip(state.selected);
}

// 高亮时光轴上当前选中的地点，并把它滚到中间
function markStrip(id) {
  const el = $('#tl-strip');
  if (!el || el.hidden) return;
  let first = null;
  el.querySelectorAll('[data-place]').forEach((b) => {
    const on = b.dataset.place === id;
    b.classList.toggle('active', on);
    if (on && !first) first = b;
  });
  if (first) el.scrollTo({ left: first.offsetLeft - el.clientWidth / 2 + first.offsetWidth / 2, behavior: 'smooth' });
}

// ---------- 相册 ----------
function showAlbum(placeId) {
  const onlyPlace = placeId && state.byId.has(placeId) ? state.byId.get(placeId) : null;
  const bar = $('#album-bar');
  const root = $('#album');
  const places = [...state.places].filter((p) => p.photos.length).sort((a, b) => byDate(b, a));
  const years = [...new Set(places.map((p) => (p.date || '').slice(0, 4)).filter(Boolean))].sort().reverse();

  if (onlyPlace) {
    bar.replaceChildren(
      h('button', { class: 'chip', type: 'button', onclick: () => go('#/album') }, '← 全部照片'),
      h('span', { class: 'chip active', text: onlyPlace.title }),
    );
  } else {
    const chip = (label, value) =>
      h('button', { class: `chip${state.albumYear === value ? ' active' : ''}`, type: 'button', onclick: () => { state.albumYear = value; showAlbum(null); } }, label);
    bar.replaceChildren(chip('全部', 'all'), ...years.map((y) => chip(`${y}`, y)));
  }
  if (state.enabled) {
    const usage = h('div', { class: 'usage' },
      h('span', { class: 'usage-text', text: '正在计算空间…' }),
      h('span', { class: 'usage-bar' }, h('i')),
      h('span', { class: 'usage-sub' }));
    bar.append(h('div', { class: 'bar-right' }, usage,
      h('button', { class: 'upload-btn', type: 'button', onclick: () => openUpload(onlyPlace?.id || null, false, !!onlyPlace) }, '＋ 上传照片')));
    loadUsage(usage);
  }

  const shown = onlyPlace
    ? places.filter((p) => p.id === onlyPlace.id)
    : places.filter((p) => state.albumYear === 'all' || (p.date || '').startsWith(state.albumYear));
  const flat = shown.flatMap((p) => p.photos.map((ph) => ({ ...ph, place: p })));
  state.albumFlat = flat;
  // 照片没了的话（比如刚被删掉），从多选里去掉
  for (const sid of [...state.sel]) if (!flat.some((x) => x.id === sid)) state.sel.delete(sid);

  let index = 0;
  const sections = shown.map((p) =>
    h('section', { class: 'album-section' },
      h('header', {},
        h('h3', { text: p.title }),
        h('span', { class: 'm', text: [p.city, fmtRange(p.date, p.end_date), `${p.photos.length} 张`].filter(Boolean).join(' · ') }),
        hasCoords(p) ? h('button', { class: 'link-btn', type: 'button', onclick: () => go(`#/map/${encodeURIComponent(p.id)}`) }, '在地图上看') : null),
      h('div', { class: 'grid' }, p.photos.map(() => photoTile(flat, index++, { selectable: true })))));

  const empty = h('div', { class: 'empty', text: state.enabled ? '还没有照片。点上面的「＋ 上传照片」开始吧。' : '还没有照片。' });
  const touch = matchMedia('(pointer: coarse)').matches;
  const hint = state.enabled && sections.length
    ? h('div', { class: 'album-hint', text: touch ? '长按照片可以编辑、移动或删除' : '右键点照片可以编辑、移动或删除；按住 Ctrl 点击可以多选，按住 Shift 可以连选' })
    : null;
  fill(root, hint, sections.length ? sections : [empty]);
  updateSelection();
  $('#view-album').scrollTop = 0;
}

// 相册右上角的空间使用情况（网站上传的照片存在 Cloudflare KV，免费 1 GB）
const fmtBytes = (b) =>
  !b ? '0 MB' : b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : b < 1e9 ? `${(b / 1e6).toFixed(b < 1e8 ? 1 : 0)} MB` : `${(b / 1e9).toFixed(2)} GB`;

async function loadUsage(el) {
  try {
    const u = await api('api/usage');
    const pct = (u.bytes / u.limitBytes) * 100;
    const avg = Math.max(300000, u.photos ? u.bytes / u.photos : 450000); // 估算时每张至少按 0.3 MB 算
    const left = Math.max(0, Math.floor((u.limitBytes - u.bytes) / avg));
    el.querySelector('.usage-text').textContent = `已用 ${fmtBytes(u.bytes)} / 1 GB`;
    el.querySelector('.usage-bar i').style.width = `${Math.min(100, u.bytes ? Math.max(pct, 2) : 0)}%`;
    el.querySelector('.usage-sub').textContent = `${u.photos} 张${u.videos ? ` · ${u.videos} 个视频` : ''} · 还能放约 ${left.toLocaleString('zh-CN')} 张`;
    el.title = `网站上传了 ${u.photos} 张照片（${fmtBytes(u.photoBytes)}）${u.videos ? `和 ${u.videos} 个视频（${fmtBytes(u.videoBytes)}）` : ''}，用了免费空间的${pct < 0.1 ? '不到 0.1' : ` ${pct.toFixed(1)}`}%。\n今天已上传 ${u.today} 张照片，每天最多约 ${u.dailyPhotos} 张。`;
    el.classList.toggle('warn', pct > 80);
  } catch {
    el.remove();
  }
}

// ---------- 看大图 ----------
function initLightbox() {
  const lb = $('#lightbox');
  lb.querySelector('.lb-close').addEventListener('click', closeLightbox);
  lb.querySelector('.lb-prev').addEventListener('click', () => stepLightbox(-1));
  lb.querySelector('.lb-next').addEventListener('click', () => stepLightbox(1));
  lb.querySelector('.lb-map').addEventListener('click', () => {
    const ph = state.lb.list[state.lb.i];
    closeLightbox();
    showPhotoOnMap(ph);
  });
  lb.addEventListener('click', (e) => {
    if (e.target === lb || e.target.tagName === 'FIGURE') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#modal').hidden) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    if (!lb.hidden) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
    } else if (!$('#player').hidden && e.key === 'Escape') {
      closePlayer();
    }
  });
  let x0 = null;
  lb.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
    x0 = null;
  });
}

function openLightbox(list, i) {
  state.lb = { list, i };
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  renderLightbox();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
}

function stepLightbox(d) {
  const n = state.lb.list.length;
  state.lb.i = (state.lb.i + d + n) % n;
  renderLightbox();
}

function renderLightbox() {
  const { list, i } = state.lb;
  const ph = list[i];
  const lb = $('#lightbox');
  const img = lb.querySelector('img');
  img.src = ph.src;
  img.alt = ph.caption || ph.place.title;
  const date = ph.taken ? fmtDate(ph.taken.slice(0, 10)) : fmtRange(ph.place.date, ph.place.end_date);
  lb.querySelector('.lb-caption').textContent = ph.caption || ph.place.title;
  lb.querySelector('.lb-meta').textContent = [ph.caption ? ph.place.title : null, date, `${i + 1} / ${list.length}`].filter(Boolean).join(' · ');
  lb.querySelector('.lb-map').hidden = !hasCoords(ph.place);
  lb.querySelector('.lb-prev').hidden = list.length < 2;
  lb.querySelector('.lb-next').hidden = list.length < 2;
  for (const j of [i - 1, i + 1]) if (list[j]) new Image().src = list[j].src;
  renderLightboxActions(ph);
}

// 大图下面的「设为封面 / 写一句话 / 删除」
function renderLightboxActions(ph) {
  const cap = $('#lightbox figcaption');
  cap.querySelector('.lb-actions')?.remove();
  cap.querySelector('.lb-edit')?.remove();
  if (!state.enabled) return;
  const isCover = ph.place.cover?.src === ph.src;
  const actions = h('div', { class: 'lb-actions' },
    h('button', { type: 'button', disabled: isCover, onclick: () => setCover(ph) }, isCover ? '已是封面' : '设为封面'),
    ph.uploaded ? h('button', { type: 'button', onclick: () => editCaption(ph) }, ph.caption ? '改这句话' : '写一句话') : null,
    ph.uploaded ? h('button', { type: 'button', onclick: () => { closeLightbox(); openMoveDialog([ph]); } }, '移到其他地点') : null,
    ph.uploaded ? h('button', { class: 'danger', type: 'button', onclick: () => deletePhotos([ph]) }, '删除') : null);
  cap.append(actions);
}

async function setCover(ph) {
  try {
    await api(`api/places/${encodeURIComponent(ph.place.id)}`, jsonBody('PUT', { cover: ph.src }));
    closeLightbox();
    await reload();
    toast('已设为封面');
  } catch (e) {
    toast(e.message);
  }
}

function editCaption(ph) {
  const cap = $('#lightbox figcaption');
  cap.querySelector('.lb-actions')?.remove();
  const input = h('input', { type: 'text', maxlength: 200, placeholder: '给这张照片写一句话' });
  input.value = ph.caption || '';
  const save = async () => {
    try {
      await api(`api/photos/${ph.id}`, jsonBody('PUT', { caption: input.value }));
      ph.caption = input.value.trim();
      renderLightbox();
      reload().catch(() => {});
    } catch (e) {
      toast(e.message);
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') renderLightbox();
  });
  cap.append(h('div', { class: 'lb-edit' }, input,
    h('button', { class: 'lb-map', type: 'button', onclick: save }, '保存'),
    h('button', { class: 'lb-map', type: 'button', onclick: () => renderLightbox() }, '取消')));
  input.focus();
}

// ---------- 照片右键菜单（手机上长按） ----------
function initPhotoMenu() {
  const menu = $('#ctx-menu');
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) closePhotoMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!menu.hidden) closePhotoMenu();
    else if (state.sel.size && $('#modal').hidden && $('#lightbox').hidden) clearSelection();
  });
  window.addEventListener('resize', closePhotoMenu);
  document.addEventListener('scroll', closePhotoMenu, true);
}

function closePhotoMenu() {
  const menu = $('#ctx-menu');
  if (menu) menu.hidden = true;
}

// 相册和地点面板里的照片小格子：点击看大图，右键 / 长按出菜单，Ctrl / Shift 多选
function photoTile(list, i, { selectable = false } = {}) {
  const ph = list[i];
  const el = h('button', { type: 'button', class: 'tile', 'data-id': ph.id || null, 'aria-label': ph.caption || ph.place.title },
    h('img', { src: ph.thumb, alt: '', loading: 'lazy', width: 300, height: 300, draggable: 'false' }),
    selectable ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null);
  if (selectable && ph.id && state.sel.has(ph.id)) el.classList.add('selected');
  let longPressed = false;
  el.addEventListener('click', (e) => {
    if (longPressed) {
      longPressed = false;
      return;
    }
    if (selectable && state.enabled && (e.ctrlKey || e.metaKey || e.shiftKey || state.sel.size)) {
      e.preventDefault();
      if (!ph.uploaded) toast('这张是电脑上加的照片，只能在电脑上移动或删除');
      else selectClick(list, i, e.shiftKey);
      return;
    }
    openLightbox(list, i);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openPhotoMenu(e.clientX, e.clientY, list, i, selectable);
  });
  let timer = null;
  let sx = 0;
  let sy = 0;
  el.addEventListener('touchstart', (e) => {
    longPressed = false;
    const t = e.touches[0];
    sx = t.clientX;
    sy = t.clientY;
    timer = setTimeout(() => {
      longPressed = true;
      openPhotoMenu(sx, sy, list, i, selectable);
    }, 550);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (Math.hypot(t.clientX - sx, t.clientY - sy) > 10) clearTimeout(timer);
  }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(timer));
  el.addEventListener('touchcancel', () => clearTimeout(timer));
  return el;
}

function openPhotoMenu(x, y, list, i, selectable) {
  const ph = list[i];
  const menu = $('#ctx-menu');
  const multi = selectable && ph.uploaded && state.sel.has(ph.id) && state.sel.size > 1;
  const items = [];
  if (multi) {
    const sel = selectedPhotos();
    items.push({ head: `已选 ${sel.length} 张照片` });
    items.push({ label: `移动这 ${sel.length} 张到…`, run: () => openMoveDialog(sel) });
    items.push({ label: `删除这 ${sel.length} 张`, run: () => deletePhotos(sel), cls: 'danger' });
    items.push(null, { label: '取消选择', run: clearSelection });
  } else {
    items.push({ head: [ph.place.title, ph.taken ? fmtDate(ph.taken.slice(0, 10)) : ''].filter(Boolean).join(' · ') });
    items.push({ label: '查看大图', run: () => openLightbox(list, i) });
    if (hasCoords(ph) || hasCoords(ph.place)) items.push({ label: hasCoords(ph) ? '在地图上看拍摄地点' : '在地图上看', run: () => showPhotoOnMap(ph) });
    if (state.enabled) {
      items.push(null);
      if (ph.place.cover?.src !== ph.src) items.push({ label: '设为这个地点的封面', run: () => setCover(ph) });
      if (ph.uploaded) {
        items.push({ label: '编辑说明和拍摄日期…', run: () => openPhotoInfo(ph) });
        items.push({ label: '移到其他地点…', run: () => openMoveDialog([ph]) });
        if (selectable) items.push({ label: state.sel.has(ph.id) ? '取消选择这张' : '选择（之后可以多选）', run: () => selectClick(list, i, false) });
      }
    }
    items.push(null, { label: '下载这张照片', run: () => downloadPhoto(ph) });
    if (state.enabled && ph.uploaded) items.push(null, { label: '删除', run: () => deletePhotos([ph]), cls: 'danger' });
    if (state.enabled && !ph.uploaded) items.push({ note: '这张是电脑上加的照片，移动和删除要在电脑上做' });
  }
  fill(menu, items.map((it) => {
    if (it === null) return h('div', { class: 'sep' });
    if (it.head) return h('div', { class: 'ctx-head', text: it.head });
    if (it.note) return h('div', { class: 'ctx-note', text: it.note });
    return h('button', {
      type: 'button', class: it.cls || null,
      onclick: () => {
        closePhotoMenu();
        it.run();
      },
    }, it.label);
  }));
  menu.hidden = false;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
}

function downloadPhoto(ph) {
  const a = h('a', { href: ph.src, download: `${ph.place.title}${ph.taken ? `-${ph.taken.slice(0, 10)}` : ''}.jpg` });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- 多选 ----------
function selectClick(list, i, range) {
  const ph = list[i];
  if (!ph.uploaded) return;
  if (range && state.selAnchor != null) {
    const [a, b] = [Math.min(state.selAnchor, i), Math.max(state.selAnchor, i)];
    for (let k = a; k <= b; k++) if (list[k]?.uploaded) state.sel.add(list[k].id);
  } else {
    if (state.sel.has(ph.id)) state.sel.delete(ph.id);
    else state.sel.add(ph.id);
    state.selAnchor = i;
  }
  updateSelection();
}

function selectedPhotos() {
  return state.albumFlat.filter((p) => p.uploaded && state.sel.has(p.id));
}

function clearSelection() {
  state.sel.clear();
  state.selAnchor = null;
  updateSelection();
}

function updateSelection() {
  document.querySelectorAll('#album .tile').forEach((t) => t.classList.toggle('selected', state.sel.has(t.dataset.id)));
  const bar = $('#sel-bar');
  if (!bar) return;
  const n = state.sel.size;
  bar.hidden = !n;
  $('#album')?.classList.toggle('selecting', n > 0);
  if (!n) return;
  fill(bar,
    h('span', { class: 'sel-count', text: `已选 ${n} 张` }),
    h('button', { type: 'button', onclick: () => openMoveDialog(selectedPhotos()) }, '移到其他地点'),
    h('button', { type: 'button', class: 'danger', onclick: () => deletePhotos(selectedPhotos()) }, '删除'),
    h('button', { type: 'button', class: 'ghost', onclick: clearSelection }, '取消'));
}

// ---------- 编辑照片信息 ----------
function openPhotoInfo(ph) {
  const cap = h('input', { class: 'field', type: 'text', maxlength: 200, placeholder: '给这张照片写一句话' });
  cap.value = ph.caption || '';
  const date = h('input', { class: 'field', type: 'date' });
  date.value = ph.taken ? ph.taken.slice(0, 10) : '';
  const err = h('div', { class: 'form-err' });
  const save = h('button', { class: 'btn primary', type: 'button' }, '保存');
  save.addEventListener('click', async () => {
    const d = date.value;
    const taken = !d ? '' : ph.taken && ph.taken.slice(0, 10) === d ? ph.taken : `${d}T12:00:00`;
    save.disabled = true;
    try {
      await api(`api/photos/${ph.id}`, jsonBody('PUT', { caption: cap.value, taken }));
      closeModal(true);
      await reload(location.hash);
      toast('已保存');
    } catch (e) {
      err.textContent = e.message;
      save.disabled = false;
    }
  });
  const label = (t, el) => h('label', {}, t, el);
  openModal('编辑照片信息', [
    h('div', { class: 'info-row' },
      h('img', { class: 'info-thumb', src: ph.thumb, alt: '' }),
      h('div', { class: 'info-fields' }, label('说明', cap), label('拍摄日期', date), h('div', { class: 'pos-note', text: `在「${ph.place.title}」` }))),
    err,
  ], [h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消'), save]);
  cap.focus();
}

// ---------- 把照片移到别的地点 ----------
function openMoveDialog(list) {
  const photos = list.filter((p) => p.uploaded);
  if (!photos.length) {
    toast('电脑上加的照片只能在电脑上移动');
    return;
  }
  const fromIds = new Set(photos.map((p) => p.place.id));
  const onlyFrom = fromIds.size === 1 ? [...fromIds][0] : null;
  const places = [...state.places].sort((a, b) => byDate(b, a)).filter((p) => p.id !== onlyFrom);
  const select = h('select', { class: 'field' },
    places.map(placeOption));
  const hasGps = photos.some(hasCoords);
  const radios = {};
  const radio = (key, text) => {
    radios[key] = h('input', { type: 'radio', name: 'move-mode' });
    radios[key].addEventListener('change', () => setMode(key));
    return h('label', {}, radios[key], text);
  };
  const form = placeForm({});
  const existingBox = h('div', {}, select);
  const newBox = h('div', { class: 'new-place' }, form.el);
  const autoBox = h('div', { class: 'pos-note', text: '会根据每张照片自己的定位，放进对应城市的地点（没有就新建）。没有定位的照片不会动。' });
  let mode = 'existing';
  const setMode = (m) => {
    mode = m;
    for (const [k, r] of Object.entries(radios)) r.checked = k === m;
    existingBox.hidden = m !== 'existing';
    newBox.hidden = m !== 'new';
    autoBox.hidden = m !== 'auto';
    if (m === 'new') {
      form.mount();
      form.suggest(photos);
    }
  };
  const modeRow = h('div', { class: 'mode-row' },
    places.length ? radio('existing', '放进已有的地点') : null,
    radio('new', '新建一个地点'),
    hasGps ? radio('auto', '按拍摄位置自动分到城市') : null);
  const previewTiles = photos.slice(0, 24).map((p) => h('div', { class: 'up-tile' }, h('img', { src: p.thumb, alt: '' })));
  if (photos.length > 24) previewTiles.push(h('div', { class: 'up-tile', text: `+${photos.length - 24}` }));
  const err = h('div', { class: 'form-err' });
  const status = h('div', { class: 'up-status' });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消');
  const submit = h('button', { class: 'btn primary', type: 'button' }, '移动');

  const move = (ids, placeId) => api('api/photos/move', jsonBody('POST', { ids, place_id: placeId }));
  submit.addEventListener('click', async () => {
    err.textContent = '';
    let v = null;
    if (mode === 'new') {
      v = form.values();
      if (!v.title) {
        err.textContent = '请填写地点的名字（或者在地图上点一下，会自动识别）';
        return;
      }
      if (v.lat == null) {
        err.textContent = '请在地图上点一下，选择这个地方的位置';
        return;
      }
    }
    modal.busy = true;
    submit.disabled = true;
    cancel.disabled = true;
    try {
      let goId = null;
      let moved = 0;
      if (mode === 'existing') {
        goId = select.value;
        moved = (await move(photos.map((p) => p.id), goId)).moved;
      } else if (mode === 'new') {
        const same = findCityPlace(v.city || v.title, v.country);
        goId = same ? same.id : (await api('api/places', jsonBody('POST', v))).id;
        moved = (await move(photos.map((p) => p.id), goId)).moved;
      } else {
        // 按每张照片的定位分到城市
        const groups = new Map();
        const located = photos.filter(hasCoords);
        let k = 0;
        for (const p of located) {
          status.textContent = `正在识别拍摄城市 ${++k} / ${located.length} …`;
          const r = await reverseGeocode(p.lat, p.lng).catch(() => null);
          if (!r?.city) continue;
          const key = `${normCity(r.city)}|${normCity(r.country)}`;
          if (!groups.has(key)) groups.set(key, { ...r, photos: [] });
          groups.get(key).photos.push(p);
        }
        for (const g of groups.values()) {
          status.textContent = `正在移到「${g.city}」…`;
          let target = findCityPlace(g.city, g.country)?.id;
          if (!target) {
            const days = g.photos.map((x) => x.taken).filter(Boolean).map((t) => t.slice(0, 10)).sort();
            target = (await api('api/places', jsonBody('POST', {
              title: g.city, city: g.city, country: g.country,
              lat: g.center?.[1] ?? g.photos[0].lat, lng: g.center?.[0] ?? g.photos[0].lng,
              date: days[0] || '', end_date: days.length > 1 && days.at(-1) !== days[0] ? days.at(-1) : '',
            }))).id;
          }
          const ids = g.photos.filter((p) => p.place.id !== target).map((p) => p.id);
          if (ids.length) moved += (await move(ids, target)).moved;
          goId = groups.size === 1 ? target : null;
        }
      }
      modal.busy = false;
      closeModal(true);
      await afterPhotosChanged(fromIds,
        location.hash.startsWith('#/album') ? location.hash : goId ? `#/map/${encodeURIComponent(goId)}` : location.hash,
        moved ? `已移动 ${moved} 张照片` : '照片已经在对应的地点里了');
    } catch (e) {
      modal.busy = false;
      submit.disabled = false;
      cancel.disabled = false;
      status.textContent = '';
      err.textContent = e.message;
    }
  });

  openModal(photos.length > 1 ? `移动 ${photos.length} 张照片` : '把照片移到其他地点', [
    h('div', { class: 'up-grid' }, previewTiles),
    h('h3', { text: '移到哪里' }), modeRow, existingBox, newBox, autoBox, status, err,
  ], [cancel, submit]);
  setMode(places.length ? 'existing' : 'new');
}

// ---------- 删除照片 ----------
async function deletePhotos(list) {
  const photos = list.filter((p) => p.uploaded);
  if (!photos.length) return;
  const ask = photos.length > 1 ? `确定删除这 ${photos.length} 张照片吗？删除后无法恢复。` : '确定删除这张照片吗？删除后无法恢复。';
  if (!confirm(ask)) return;
  closeLightbox();
  const fromIds = new Set(photos.map((p) => p.place.id));
  let done = 0;
  let msg;
  try {
    for (const p of photos) {
      await api(`api/photos/${p.id}`, { method: 'DELETE' });
      done++;
    }
    msg = done > 1 ? `已删除 ${done} 张照片` : '照片已删除';
  } catch (e) {
    msg = `${e.message}（已删除 ${done} 张）`;
  }
  await afterPhotosChanged(fromIds, location.hash, msg);
}

// 照片移走或删掉之后：清空多选。原来的地点如果空了，服务器会自动删掉；
// 只有写过经历文字的空地点会问一下（免得文字被悄悄删掉）
async function afterPhotosChanged(fromIds, hash, msg = '') {
  clearSelection();
  const names = new Map([...fromIds].map((id) => [id, state.byId.get(id)?.title]));
  await loadStory();
  const removed = [...fromIds].filter((id) => !state.byId.has(id)).map((id) => names.get(id)).filter(Boolean);
  const withText = [...fromIds].map((id) => state.byId.get(id)).filter((p) => p && p.source === 'web' && !p.photos.length && p.text);
  if (withText.length && confirm(`「${withText.map((p) => p.title).join('」「')}」已经没有照片了，但写过经历文字。要把${withText.length > 1 ? '这些地点' : '这个地点'}和文字一起删掉吗？`)) {
    for (const p of withText) {
      await api(`api/places/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).then(() => removed.push(p.title)).catch(() => {});
    }
  }
  const parts = [msg, removed.length ? `「${removed.join('」「')}」没有照片了，已自动删除` : ''].filter(Boolean);
  if (parts.length) toast(parts.join('；'));
  await reload(hash);
}

// ---------- 视频 ----------
const fmtDuration = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

function showVideos() {
  const root = $('#videos');
  const vids = [...state.videos].sort((a, b) => String(b.year).localeCompare(String(a.year)));
  const bar = state.enabled
    ? h('div', { class: 'videos-bar' },
        h('span', { class: 'videos-count', text: vids.length ? `${vids.length} 个视频` : '' }),
        h('button', { class: 'upload-btn', type: 'button', onclick: () => openVideoUpload() }, '＋ 上传视频'))
    : null;
  if (!vids.length) {
    fill(root, bar, h('div', { class: 'empty', text: state.enabled ? '还没有视频。点右上角的「＋ 上传视频」，放上我们的第一个恋爱视频吧。' : '还没有视频。' }));
    return;
  }
  fill(root, bar, ...vids.map((v) =>
    h('div', { class: 'video-card', role: 'button', tabindex: 0, onclick: () => openPlayer(v), onkeydown: (e) => { if (e.key === 'Enter') openPlayer(v); } },
      h('div', { class: 'poster' },
        v.poster ? h('img', { src: v.poster, alt: '', loading: 'lazy' }) : null,
        h('span', { class: 'play', 'aria-hidden': 'true' }, '▶︎'),
        v.duration ? h('span', { class: 'dur', text: fmtDuration(v.duration) }) : null),
      h('div', { class: 'body' },
        h('div', { class: 'year', text: v.year }),
        h('div', { class: 'title', text: v.title }),
        v.text ? h('div', { class: 'desc', text: v.text }) : null,
        v.uploaded && state.enabled
          ? h('div', { class: 'card-actions' },
              h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); openVideoEditor(v); } }, '编辑'),
              h('button', { class: 'danger', type: 'button', onclick: (e) => { e.stopPropagation(); deleteVideo(v); } }, '删除'))
          : null))));
}

function initPlayer() {
  const pl = $('#player');
  pl.querySelector('.lb-close').addEventListener('click', closePlayer);
  pl.addEventListener('click', (e) => {
    if (e.target === pl) closePlayer();
  });
}

function openPlayer(v) {
  const pl = $('#player');
  const video = pl.querySelector('video');
  pl.querySelector('.player-title').textContent = `${v.year} · ${v.title}`;
  pl.hidden = false;
  document.body.style.overflow = 'hidden';
  video.poster = v.poster || '';
  if (v.kind === 'mp4') {
    video.src = v.src; // 网站上传的视频是普通 MP4，浏览器直接播放
  } else if (window.Hls && Hls.isSupported()) {
    state.hls = new Hls();
    state.hls.loadSource(v.src);
    state.hls.attachMedia(video);
  } else {
    video.src = v.src; // iPhone 等原生支持 HLS 的浏览器
  }
  video.play().catch(() => {});
}

function closePlayer() {
  const pl = $('#player');
  const video = pl.querySelector('video');
  video.pause();
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  video.removeAttribute('src');
  video.load();
  pl.hidden = true;
  document.body.style.overflow = '';
}

// ---------- 弹窗 ----------
const modal = { busy: false, cleanups: [] };

function initModal() {
  const m = $('#modal');
  m.querySelector('.modal-close').addEventListener('click', () => closeModal());
  m.addEventListener('mousedown', (e) => {
    if (e.target === m) closeModal();
  });
}

function openModal(title, body, foot) {
  closeModal(true);
  const m = $('#modal');
  m.querySelector('.modal-title').textContent = title;
  fill(m.querySelector('.modal-body'), body);
  fill(m.querySelector('.modal-foot'), foot);
  m.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal(force = false) {
  if (modal.busy && force !== true) return; // 上传中不能关
  for (const fn of modal.cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* 忽略 */
    }
  }
  const m = $('#modal');
  m.hidden = true;
  m.querySelector('.modal-body').replaceChildren();
  m.querySelector('.modal-foot').replaceChildren();
  document.body.style.overflow = '';
}

// ---------- 根据坐标识别地名（OpenStreetMap Nominatim） ----------
// 使用条款：https://operations.osmfoundation.org/policies/nominatim/
// 要求：全站每秒最多 1 次请求、结果要缓存、不能批量查询。这里坐标先取整到约 1 公里，
// 同一位置只查一次（结果缓存），所有请求排队、两次之间至少间隔 1.1 秒。
// 地点只精确到城市：中国取地级市（比如北京、杭州），国外取城镇（比如巴塞罗那、牛津）。
const geoCache = new Map();
let geoQueue = Promise.resolve();
let geoLast = 0;

// 优先要简体中文名（zh-Hans），否则很多地名会是繁体，比如「凡爾賽」「奧地利」
const GEO_LANG = 'zh-Hans,zh-CN,zh,en';

// 所有 Nominatim 请求排队发，两次之间至少隔 1.1 秒
function nominatimGet(url) {
  const run = async () => {
    const wait = geoLast + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geoLast = Date.now();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('地名服务暂时不可用');
    return res.json();
  };
  const p = geoQueue.then(run, run);
  geoQueue = p.catch(() => {});
  return p;
}

const nominatim = (lat, lng, zoom) => nominatimGet(
  `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=${zoom}&addressdetails=1&accept-language=${GEO_LANG}&lat=${lat}&lon=${lng}`);

// 按名字搜索地点（只在按回车或点「搜索」时查一次，不做边打字边搜——这是 Nominatim 条款要求的）
const searchCache = new Map();
function searchPlaces(q) {
  const key = q.trim().toLowerCase();
  if (!searchCache.has(key)) {
    const p = nominatimGet(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&accept-language=${GEO_LANG}&q=${encodeURIComponent(q.trim())}`)
      .then((list) => list.map((r) => ({
        name: cleanName(r.name || r.display_name.split(',')[0]),
        // 第二行显示「省/州，国家」，去掉邮编
        detail: r.display_name.split(',').slice(1).map((s) => cleanName(s)).filter((s) => s && !/^\d[\d\s-]*$/.test(s)).slice(-3).join('，'),
        lat: Number(r.lat),
        lng: Number(r.lon),
      })));
    searchCache.set(key, p);
    p.catch(() => searchCache.delete(key));
  }
  return searchCache.get(key);
}

const cleanName = (s) => String(s || '').split(/\s*[/;；]\s*/)[0].trim(); // 「法国;法國」「荷兰 / 荷蘭」只取第一个

function reverseGeocode(lat, lng) {
  const la = lat.toFixed(2);
  const ln = lng.toFixed(2);
  const key = `${la},${ln}`;
  if (!geoCache.has(key)) {
    const p = (async () => {
      const d = await nominatim(la, ln, 10);
      const a = d.address || {};
      let city;
      let center = d.lat ? [Number(d.lon), Number(d.lat)] : null;
      if (a.country_code === 'cn') {
        // 中国的「区」「县级市」要再往上查一级，才能拿到地级市
        const up = await nominatim(la, ln, 6);
        city = cleanName(up.address?.city || up.name || a.city);
        if (up.lat) center = [Number(up.lon), Number(up.lat)];
      } else {
        // 国外：优先城镇村庄的名字，实在没有才用郡、州（避免变成「英格兰」这种大区）
        city = cleanName(a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || a.state_district || a.state || d.name);
        if (city.length > 2) city = city.replace(/州$/, ''); // 「维也纳州」→「维也纳」
      }
      if (city.length > 2) city = city.replace(/市$/, '');
      return { city, country: cleanName(a.country), center };
    })();
    geoCache.set(key, p);
    p.catch(() => geoCache.delete(key));
  }
  return geoCache.get(key);
}

// 用城市名找已有的地点（「杭州」和「杭州市」算同一个）
const normCity = (s) => cleanName(s).replace(/市$/, '').toLowerCase();
function findCityPlace(city, country) {
  const k = normCity(city);
  if (!k) return null;
  const c = normCity(country);
  return state.places.find((p) =>
    (normCity(p.city) === k || normCity(p.title) === k) && (!p.country || !c || normCity(p.country) === c)) || null;
}

const distKm = (a, b) => {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};
// 识别不出城市名时的后备：30 公里内最近的已有地点
function nearestPlace(lat, lng) {
  let best = null;
  for (const p of state.places) {
    if (!hasCoords(p)) continue;
    const d = distKm({ lat, lng }, p);
    if (d <= 30 && (!best || d < best.d)) best = { p, d };
  }
  return best ? best.p : null;
}

// ---------- 地点表单（新建、编辑、想去的地方共用） ----------
// opts.wish：想去的地方——不填日期，「经历」改成「想一起做什么」
function placeForm(initial = {}, opts = {}) {
  const field = (tag, attrs, value) => {
    const el = h(tag, { class: 'field', ...attrs });
    if (value != null) el.value = value;
    return el;
  };
  const f = {
    title: field('input', { type: 'text', maxlength: 80, placeholder: '不填就用城市名，也可以写成「塞纳河边散步」' }, initial.title),
    city: field('input', { type: 'text', maxlength: 60, placeholder: '例如：巴黎' }, initial.city),
    country: field('input', { type: 'text', maxlength: 60, placeholder: '例如：法国' }, initial.country),
    date: field('input', { type: 'date' }, initial.date),
    end: field('input', { type: 'date' }, initial.end_date),
    text: field('textarea', {
      maxlength: 8000,
      placeholder: opts.wish ? '想在那里一起做什么？比如：看樱花、坐一次热气球……' : '写下你们在这里的故事……空一行就是新的一段',
    }, initial.text),
  };
  // 按名字搜索地点（回车或点「搜索」）
  const q = field('input', { type: 'search', maxlength: 100, placeholder: opts.wish ? '搜索想去的地方，例如：京都、冰岛、圣托里尼' : '搜索地点，例如：京都、埃菲尔铁塔' });
  const qBtn = h('button', { class: 'btn small', type: 'button' }, '搜索');
  const results = h('div', { class: 'search-results' });
  let pos = hasCoords(initial) ? [initial.lng, initial.lat] : null;
  let picked = !!pos;
  let mini = null;
  let marker = null;
  const note = h('div', { class: 'pos-note' });
  const setNote = (txt, ok) => {
    note.textContent = txt;
    note.classList.toggle('ok', !!ok);
  };
  // 自动识别的地名只填进空着的、或之前也是自动填的格子；你自己打的字不会被覆盖
  const auto = { title: !initial.title, city: !initial.city, country: !initial.country };
  for (const k of Object.keys(auto)) f[k].addEventListener('input', () => { auto[k] = false; });
  let geoSeq = 0;
  const identify = debounce(async (prefix) => {
    if (!pos) return;
    const seq = ++geoSeq;
    setNote(`${prefix}，正在识别是哪里…`, true);
    try {
      const r = await reverseGeocode(pos[1], pos[0]);
      if (seq !== geoSeq) return;
      // 地点只精确到城市：识别出城市后，地点标在城市（行政区）中心，连线也连到这里。
      // 照片自己的拍摄位置另外显示；只有一张照片的地点，网页上会直接显示在那张照片的位置。
      if (r.center) {
        pos = r.center;
        placeMarker(9);
      }
      if (auto.city && r.city) f.city.value = r.city;
      if (auto.country && r.country) f.country.value = r.country;
      if (auto.title && r.city) f.title.value = r.city;
      const where = [r.city, r.country].filter(Boolean).join('，');
      setNote(where ? `${prefix}：${where}（标在城市中心，可以在地图上点击修改）` : `${prefix}（没识别出地名，请自己填写）`, true);
    } catch {
      if (seq === geoSeq) setNote(`${prefix}（地名识别暂时不可用，请自己填写）`, true);
    }
  }, 500);
  setNote(pos ? '位置已设好，可以在地图上点击修改' : '搜索一下，或者在地图上点一下，选择这个地方的位置', !!pos);
  const doSearch = async () => {
    const text = q.value.trim();
    if (!text) return;
    results.textContent = '搜索中…';
    try {
      const list = await searchPlaces(text);
      if (!list.length) {
        results.textContent = '没找到，换个说法试试，或者直接在地图上点。';
        return;
      }
      fill(results, list.map((r) => h('button', {
        type: 'button', class: 'sr',
        onclick: () => {
          pos = [r.lng, r.lat];
          picked = true;
          placeMarker(10);
          results.replaceChildren();
          identify('位置已设好');
        },
      }, h('b', { text: r.name }), h('span', { text: r.detail }))));
    } catch (e) {
      results.textContent = e.message;
    }
  };
  qBtn.addEventListener('click', doSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });
  const mapEl = h('div', { class: 'mini-map' });
  const label = (text, el, full) => h('label', { class: full ? 'full' : null }, text, el);
  const el = h('div', { class: 'form-grid' },
    h('div', { class: 'full' }, h('div', { class: 'form-label', text: '位置 *' }),
      h('div', { class: 'search-row' }, q, qBtn), results, mapEl, note),
    label(opts.wish ? '名字' : '地点名字', f.title, true),
    label('城市', f.city),
    label('国家', f.country),
    opts.wish ? null : label('开始日期', f.date),
    opts.wish ? null : label('结束日期', f.end),
    label(opts.wish ? '想一起做什么' : '我们的经历', f.text, true));

  const placeMarker = (zoom) => {
    if (!mini || !pos) return;
    marker.setLngLat(pos).addTo(mini);
    if (zoom) mini.jumpTo({ center: pos, zoom });
  };
  return {
    el,
    mount() {
      if (mini) return;
      mini = new maplibregl.Map({
        container: mapEl,
        style: { version: 8, sources: {}, layers: [] },
        center: pos || [110, 30],
        zoom: pos ? 9 : 0.8,
        attributionControl: false,
        localIdeographFontFamily: CJK_FONT,
      });
      // 小地图也用和大地图一样的风格
      const m = mini;
      buildStyle(state.theme || savedTheme())
        .then((s) => m.setStyle(s, { diff: false }))
        .catch(() => {
          try {
            m.setStyle(state.data.site.map_style || DEFAULT_STYLE);
          } catch {
            /* 弹窗已经关了 */
          }
        });
      mini.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      marker = new maplibregl.Marker({ color: '#d4567a' });
      placeMarker();
      mini.on('click', (e) => {
        const ll = e.lngLat.wrap();
        pos = [ll.lng, ll.lat];
        picked = true;
        placeMarker();
        identify('位置已设好');
      });
      modal.cleanups.push(() => mini.remove());
    },
    // 根据照片自动填位置和日期（不覆盖手动填写的）
    suggest(items) {
      const gps = items.filter(hasCoords);
      if (!picked && gps.length) {
        const next = [gps.reduce((s, x) => s + x.lng, 0) / gps.length, gps.reduce((s, x) => s + x.lat, 0) / gps.length];
        const moved = !pos || Math.abs(next[0] - pos[0]) > 0.005 || Math.abs(next[1] - pos[1]) > 0.005;
        pos = next;
        placeMarker(9);
        if (moved) identify('已从照片读取位置');
      }
      const days = items.map((x) => x.taken).filter(Boolean).map((t) => t.slice(0, 10)).sort();
      if (days.length && !f.date.value) {
        f.date.value = days[0];
        if (!f.end.value && days.at(-1) !== days[0]) f.end.value = days.at(-1);
      }
    },
    values() {
      return {
        title: f.title.value.trim() || f.city.value.trim(),
        city: f.city.value.trim(),
        country: f.country.value.trim(),
        date: f.date.value || '',
        end_date: f.end.value || '',
        text: f.text.value.trim(),
        lat: pos ? pos[1] : null,
        lng: pos ? pos[0] : null,
      };
    },
  };
}

// ---------- 编辑 / 删除地点 ----------
function openPlaceEditor(p) {
  const form = placeForm(p);
  const err = h('div', { class: 'form-err' });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消');
  const save = h('button', { class: 'btn primary', type: 'button' }, '保存');
  const del = p.source === 'web' ? h('button', { class: 'btn danger', type: 'button' }, '删除这个地点') : null;
  save.addEventListener('click', async () => {
    const v = form.values();
    if (!v.title) {
      err.textContent = '请填写地点的名字';
      return;
    }
    save.disabled = true;
    try {
      await api(`api/places/${encodeURIComponent(p.id)}`, jsonBody('PUT', v));
      // 改成了一个已经存在的城市？问一下要不要合并成一个地点
      const k = normCity(v.city || v.title);
      const dup = state.places.filter((o) => o.id !== p.id && normCity(o.city || o.title) === k
        && (!o.country || !v.country || normCity(o.country) === normCity(v.country)));
      let goId = p.id;
      let merged = false;
      if (dup.length && confirm(`已经有「${dup[0].title}」这个城市了，要把它们合并成一个地点吗？照片和文字都会放到一起。`)) {
        const all = [p, ...dup];
        const target = all.find((x) => x.source === 'local') || [...all].sort(byDate)[0];
        const from = all.filter((x) => x.id !== target.id && x.source === 'web').map((x) => x.id);
        if (from.length) {
          await api(`api/places/${encodeURIComponent(target.id)}/merge`, jsonBody('POST', { from }));
          merged = true;
        }
        goId = target.id;
      }
      closeModal(true);
      await reload(`#/map/${encodeURIComponent(goId)}`);
      toast(merged ? '已合并成一个地点' : '已保存');
    } catch (e) {
      err.textContent = e.message;
      save.disabled = false;
    }
  });
  del?.addEventListener('click', async () => {
    if (!confirm(`确定删除「${p.title}」和里面的 ${p.photos.length} 张照片吗？删除后无法恢复。`)) return;
    try {
      await api(`api/places/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      closeModal(true);
      await reload('#/map');
      toast('地点已删除');
    } catch (e) {
      err.textContent = e.message;
    }
  });
  const note = p.source === 'local'
    ? h('div', { class: 'note', text: '这个地点是在电脑上的 content 文件夹里建的。在这里修改后，网站会显示修改后的内容（电脑上的 place.md 不会跟着变）。' })
    : null;
  openModal('编辑地点', [note, form.el, err], [del, cancel, save]);
  form.mount();
}

// ---------- 想去的地方：添加 / 编辑 / 删除 ----------
function openWishEditor(p) {
  const form = placeForm(p || {}, { wish: true });
  const err = h('div', { class: 'form-err' });
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消');
  const save = h('button', { class: 'btn primary', type: 'button' }, p ? '保存' : '加到想去的地方');
  const del = p ? h('button', { class: 'btn danger', type: 'button' }, '删除') : null;
  save.addEventListener('click', async () => {
    const v = form.values();
    if (v.lat == null) {
      err.textContent = '请搜索一下，或者在地图上点一下，选择位置';
      return;
    }
    if (!v.title) {
      err.textContent = '请写个名字';
      return;
    }
    if (!p) {
      const same = findCityPlace(v.city || v.title, v.country);
      if (same) {
        closeModal(true);
        go(`#/map/${encodeURIComponent(same.id)}`);
        toast(same.wish ? `「${same.title}」已经在想去的地方里了` : `「${same.title}」我们已经去过啦`);
        return;
      }
    }
    save.disabled = true;
    try {
      const body = { ...v, date: '', end_date: '', kind: 'wish' };
      const id = p ? p.id : (await api('api/places', jsonBody('POST', body))).id;
      if (p) await api(`api/places/${encodeURIComponent(p.id)}`, jsonBody('PUT', body));
      closeModal(true);
      state.panelTab = 'wish';
      await reload(`#/map/${encodeURIComponent(id)}`);
      toast(p ? '已保存' : '已加到想去的地方 ♡');
    } catch (e) {
      err.textContent = e.message;
      save.disabled = false;
    }
  });
  del?.addEventListener('click', async () => {
    if (!confirm(`确定把「${p.title}」从想去的地方删掉吗？`)) return;
    try {
      await api(`api/places/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      closeModal(true);
      state.panelTab = 'wish';
      await reload('#/map');
      toast('已删除');
    } catch (e) {
      err.textContent = e.message;
    }
  });
  openModal(p ? '编辑想去的地方' : '添加想去的地方', [form.el, err], [del, cancel, save]);
  form.mount();
}

const placeOption = (p) => h('option', { value: p.id },
  p.wish ? `♡ ${p.title}（想去）` : p.date ? `${p.title}（${fmtDate(p.date)}）` : p.title);

// ---------- 上传照片 ----------
const libs = {};
function loadLib(src, name) {
  libs[name] ??= new Promise((resolve, reject) => {
    if (window[name]) return resolve(window[name]);
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(window[name]);
    s.onerror = () => {
      delete libs[name];
      reject(new Error('组件加载失败，请检查网络后再试'));
    };
    document.head.append(s);
  });
  return libs[name];
}
const isHeic = (f) => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

// 在浏览器里压缩照片（大图最长边 2000px，缩略图 480px），并读出拍摄时间和 GPS
async function processFile(file) {
  let meta = null;
  try {
    const exifr = await loadLib('vendor/exifr-lite.umd.js', 'exifr');
    meta = await exifr.parse(file, { tiff: true, exif: true, gps: true, ifd1: false, interop: false });
  } catch {
    meta = null;
  }
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    if (!isHeic(file)) throw new Error('无法读取这张图片');
    const heic2any = await loadLib('vendor/heic2any.min.js', 'heic2any');
    let out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    if (Array.isArray(out)) out = out[0];
    source = await createImageBitmap(out);
  }
  const big = drawScaled(source, 2000);
  source.close?.();
  const thumb = drawScaled(big, 480);
  const [bigBlob, thumbBlob] = await Promise.all([toJpeg(big, 0.82), toJpeg(thumb, 0.76)]);
  let lat = Number.isFinite(meta?.latitude) ? meta.latitude : null;
  let lng = Number.isFinite(meta?.longitude) ? meta.longitude : null;
  if (lat === 0 && lng === 0) lat = lng = null;
  return {
    name: file.name, big: bigBlob, thumb: thumbBlob, w: big.width, h: big.height,
    taken: localIso(meta?.DateTimeOriginal || meta?.CreateDate), lat, lng, preview: URL.createObjectURL(thumbBlob),
  };
}

function drawScaled(src, max) {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const toJpeg = (canvas, q) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('压缩失败'))), 'image/jpeg', q));

function localIso(d) {
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}` : null;
  }
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 上传照片。默认按照片的 GPS 自动分到各个城市（已有的城市就放进去，没有就新建）；
// 没有定位的照片、或者从某个地点的「加照片」进来时（explicit），统一放进手动选的地点。
function openUpload(presetId = null, startNew = false, explicit = false) {
  const items = [];
  let pending = 0;
  let geoBusy = 0;
  let manual = explicit || startNew;
  let createdPlaceId = null; // 手动新建的地点（上传失败重试时复用）
  const createdByCity = new Map(); // 自动新建的城市地点

  const input = h('input', { type: 'file', accept: 'image/*,.heic,.heif', multiple: true, hidden: true });
  const drop = h('label', { class: 'drop' }, input,
    h('div', { class: 'drop-icon', text: '＋' }),
    h('div', { text: '点击选择照片，或把照片拖到这里' }),
    h('div', { class: 'hint', text: '可以一次选很多张，不同城市的照片也可以一起选；会自动压缩，并按拍摄地点分到各个城市' }));
  const grid = h('div', { class: 'up-grid' });
  const status = h('div', { class: 'up-status' });

  // 手动选择区：已有地点 / 新建地点
  const places = [...state.places].sort((a, b) => byDate(b, a));
  const select = h('select', { class: 'field' },
    places.map(placeOption));
  if (presetId && state.byId.has(presetId)) select.value = presetId;
  const rExisting = h('input', { type: 'radio', name: 'up-mode' });
  const rNew = h('input', { type: 'radio', name: 'up-mode' });
  const form = placeForm({});
  const existingBox = h('div', {}, select);
  const newBox = h('div', { class: 'new-place' }, form.el);
  const manualTitle = h('div', { class: 'manual-title' });
  const looseItems = () => items.filter((it) => !it.done && (manual || !it.geo?.city));
  const setMode = (mode) => {
    rExisting.checked = mode === 'existing';
    rNew.checked = mode === 'new';
    existingBox.hidden = mode !== 'existing';
    newBox.hidden = mode !== 'new';
    if (mode === 'new') {
      form.mount();
      form.suggest(looseItems());
    }
  };
  rExisting.addEventListener('change', () => setMode('existing'));
  rNew.addEventListener('change', () => setMode('new'));
  const modeRow = h('div', { class: 'mode-row' },
    places.length ? h('label', {}, rExisting, '放进已有的地点') : null,
    h('label', {}, rNew, '新建一个地点'));
  const manualBox = h('div', {}, manualTitle, modeRow, existingBox, newBox);

  // 自动分城市的计划
  const planBox = h('div', { class: 'plan' });
  const switchBtn = h('button', { class: 'text-btn', type: 'button' });
  switchBtn.addEventListener('click', () => {
    manual = !manual;
    render();
  });

  const cityGroups = () => {
    const map = new Map();
    for (const it of items) {
      if (it.done || !it.geo?.city) continue;
      const key = `${normCity(it.geo.city)}|${normCity(it.geo.country)}`;
      if (!map.has(key)) map.set(key, { key, city: it.geo.city, country: it.geo.country, center: it.geo.center, items: [] });
      map.get(key).items.push(it);
    }
    for (const g of map.values()) {
      g.target = findCityPlace(g.city, g.country) || (createdByCity.has(g.key) ? { id: createdByCity.get(g.key), title: g.city } : null);
    }
    return [...map.values()];
  };

  const render = () => {
    const groups = manual ? [] : cityGroups();
    const loose = looseItems();
    planBox.hidden = manual || !groups.length;
    fill(planBox, groups.map((g) =>
      h('div', { class: 'plan-row' },
        h('span', { class: 'plan-dot' }),
        h('div', { class: 'plan-city' }, h('b', { text: g.city }), h('span', { text: `${g.country ? `${g.country} · ` : ''}${g.items.length} 张` })),
        h('span', {
          class: `plan-dest${g.target ? '' : ' new'}`,
          text: !g.target ? '新建这个城市' : state.byId.get(g.target.id)?.wish ? `想去的「${g.target.title}」去过啦 ♥` : `放进「${g.target.title}」`,
        }))));
    const showManual = manual || loose.length > 0 || (!groups.length && !geoBusy);
    manualBox.hidden = !showManual;
    manualTitle.textContent = manual ? '全部照片放到：' : groups.length ? `没有定位的 ${loose.length} 张放到：` : '放到：';
    const anyGeo = items.some((it) => !it.done && it.geo?.city);
    switchBtn.hidden = !anyGeo;
    switchBtn.textContent = manual ? '改成按拍摄城市自动分' : '不自动分，全部放进同一个地点';
    if (showManual && rNew.checked) form.suggest(loose);
    refresh();
  };

  const err = h('div', { class: 'form-err' });
  const bar = h('div', { class: 'bar' });
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消');
  const submit = h('button', { class: 'btn primary', type: 'button' }, '开始上传');

  function refresh() {
    const ready = items.filter((it) => !it.done).length;
    const parts = [];
    if (items.length || pending) parts.push(`${ready} 张准备好了`);
    if (pending) parts.push(`还在处理 ${pending} 张…`);
    if (geoBusy) parts.push('正在识别拍摄城市…');
    status.textContent = parts.join('，');
    submit.textContent = ready ? `开始上传 ${ready} 张` : '开始上传';
    submit.disabled = modal.busy || !ready || pending > 0 || geoBusy > 0;
  }

  const locate = (it) => {
    geoBusy++;
    reverseGeocode(it.lat, it.lng)
      .then((r) => { it.geo = r.city ? r : null; })
      .catch(() => {
        // 识别失败：30 公里内有已有地点就放进去
        const near = nearestPlace(it.lat, it.lng);
        it.geo = near ? { city: near.city || near.title, country: near.country, center: [near.lng, near.lat] } : null;
      })
      .finally(() => {
        geoBusy--;
        render();
      });
  };

  const addFiles = async (files) => {
    const list = [...files].filter((f) => f.type.startsWith('image/') || isHeic(f));
    if (!list.length) return;
    err.textContent = '';
    pending += list.length;
    refresh();
    for (const file of list) {
      const tile = h('div', { class: 'up-tile' }, h('span', { class: 'spin' }));
      grid.append(tile);
      try {
        const it = await processFile(file);
        it.tile = tile;
        items.push(it);
        const rm = h('button', {
          class: 'rm', type: 'button', 'aria-label': '移除',
          onclick: (e) => {
            e.preventDefault();
            if (modal.busy || it.done) return;
            items.splice(items.indexOf(it), 1);
            tile.remove();
            URL.revokeObjectURL(it.preview);
            render();
          },
        }, '×');
        fill(tile, h('img', { src: it.preview, alt: '' }), rm, hasCoords(it) ? h('span', { class: 'gps' }, '定位') : null);
        if (hasCoords(it)) locate(it);
      } catch (e) {
        tile.classList.add('bad');
        tile.title = e.message;
        tile.replaceChildren(h('span', { text: '读不了' }));
      }
      pending--;
      render();
    }
  };
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  const span = (list) => {
    const days = list.map((x) => x.taken).filter(Boolean).map((t) => t.slice(0, 10)).sort();
    return { date: days[0] || '', end_date: days.length > 1 && days.at(-1) !== days[0] ? days.at(-1) : '' };
  };
  const avgPos = (list) => {
    const g = list.filter(hasCoords);
    return g.length ? [g.reduce((s, x) => s + x.lng, 0) / g.length, g.reduce((s, x) => s + x.lat, 0) / g.length] : null;
  };

  submit.addEventListener('click', async () => {
    err.textContent = '';
    const groups = manual ? [] : cityGroups();
    const loose = looseItems();
    if (loose.length && rNew.checked && !createdPlaceId) {
      const v = form.values();
      if (!v.title) {
        err.textContent = '请填写地点的名字（或者在地图上点一下，会自动识别）';
        return;
      }
      if (v.lat == null) {
        err.textContent = '请在地图上点一下，选择这个地方的位置';
        return;
      }
    }
    const total = groups.reduce((n, g) => n + g.items.length, 0) + loose.length;
    if (!total) return;
    modal.busy = true;
    cancel.disabled = true;
    progress.hidden = false;
    bar.style.width = '0';
    refresh();
    let done = 0;
    const dests = new Set();
    const wishIds = new Set(wishPlaces().map((p) => p.id)); // 上传前还是「想去」的地点
    const send = async (it, placeId) => {
      status.textContent = `正在上传 ${done + 1} / ${total} …`;
      const fd = new FormData();
      fd.append('place_id', placeId);
      fd.append('image', it.big, 'photo.jpg');
      fd.append('thumb', it.thumb, 'thumb.jpg');
      fd.append('w', it.w);
      fd.append('h', it.h);
      if (it.taken) fd.append('taken', it.taken);
      if (hasCoords(it)) {
        fd.append('lat', it.lat);
        fd.append('lng', it.lng);
      }
      await api('api/photos', { method: 'POST', body: fd });
      it.done = true;
      it.tile.classList.add('done');
      done++;
      dests.add(placeId);
      bar.style.width = `${(done / total) * 100}%`;
    };
    try {
      for (const g of groups) {
        let placeId = g.target?.id;
        if (!placeId) {
          const pos = g.center || avgPos(g.items);
          placeId = (await api('api/places', jsonBody('POST', {
            title: g.city, city: g.city, country: g.country, lat: pos?.[1] ?? null, lng: pos?.[0] ?? null, ...span(g.items),
          }))).id;
          createdByCity.set(g.key, placeId);
        }
        for (const it of g.items) await send(it, placeId);
      }
      if (loose.length) {
        let placeId = rNew.checked ? createdPlaceId : select.value;
        if (rNew.checked && !createdPlaceId) {
          const v = form.values();
          const same = findCityPlace(v.city || v.title, v.country);
          placeId = same ? same.id : (await api('api/places', jsonBody('POST', v))).id;
          createdPlaceId = placeId;
        }
        for (const it of loose) await send(it, placeId);
      }
      modal.busy = false;
      closeModal(true);
      await reload(dests.size === 1 ? `#/map/${encodeURIComponent([...dests][0])}` : '#/map');
      const fulfilled = [...dests].filter((id) => wishIds.has(id)).map((id) => state.byId.get(id)?.title).filter(Boolean);
      toast(`上传好了 ${done} 张${dests.size > 1 ? `，分到了 ${dests.size} 个城市` : ''} ♥`
        + (fulfilled.length ? `　「${fulfilled.join('」「')}」从想去的地方变成了去过的地方！` : ''));
    } catch (e) {
      modal.busy = false;
      cancel.disabled = false;
      err.textContent = `${e.message}${done ? `（已经上传了 ${done} 张，再点一次会继续上传剩下的）` : ''}`;
      // 刚建的地点如果已经被清理掉了，重试时重新建
      if (/不存在/.test(e.message)) {
        createdPlaceId = null;
        createdByCity.clear();
      }
      refresh();
      if (done || createdPlaceId || createdByCity.size) reload().catch(() => {});
    }
  });

  openModal('上传照片', [drop, grid, status, h('h3', { text: '放到哪里' }), planBox, manualBox, switchBtn, err, progress], [cancel, submit]);
  setMode(startNew || !places.length ? 'new' : 'existing');
  render();
  modal.cleanups.push(() => items.forEach((it) => URL.revokeObjectURL(it.preview)));
}

// ---------- 上传视频 ----------
// 先在浏览器里用 mediabunny 压缩成 720p H.264 MP4（约每分钟 15 MB），再切成 5 MB 一段上传。
const VIDEO_BITRATE = 2_000_000;
const AUDIO_BITRATE = 128_000;
const VIDEO_MAX_SIDE = 1280;
let mediabunny = null;
const loadMediabunny = () => (mediabunny ??= import('../vendor/mediabunny.min.mjs').catch((e) => {
  mediabunny = null;
  throw new Error(`视频组件加载失败：${e.message}`);
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readVideoInfo(mb, file) {
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const duration = await input.computeDuration();
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('这个文件里没有视频画面');
    const w = await track.getDisplayWidth();
    const h = await track.getDisplayHeight();
    let tags = {};
    try {
      tags = await input.getMetadataTags();
    } catch {
      /* 没有元数据 */
    }
    const when = [tags.date, tags.creationTime, new Date(file.lastModified)].find((d) => d instanceof Date && !Number.isNaN(d.getTime()));
    return { duration, w, h, year: when ? when.getFullYear() : new Date().getFullYear() };
  } finally {
    input.dispose();
  }
}

async function compressVideo(mb, file, info, onProgress, setCancel) {
  const scale = Math.min(1, VIDEO_MAX_SIDE / Math.max(info.w, info.h));
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const width = even(info.w * scale);
  const height = even(info.h * scale);
  const vq = new mb.Quality({ bitrate: VIDEO_BITRATE });
  if (!(await mb.canEncodeVideo('avc', { width, height, quality: vq }))) throw new Error('UNSUPPORTED');
  const aq = new mb.Quality({ bitrate: AUDIO_BITRATE });
  const audioCodec = (await mb.canEncodeAudio('aac', { quality: aq })) ? 'aac' : 'opus';
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  try {
    const conversion = await mb.Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: { codec: 'avc', width, height, fit: 'contain', quality: vq, forceTranscode: true },
      audio: { codec: audioCodec, quality: aq },
    });
    if (!conversion.isValid) throw new Error('UNSUPPORTED');
    conversion.onProgress = (p) => onProgress(p);
    setCancel(() => conversion.cancel());
    await conversion.execute();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } finally {
    input.dispose();
  }
}

// 用 mediabunny 直接解码一帧做封面（比用 <video> 截图可靠，不会截到黑屏）
async function makePoster(mb, blob, duration) {
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const w = await track.getDisplayWidth();
    const h = await track.getDisplayHeight();
    const s = Math.min(1, 960 / Math.max(w, h));
    const sink = new mb.CanvasSink(track, { width: Math.round(w * s), height: Math.round(h * s), fit: 'contain' });
    const frame = await sink.getCanvas(Math.min(1.5, (duration || 3) / 3)) || await sink.getCanvas(0);
    if (!frame) return null;
    const c = frame.canvas;
    return c.convertToBlob ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 }) : await toJpeg(c, 0.82);
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

// 检查浏览器能不能直接播放这个视频（压缩失败时，决定能不能传原文件）
function grabPoster(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    let settled = false;
    const done = (b) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(b);
    };
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1.5, (v.duration || 3) / 3); });
    v.addEventListener('seeked', () => {
      if (!v.videoWidth) return done(null);
      const s = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * s);
      c.height = Math.round(v.videoHeight * s);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((b) => done(b), 'image/jpeg', 0.82);
    }, { once: true });
    v.addEventListener('error', () => done(null));
    setTimeout(() => done(null), 20000);
    v.src = url;
  });
}

async function uploadVideoBlob(blob, poster, meta, onProgress, isCanceled) {
  const { id, partSize, parts } = await api('api/videos', jsonBody('POST', { ...meta, size: blob.size }));
  try {
    for (let n = 0; n < parts; n++) {
      if (isCanceled()) throw new Error('已取消');
      const part = blob.slice(n * partSize, Math.min((n + 1) * partSize, blob.size));
      for (let tries = 1; ; tries++) {
        try {
          await api(`api/videos/${id}/part/${n}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: part });
          break;
        } catch (e) {
          if (tries >= 3 || isCanceled()) throw e;
          await sleep(1500 * tries); // 网络抖动时重试
        }
      }
      onProgress((n + 1) / parts);
    }
    if (poster) await api(`api/videos/${id}/poster`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: poster });
    await api(`api/videos/${id}/finish`, { method: 'POST' });
    return id;
  } catch (e) {
    api(`api/videos/${id}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

function videoForm(initial = {}) {
  const year = h('input', { class: 'field', type: 'number', min: 1990, max: 2100, step: 1 });
  const title = h('input', { class: 'field', type: 'text', maxlength: 80, placeholder: '例如：我们的第一年' });
  const text = h('textarea', { class: 'field', maxlength: 4000, placeholder: '写几句关于这一年的话（可以不写）' });
  year.value = initial.year || new Date().getFullYear();
  title.value = initial.title || '';
  text.value = initial.text || '';
  const label = (t, el, full) => h('label', { class: full ? 'full' : null }, t, el);
  return {
    el: h('div', { class: 'form-grid' }, label('年份', year), label('标题', title), label('说明', text, true)),
    setYear(y) {
      if (!initial.year) year.value = y;
    },
    values() {
      const y = String(year.value).trim();
      return { year: y, title: title.value.trim() || `${y} 年`, text: text.value.trim() };
    },
  };
}

function openVideoUpload() {
  let file = null;
  let info = null;
  let cancelFn = null;
  let canceled = false;

  const input = h('input', { type: 'file', accept: 'video/*,.mov,.mp4,.m4v,.webm,.mkv', hidden: true });
  const drop = h('label', { class: 'drop' }, input,
    h('div', { class: 'drop-icon', text: '＋' }),
    h('div', { text: '点击选择一个视频，或把视频拖到这里' }),
    h('div', { class: 'hint', text: '会先在你的浏览器里压缩成 720p（大约每分钟 15 MB）再上传，建议用电脑上的 Chrome 或 Edge' }));
  const fileInfo = h('div', { class: 'video-file', hidden: true });
  const form = videoForm();
  const formBox = h('div', { hidden: true }, form.el);
  const err = h('div', { class: 'form-err' });
  const phase = h('div', { class: 'up-status' });
  const bar = h('div', { class: 'bar' });
  const progress = h('div', { class: 'progress', hidden: true }, bar);
  const cancel = h('button', { class: 'btn', type: 'button' }, '取消');
  const submit = h('button', { class: 'btn primary', type: 'button', disabled: true }, '开始上传');
  const warnLeave = (e) => { e.preventDefault(); e.returnValue = ''; };

  cancel.addEventListener('click', () => {
    if (modal.busy) {
      canceled = true;
      cancelFn?.();
      phase.textContent = '正在取消…';
    } else {
      closeModal();
    }
  });

  const pick = async (f) => {
    if (!f) return;
    if (!f.type.startsWith('video/') && !/\.(mov|mp4|m4v|webm|mkv)$/i.test(f.name)) {
      err.textContent = '请选择视频文件';
      return;
    }
    file = f;
    info = null;
    err.textContent = '';
    submit.disabled = true;
    fileInfo.hidden = false;
    fileInfo.textContent = `${f.name} · ${fmtBytes(f.size)} · 正在读取…`;
    try {
      info = await readVideoInfo(await loadMediabunny(), f);
    } catch (e) {
      fileInfo.textContent = `${f.name} · ${fmtBytes(f.size)}`;
      err.textContent = `读不了这个视频：${e.message}`;
      return;
    }
    const est = (info.duration * (VIDEO_BITRATE + AUDIO_BITRATE)) / 8;
    fileInfo.textContent = `${f.name} · ${fmtDuration(info.duration)} · 原文件 ${fmtBytes(f.size)}，压缩后约 ${fmtBytes(Math.min(est, f.size))}`;
    form.setYear(info.year);
    formBox.hidden = false;
    submit.disabled = false;
  };
  input.addEventListener('change', () => pick(input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });

  submit.addEventListener('click', async () => {
    const meta = form.values();
    if (!/^\d{4}$/.test(meta.year)) {
      err.textContent = '请填写四位数的年份，例如 2025';
      return;
    }
    err.textContent = '';
    canceled = false;
    modal.busy = true;
    submit.disabled = true;
    drop.hidden = true;
    progress.hidden = false;
    window.addEventListener('beforeunload', warnLeave);
    const setBar = (p) => { bar.style.width = `${Math.round(p * 100)}%`; };
    try {
      let blob;
      try {
        phase.textContent = '正在压缩视频… 0%（请不要关闭这个页面）';
        setBar(0);
        blob = await compressVideo(await loadMediabunny(), file, info, (p) => {
          setBar(p);
          phase.textContent = `正在压缩视频… ${Math.round(p * 100)}%（请不要关闭这个页面）`;
        }, (fn) => { cancelFn = fn; });
      } catch (e) {
        if (canceled) throw new Error('已取消');
        // 这个浏览器压缩不了：原文件不大、而且浏览器能直接播放的话，就传原文件
        const playable = file.size <= 300 * 1024 * 1024 ? await grabPoster(file) : null;
        if (!playable) {
          throw new Error(e.message === 'UNSUPPORTED'
            ? '这个浏览器不支持压缩视频。请用电脑上的 Chrome 或 Edge 上传。'
            : `压缩失败：${e.message}`);
        }
        if (!confirm(`这个浏览器压缩不了视频。要直接上传原文件吗？（${fmtBytes(file.size)}，会占用更多空间）`)) throw new Error('已取消');
        blob = file;
      }
      cancelFn = null;
      phase.textContent = '正在生成封面…';
      const poster = await makePoster(await loadMediabunny(), blob, info.duration) || await grabPoster(blob);
      setBar(0);
      phase.textContent = `正在上传… 0%（${fmtBytes(blob.size)}）`;
      await uploadVideoBlob(blob, poster, { ...meta, duration: info.duration, w: info.w, h: info.h }, (p) => {
        setBar(p);
        phase.textContent = `正在上传… ${Math.round(p * 100)}%（${fmtBytes(blob.size)}）`;
      }, () => canceled);
      modal.busy = false;
      window.removeEventListener('beforeunload', warnLeave);
      closeModal(true);
      await reload('#/videos');
      toast('视频上传好了 ♥');
    } catch (e) {
      modal.busy = false;
      window.removeEventListener('beforeunload', warnLeave);
      err.textContent = e.message;
      phase.textContent = '';
      progress.hidden = true;
      drop.hidden = false;
      submit.disabled = !info;
    }
  });

  openModal('上传视频', [drop, fileInfo, formBox, err, phase, progress], [cancel, submit]);
  modal.cleanups.push(() => window.removeEventListener('beforeunload', warnLeave));
}

function openVideoEditor(v) {
  const form = videoForm(v);
  const err = h('div', { class: 'form-err' });
  const save = h('button', { class: 'btn primary', type: 'button' }, '保存');
  save.addEventListener('click', async () => {
    const meta = form.values();
    if (!/^\d{4}$/.test(meta.year)) {
      err.textContent = '请填写四位数的年份，例如 2025';
      return;
    }
    save.disabled = true;
    try {
      await api(`api/videos/${v.id}`, jsonBody('PUT', meta));
      closeModal(true);
      await reload('#/videos');
      toast('已保存');
    } catch (e) {
      err.textContent = e.message;
      save.disabled = false;
    }
  });
  openModal('编辑视频', [form.el, err], [h('button', { class: 'btn', type: 'button', onclick: () => closeModal() }, '取消'), save]);
}

async function deleteVideo(v) {
  if (!confirm(`确定删除「${v.title}」这个视频吗？删除后无法恢复。`)) return;
  try {
    await api(`api/videos/${v.id}`, { method: 'DELETE' });
    await reload('#/videos');
    toast('视频已删除');
  } catch (e) {
    toast(e.message);
  }
}
