// 密码门：网站的每个请求（页面、照片、视频）都先经过这里。
// 没登录的人只能看到登录页，拿不到任何照片或视频文件。
//
// 密码保存在 Cloudflare 的加密变量 SITE_PASSWORD 里（wrangler secret put SITE_PASSWORD）。
// 改密码后，所有已登录的设备都会自动退出。

const COOKIE = 'story_session';
const MAX_AGE = 60 * 60 * 24 * 30; // 登录一次保持 30 天；期间每天第一次打开都会再顺延 30 天
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const password = env.SITE_PASSWORD;

    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (!password) {
      // 没设置密码时一律拒绝，避免网站意外公开
      return new Response('网站还没有设置密码（SITE_PASSWORD），暂不开放。', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (url.pathname.startsWith('/icons/')) {
      // 主屏幕图标只是一颗爱心，不含个人信息：不登录也能取（登录页和手机系统要用）
      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'public, max-age=86400');
      return out;
    }
    if (url.pathname === '/login') {
      return request.method === 'POST' ? handleLogin(request, env, url) : loginPage(env);
    }
    if (url.pathname === '/logout') {
      return new Response(null, {
        status: 303,
        headers: { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
      });
    }

    const exp = await sessionExpiry(request, password);
    if (!exp) {
      const wantsPage = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
      if (wantsPage) return Response.redirect(new URL('/login', url).toString(), 302);
      return new Response('Unauthorized', { status: 401 });
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return json({ error: `服务器出错：${e.message || e}` }, 500);
      }
    }
    if (url.pathname.startsWith('/img/')) return serveImage(env, url);
    if (url.pathname.startsWith('/vid/')) return serveVideo(env, request, url);
    if (url.pathname.startsWith('/tiles/watercolor/')) return proxyWatercolor(url);

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    // 照片、视频文件名带内容指纹，可以放心在浏览器里缓存；页面和数据每次都重新确认
    const immutable = url.pathname.startsWith('/media/') || url.pathname.startsWith('/vendor/');
    out.headers.set('Cache-Control', immutable ? 'private, max-age=2592000, immutable' : 'private, no-cache');
    out.headers.set('X-Robots-Tag', 'noindex, nofollow');
    // 每天第一次打开页面时把登录顺延 30 天：常用的手机（包括主屏幕上的图标）就不会突然要重新输密码
    const html = (out.headers.get('content-type') || '').includes('text/html');
    if (html && exp - Date.now() / 1000 < MAX_AGE - 86400) {
      out.headers.append('Set-Cookie', await sessionCookie(password, url));
    }
    return out;
  },
};

// ---------- 网站上传 / 编辑（照片存在 KV，地点和照片信息存在 D1） ----------
// kind：'wish' 表示「想去的地方」；有了照片之后，网页上就把它当成「去过的地方」
const PLACE_FIELDS = ['title', 'city', 'country', 'lat', 'lng', 'date', 'end_date', 'text', 'cover', 'kind'];
let schemaReady = null;

function ensureSchema(env) {
  schemaReady ??= (async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS places (
        id TEXT PRIMARY KEY, title TEXT, city TEXT, country TEXT, lat REAL, lng REAL,
        date TEXT, end_date TEXT, text TEXT, cover TEXT, created_at TEXT, updated_at TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, place_id TEXT NOT NULL, w INTEGER, h INTEGER, taken TEXT,
        caption TEXT, lat REAL, lng REAL, created_at TEXT, size INTEGER)`),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS photos_place ON photos(place_id)'),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY, year TEXT, title TEXT, text TEXT, size INTEGER, parts INTEGER, part_size INTEGER,
        duration REAL, w INTEGER, h INTEGER, poster_size INTEGER, status TEXT, created_at TEXT)`),
    ]);
    // 旧版本的表缺的列补上：photos.size（照片占用的字节数）、places.kind（'wish' = 想去的地方）
    for (const sql of ['ALTER TABLE photos ADD COLUMN size INTEGER', 'ALTER TABLE places ADD COLUMN kind TEXT']) {
      try {
        await env.DB.prepare(sql).run();
      } catch {
        /* 已经有这一列 */
      }
    }
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const nowIso = () => new Date().toISOString();

function cleanPlace(body) {
  const out = {};
  const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max));
  const num = (v, lim) => {
    if (v === '' || v == null) return v === '' ? '' : null;
    const n = Number(v);
    return Number.isFinite(n) && Math.abs(n) <= lim ? n : null;
  };
  const day = (v) => (v === '' ? '' : v == null ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
  for (const k of PLACE_FIELDS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (k === 'title') out[k] = str(v, 80);
    else if (k === 'city' || k === 'country') out[k] = str(v, 60);
    else if (k === 'text') out[k] = str(v, 8000);
    else if (k === 'lat') out[k] = num(v, 90);
    else if (k === 'lng') out[k] = num(v, 180);
    else if (k === 'date' || k === 'end_date') out[k] = day(v);
    else if (k === 'cover') out[k] = v === '' ? '' : /^(img|media)\/[\w./-]{1,200}$/.test(String(v)) ? String(v) : null;
    else if (k === 'kind') out[k] = v === 'wish' ? 'wish' : '';
  }
  return out;
}

async function handleApi(request, env, url) {
  if (!env.DB || !env.PHOTOS) return json({ enabled: false, places: [], photos: [] }, url.pathname === '/api/story' ? 200 : 503);
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: '来源不对' }, 403);
  }
  await ensureSchema(env);
  const [, , kind, id, action] = url.pathname.split('/');
  const db = env.DB;

  // 空间使用情况：网站上传的照片一共占了多少（KV 免费 1 GB）
  if (kind === 'usage' && request.method === 'GET') {
    const missing = await db.prepare('SELECT id FROM photos WHERE size IS NULL LIMIT 100').all();
    for (const r of missing.results) {
      let size = 0;
      for (const k of [`img/${r.id}`, `img/${r.id}_t`]) {
        const v = await env.PHOTOS.get(k, { type: 'arrayBuffer' });
        size += v ? v.byteLength : 0;
      }
      await db.prepare('UPDATE photos SET size = ? WHERE id = ?').bind(size, r.id).run();
    }
    const today = new Date().toISOString().slice(0, 10);
    const row = await db.prepare(`SELECT COUNT(*) AS photos, COALESCE(SUM(size), 0) AS bytes,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today FROM photos`).bind(today).first();
    const vid = await db.prepare(`SELECT COUNT(*) AS videos, COALESCE(SUM(COALESCE(size, 0) + COALESCE(poster_size, 0)), 0) AS bytes
      FROM videos`).first();
    return json({
      photos: row.photos, photoBytes: row.bytes, videos: vid.videos, videoBytes: vid.bytes,
      bytes: row.bytes + vid.bytes, today: row.today, limitBytes: 1e9, dailyPhotos: 500,
    });
  }

  // 把几个地点合并成一个：照片都搬过去，文字接在一起，日期取最早到最晚
  if (kind === 'places' && id && action === 'merge' && request.method === 'POST') {
    if (!/^(w|p)-[\w]{1,40}$/.test(id)) return json({ error: '地点不存在' }, 404);
    const body = await request.json();
    const ids = [...new Set((body.from || []).map(String))].filter((x) => x !== id && /^w-[\w]{1,40}$/.test(x));
    if (!ids.length) return json({ error: '没有可以合并的地点' }, 400);
    const marks = ids.map(() => '?').join(', ');
    const rows = (await db.prepare(`SELECT * FROM places WHERE id IN (${marks})`).bind(...ids).all()).results;
    const target = (await db.prepare('SELECT * FROM places WHERE id = ?').bind(id).first()) || {};
    const text = [target.text, ...rows.map((r) => r.text)].filter((t) => t && t.trim()).join('\n\n');
    const days = [target.date, target.end_date, ...rows.flatMap((r) => [r.date, r.end_date])]
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).sort();
    const merged = {
      ...Object.fromEntries(PLACE_FIELDS.map((k) => [k, target[k] ?? null])),
      text: text || target.text || null,
      date: days[0] || target.date || null,
      end_date: days.length > 1 && days.at(-1) !== days[0] ? days.at(-1) : target.end_date ?? null,
    };
    await db.batch([
      db.prepare(`INSERT INTO places (id, ${PLACE_FIELDS.join(', ')}, created_at, updated_at)
        VALUES (?, ${PLACE_FIELDS.map(() => '?').join(', ')}, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ${PLACE_FIELDS.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`)
        .bind(id, ...PLACE_FIELDS.map((k) => merged[k]), target.created_at || nowIso(), nowIso()),
      db.prepare(`UPDATE photos SET place_id = ? WHERE place_id IN (${marks})`).bind(id, ...ids),
      db.prepare(`DELETE FROM places WHERE id IN (${marks})`).bind(...ids),
    ]);
    return json({ ok: true, merged: ids.length });
  }

  if (kind === 'story' && request.method === 'GET') {
    // 顺手清理：网站上建的、没有照片也没写文字的地点（例如上传中途失败留下的），建好 10 分钟后自动删除
    const [, places, photos, videos] = await db.batch([
      db.prepare(`DELETE FROM places WHERE id LIKE 'w-%' AND COALESCE(text, '') = '' AND COALESCE(kind, '') != 'wish' AND created_at < ?
        AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.place_id = places.id)`).bind(new Date(Date.now() - 600000).toISOString()),
      db.prepare('SELECT * FROM places'),
      db.prepare('SELECT * FROM photos ORDER BY taken, created_at'),
      db.prepare("SELECT id, year, title, text, duration, w, h FROM videos WHERE status = 'ready' ORDER BY year DESC, created_at DESC"),
    ]);
    return json({ enabled: true, places: places.results, photos: photos.results, videos: videos.results });
  }

  if (kind === 'videos') return handleVideos(request, env, db, id, action, url);

  if (kind === 'places') {
    if (request.method === 'POST' && !id) {
      const p = cleanPlace(await request.json());
      if (!p.title) return json({ error: '请填写地点的名字' }, 400);
      const pid = `w-${newId()}`;
      const row = { ...Object.fromEntries(PLACE_FIELDS.map((k) => [k, null])), ...p };
      await db.prepare(`INSERT INTO places (id, ${PLACE_FIELDS.join(', ')}, created_at, updated_at)
        VALUES (?, ${PLACE_FIELDS.map(() => '?').join(', ')}, ?, ?)`)
        .bind(pid, ...PLACE_FIELDS.map((k) => row[k]), nowIso(), nowIso()).run();
      return json({ id: pid });
    }
    if (request.method === 'PUT' && id) {
      if (!/^(w|p)-[\w]{1,40}$/.test(id)) return json({ error: '地点不存在' }, 404);
      const p = cleanPlace(await request.json());
      const old = (await db.prepare('SELECT * FROM places WHERE id = ?').bind(id).first()) || {};
      const row = Object.fromEntries(PLACE_FIELDS.map((k) => [k, k in p ? p[k] : (old[k] ?? null)]));
      await db.prepare(`INSERT INTO places (id, ${PLACE_FIELDS.join(', ')}, created_at, updated_at)
        VALUES (?, ${PLACE_FIELDS.map(() => '?').join(', ')}, ?, ?)
        ON CONFLICT(id) DO UPDATE SET ${PLACE_FIELDS.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`)
        .bind(id, ...PLACE_FIELDS.map((k) => row[k]), old.created_at || nowIso(), nowIso()).run();
      return json({ ok: true });
    }
    if (request.method === 'DELETE' && id) {
      if (!id.startsWith('w-')) return json({ error: '这个地点是在电脑上的 content 文件夹里建的，请在电脑上删除' }, 400);
      const photos = await db.prepare('SELECT id FROM photos WHERE place_id = ?').bind(id).all();
      for (const ph of photos.results) await deleteImage(env, ph.id);
      await db.batch([
        db.prepare('DELETE FROM photos WHERE place_id = ?').bind(id),
        db.prepare('DELETE FROM places WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
  }

  if (kind === 'photos') {
    if (request.method === 'POST' && !id) {
      const form = await request.formData();
      const placeId = String(form.get('place_id') || '');
      if (!/^(w|p)-[\w]{1,40}$/.test(placeId)) return json({ error: '请先选择地点' }, 400);
      if (placeId.startsWith('w-') && !(await db.prepare('SELECT id FROM places WHERE id = ?').bind(placeId).first())) {
        return json({ error: '这个地点已经不存在了' }, 404);
      }
      const image = form.get('image');
      const thumb = form.get('thumb');
      const big = await readJpeg(image, 8 * 1024 * 1024);
      const small = await readJpeg(thumb, 1024 * 1024);
      if (!big || !small) return json({ error: '照片格式不对（需要 JPG），或者文件太大' }, 400);
      const pid = newId();
      await env.PHOTOS.put(`img/${pid}`, big);
      await env.PHOTOS.put(`img/${pid}_t`, small);
      const num = (k, lim) => {
        const n = Number(form.get(k));
        return form.get(k) != null && form.get(k) !== '' && Number.isFinite(n) && Math.abs(n) <= lim ? n : null;
      };
      const takenRaw = String(form.get('taken') || '');
      const taken = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(takenRaw) ? takenRaw : null;
      const row = {
        id: pid, place_id: placeId, w: num('w', 20000), h: num('h', 20000), taken,
        caption: String(form.get('caption') || '').slice(0, 200), lat: num('lat', 90), lng: num('lng', 180), created_at: nowIso(),
      };
      await db.prepare('INSERT INTO photos (id, place_id, w, h, taken, caption, lat, lng, created_at, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.place_id, row.w, row.h, row.taken, row.caption, row.lat, row.lng, row.created_at, big.byteLength + small.byteLength).run();
      return json(row);
    }
    // 把一张或多张照片移到另一个地点
    if (request.method === 'POST' && id === 'move') {
      const b = await request.json();
      const ids = [...new Set((b.ids || []).map(String))].filter((x) => /^[0-9a-f]{16}$/.test(x));
      const placeId = String(b.place_id || '');
      if (!ids.length) return json({ error: '没有选择照片' }, 400);
      if (!/^(w|p)-[\w]{1,40}$/.test(placeId)) return json({ error: '请选择地点' }, 400);
      if (placeId.startsWith('w-') && !(await db.prepare('SELECT id FROM places WHERE id = ?').bind(placeId).first())) {
        return json({ error: '这个地点已经不存在了' }, 404);
      }
      let moved = 0;
      const sources = new Set();
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const marks = chunk.map(() => '?').join(', ');
        const from = await db.prepare(`SELECT DISTINCT place_id FROM photos WHERE id IN (${marks})`).bind(...chunk).all();
        from.results.forEach((r) => sources.add(r.place_id));
        const r = await db.prepare(`UPDATE photos SET place_id = ? WHERE id IN (${marks})`).bind(placeId, ...chunk).run();
        moved += r.meta.changes;
        // 被移走的照片如果是原来地点的封面，原地点改回默认封面
        await db.prepare(`UPDATE places SET cover = '' WHERE id != ? AND cover IN (${marks})`)
          .bind(placeId, ...chunk.map((x) => `img/${x}.jpg`)).run();
      }
      sources.delete(placeId);
      const removed = await removeEmptyPlaces(db, [...sources]);
      return json({ ok: true, moved, removed });
    }
    // 修改照片的说明和拍摄日期
    if (request.method === 'PUT' && id) {
      const body = await request.json();
      const ph = await db.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
      if (!ph) return json({ error: '照片不存在' }, 404);
      const caption = 'caption' in body ? String(body.caption ?? '').trim().slice(0, 200) : ph.caption;
      let taken = ph.taken;
      if ('taken' in body) {
        const t = String(body.taken ?? '');
        if (t === '') taken = null;
        else if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(t)) taken = t;
      }
      await db.prepare('UPDATE photos SET caption = ?, taken = ? WHERE id = ?').bind(caption, taken, id).run();
      return json({ ok: true });
    }
    if (request.method === 'DELETE' && id) {
      const ph = await db.prepare('SELECT id, place_id FROM photos WHERE id = ?').bind(id).first();
      if (!ph) return json({ error: '照片不存在' }, 404);
      await deleteImage(env, id);
      await db.batch([
        db.prepare('DELETE FROM photos WHERE id = ?').bind(id),
        db.prepare("UPDATE places SET cover = '' WHERE cover = ?").bind(`img/${id}.jpg`),
      ]);
      const removed = await removeEmptyPlaces(db, [ph.place_id]);
      return json({ ok: true, removed });
    }
  }
  return json({ error: '不支持的操作' }, 404);
}

// ---------- 网站上传的视频：浏览器先压缩成 720p MP4，再切成 5 MB 一段存进 KV（单个值上限 25 MB） ----------
const VIDEO_PART = 5 * 1024 * 1024;
const KV_LIMIT = 1e9; // KV 免费 1 GB

async function handleVideos(request, env, db, id, action, url) {
  const m = request.method;
  if (m === 'POST' && !id) {
    const b = await request.json();
    const size = Math.floor(Number(b.size));
    if (!(size > 0) || size > 600 * 1024 * 1024) return json({ error: '视频太大了（压缩后不能超过 600 MB）' }, 400);
    // 清理一天前没传完的视频
    const stale = await db.prepare("SELECT id, parts FROM videos WHERE status = 'uploading' AND created_at < ?")
      .bind(new Date(Date.now() - 86400000).toISOString()).all();
    for (const v of stale.results) await deleteVideoData(env, db, v);
    const used = await db.prepare(`SELECT
      (SELECT COALESCE(SUM(size), 0) FROM photos) + (SELECT COALESCE(SUM(COALESCE(size, 0) + COALESCE(poster_size, 0)), 0) FROM videos) AS used`).first();
    if (used.used + size > KV_LIMIT * 0.98) {
      return json({ error: `空间不够了：还剩约 ${Math.max(0, Math.round((KV_LIMIT - used.used) / 1e6))} MB，这个视频压缩后约 ${Math.round(size / 1e6)} MB` }, 400);
    }
    const vid = newId();
    const year = /^\d{4}$/.test(String(b.year)) ? String(b.year) : String(new Date().getFullYear());
    const num = (v, lim) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= lim ? Number(v) : null);
    await db.prepare(`INSERT INTO videos (id, year, title, text, size, parts, part_size, duration, w, h, poster_size, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?)`)
      .bind(vid, year, String(b.title || `${year} 年`).trim().slice(0, 80), String(b.text || '').trim().slice(0, 4000),
        size, Math.ceil(size / VIDEO_PART), VIDEO_PART, num(b.duration, 86400), num(b.w, 10000), num(b.h, 10000), nowIso()).run();
    return json({ id: vid, partSize: VIDEO_PART, parts: Math.ceil(size / VIDEO_PART) });
  }
  if (!id || !/^[0-9a-f]{16}$/.test(id)) return json({ error: '视频不存在' }, 404);
  const v = await db.prepare('SELECT * FROM videos WHERE id = ?').bind(id).first();
  if (!v) return json({ error: '视频不存在' }, 404);

  if (m === 'PUT' && action === 'part') {
    const n = Number(url.pathname.split('/')[5]);
    if (v.status !== 'uploading' || !Number.isInteger(n) || n < 0 || n >= v.parts) return json({ error: '分段编号不对' }, 400);
    const buf = await request.arrayBuffer();
    const expected = n === v.parts - 1 ? v.size - n * v.part_size : v.part_size;
    if (buf.byteLength !== expected) return json({ error: '分段大小不对，请重新上传' }, 400);
    await env.PHOTOS.put(`vid/${id}/${n}`, buf);
    return json({ ok: true });
  }
  if (m === 'PUT' && action === 'poster') {
    const buf = await request.arrayBuffer();
    const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
    if (buf.byteLength > 1024 * 1024 || b[0] !== 0xff || b[1] !== 0xd8) return json({ error: '封面图格式不对' }, 400);
    await env.PHOTOS.put(`vid/${id}/poster`, buf);
    await db.prepare('UPDATE videos SET poster_size = ? WHERE id = ?').bind(buf.byteLength, id).run();
    return json({ ok: true });
  }
  if (m === 'POST' && action === 'finish') {
    await db.prepare("UPDATE videos SET status = 'ready' WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (m === 'PUT' && !action) {
    const b = await request.json();
    const year = /^\d{4}$/.test(String(b.year)) ? String(b.year) : v.year;
    await db.prepare('UPDATE videos SET year = ?, title = ?, text = ? WHERE id = ?')
      .bind(year, String(b.title ?? v.title).trim().slice(0, 80) || `${year} 年`, String(b.text ?? v.text ?? '').trim().slice(0, 4000), id).run();
    return json({ ok: true });
  }
  if (m === 'DELETE' && !action) {
    await deleteVideoData(env, db, v);
    return json({ ok: true });
  }
  return json({ error: '不支持的操作' }, 404);
}

async function deleteVideoData(env, db, v) {
  for (let n = 0; n < (v.parts || 0); n++) await env.PHOTOS.delete(`vid/${v.id}/${n}`);
  await env.PHOTOS.delete(`vid/${v.id}/poster`);
  await db.prepare('DELETE FROM videos WHERE id = ?').bind(v.id).run();
}

// 播放：支持拖动进度条（Range 请求）。每次最多返回一段（5 MB），浏览器会自动接着要后面的
async function serveVideo(env, request, url) {
  const m = url.pathname.match(/^\/vid\/([0-9a-f]{16})\.(mp4|jpg)$/);
  if (!m || !env.DB || !env.PHOTOS) return new Response('Not found', { status: 404 });
  const [, id, ext] = m;
  const cache = { 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Robots-Tag': 'noindex, nofollow' };
  if (ext === 'jpg') {
    const body = await env.PHOTOS.get(`vid/${id}/poster`, { type: 'stream', cacheTtl: 86400 });
    return body ? new Response(body, { headers: { 'content-type': 'image/jpeg', ...cache } }) : new Response('Not found', { status: 404 });
  }
  await ensureSchema(env);
  const v = await env.DB.prepare("SELECT size, parts, part_size FROM videos WHERE id = ? AND status = 'ready'").bind(id).first();
  if (!v) return new Response('Not found', { status: 404 });
  const headers = { 'content-type': 'video/mp4', 'Accept-Ranges': 'bytes', ...cache };
  const range = request.headers.get('range');
  if (!range) {
    // 整个文件按顺序拼起来（例如下载时）
    let n = 0;
    const body = new ReadableStream({
      async pull(ctrl) {
        if (n >= v.parts) return ctrl.close();
        const part = await env.PHOTOS.get(`vid/${id}/${n++}`, { type: 'arrayBuffer' });
        if (!part) return ctrl.error(new Error('missing part'));
        ctrl.enqueue(new Uint8Array(part));
      },
    });
    return new Response(body, { headers: { ...headers, 'Content-Length': String(v.size) } });
  }
  const r = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = v.size - 1;
  if (r && r[1] === '' && r[2]) start = Math.max(0, v.size - Number(r[2]));
  else if (r) {
    start = Number(r[1] || 0);
    if (r[2]) end = Math.min(Number(r[2]), v.size - 1);
  }
  if (start >= v.size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${v.size}` } });
  }
  const n = Math.floor(start / v.part_size);
  const partStart = n * v.part_size;
  end = Math.min(end, Math.min(partStart + v.part_size, v.size) - 1);
  const stream = await env.PHOTOS.get(`vid/${id}/${n}`, { type: 'stream', cacheTtl: 86400 });
  if (!stream) return new Response('Not found', { status: 404 });
  const skip = start - partStart;
  const len = end - start + 1;
  let pos = 0;
  const slice = new TransformStream({
    transform(chunk, ctrl) {
      const s = Math.max(0, skip - pos);
      const e = Math.min(chunk.byteLength, skip + len - pos);
      if (e > s) ctrl.enqueue(chunk.subarray(s, e));
      pos += chunk.byteLength;
    },
  });
  return new Response(stream.pipeThrough(slice), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${v.size}`, 'Content-Length': String(len) },
  });
}

// 水彩地图瓦片：原站（史密森尼库珀·休伊特博物馆保存的 Stamen Watercolor）不允许跨域，
// 所以由这里转一手，地图引擎才能画出来。使用条款：署名 Stamen Design（CC BY 3.0）和 OpenStreetMap。
async function proxyWatercolor(url) {
  const m = url.pathname.match(/^\/tiles\/watercolor\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.jpg$/);
  if (!m || Number(m[1]) > 13) return new Response('Not found', { status: 404 });
  const res = await fetch(`https://watercolormaps.collection.cooperhewitt.org/tile/watercolor/${m[1]}/${m[2]}/${m[3]}.jpg`, {
    cf: { cacheTtl: 2592000, cacheEverything: true },
  });
  if (!res.ok) return new Response('Not found', { status: res.status === 404 ? 404 : 502 });
  return new Response(res.body, {
    headers: { 'content-type': 'image/jpeg', 'Cache-Control': 'private, max-age=2592000', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// 网站上建的地点，照片全被删掉或移走、而且没写过经历文字时，自动删除。返回删掉的地点 id。
// （写过文字的不自动删，由网页上问一下）
async function removeEmptyPlaces(db, ids) {
  const web = [...new Set(ids)].filter((x) => /^w-[\w]{1,40}$/.test(x));
  if (!web.length) return [];
  const marks = web.map(() => '?').join(', ');
  // 想去的地方（kind = 'wish'）照片被删光后会变回「想去」，不删
  const empty = await db.prepare(`SELECT id FROM places WHERE id IN (${marks}) AND COALESCE(text, '') = '' AND COALESCE(kind, '') != 'wish'
    AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.place_id = places.id)`).bind(...web).all();
  const gone = empty.results.map((r) => r.id);
  if (gone.length) await db.prepare(`DELETE FROM places WHERE id IN (${gone.map(() => '?').join(', ')})`).bind(...gone).run();
  return gone;
}

async function readJpeg(file, maxBytes) {
  if (!file || typeof file === 'string' || file.size > maxBytes || file.size < 100) return null;
  const buf = await file.arrayBuffer();
  const b = new Uint8Array(buf, 0, 3);
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? buf : null;
}

async function deleteImage(env, id) {
  await env.PHOTOS.delete(`img/${id}`);
  await env.PHOTOS.delete(`img/${id}_t`);
}

async function serveImage(env, url) {
  const m = url.pathname.match(/^\/img\/([0-9a-f]{16})(_t)?\.jpg$/);
  if (!m || !env.PHOTOS) return new Response('Not found', { status: 404 });
  const body = await env.PHOTOS.get(`img/${m[1]}${m[2] || ''}`, { type: 'stream', cacheTtl: 86400 });
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(body, {
    headers: {
      'content-type': 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

async function handleLogin(request, env, url) {
  const form = await request.formData();
  const input = String(form.get('password') || '');
  const ok = safeEqual(await hmac('pw', input), await hmac('pw', env.SITE_PASSWORD));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800)); // 拖慢暴力猜密码
    return loginPage(env, '密码不对哦，再想想？', 401);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: '/', 'Set-Cookie': await sessionCookie(env.SITE_PASSWORD, url) },
  });
}

async function sessionCookie(password, url) {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  const token = `${exp}.${await hmac(sessionKey(password), exp)}`;
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure}`;
}

// 登录有效：返回到期时间（秒）；没登录或已过期：返回 0
async function sessionExpiry(request, password) {
  const token = readCookie(request, COOKIE);
  if (!token) return 0;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return 0;
  return safeEqual(sig, await hmac(sessionKey(password), exp)) ? Number(exp) : 0;
}

function sessionKey(password) {
  return `session:${password}`;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let s = '';
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function loginPage(env, error = '', status = 200) {
  const title = escapeHtml(env.SITE_TITLE || '我们的故事');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<meta name="theme-color" content="#fcf0f3">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="icon" type="image/png" sizes="64x64" href="/icons/favicon-64.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<style>
  :root { --bg:#fcf0f3; --card:rgba(255,250,251,.92); --text:#3d2a31; --muted:#9a7f88; --accent:#d4567a; --line:#f1d8e0;
    --grad:linear-gradient(135deg,#ee8aa6 0%,#d4567a 55%,#b23c62 100%); }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; color:var(--text);
    background:radial-gradient(900px 500px at 10% -10%,#fff7f9 0%,transparent 60%),
      radial-gradient(800px 480px at 105% 5%,#fbdde7 0%,transparent 58%),var(--bg);
    font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif; }
  .card { width:100%; max-width:360px; background:var(--card); border:1px solid #fff;
    border-radius:24px; padding:40px 30px 30px; text-align:center; box-shadow:0 20px 50px rgba(178,60,98,.15); }
  .heart { font-size:36px; line-height:1; background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent;
    display:inline-block; animation:beat 2.4s ease-in-out infinite; }
  @keyframes beat { 0%,100%{transform:scale(1)} 15%{transform:scale(1.18)} 30%{transform:scale(1)} 45%{transform:scale(1.12)} }
  h1 { font-family:"Noto Serif SC","Songti SC","STSong","Microsoft YaHei",serif; font-weight:600; font-size:26px;
    letter-spacing:.14em; margin:14px 0 6px; }
  p { color:var(--muted); margin:0 0 26px; font-size:14px; letter-spacing:.08em; }
  input { width:100%; font-size:16px; padding:12px 14px; border:1px solid var(--line); border-radius:14px;
    background:#fff; color:var(--text); outline:none; text-align:center; letter-spacing:.1em; }
  input:focus { border-color:var(--accent); box-shadow:0 0 0 4px rgba(212,86,122,.12); }
  button { width:100%; margin-top:14px; font-size:16px; padding:12px; border:0; border-radius:14px; letter-spacing:.3em;
    background:var(--grad); color:#fff; cursor:pointer; box-shadow:0 8px 20px rgba(212,86,122,.35); }
  button:hover { filter:brightness(1.05); }
  .err { color:#c0392b; font-size:14px; margin:12px 0 0; min-height:1em; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="heart">&#9829;</div>
    <h1>${title}</h1>
    <p>这里只属于我们两个人</p>
    <input type="password" name="password" placeholder="请输入密码" autocomplete="current-password" autofocus required>
    <button type="submit">进入</button>
    <div class="err">${escapeHtml(error)}</div>
  </form>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
