/**
 * dsh-theme-firefly —— 服务端半。
 * 主题的全部 UI 逻辑在浏览器端（lib/client.js）。
 * 本文件提供三件事：
 *   1. apply：让 cordis.patch.yml 里的 loader 行可以挂载（没有 fiber 的行会导致 boot 扫描失败）。
 *   2. 静态资产路由：把 assets/、GIF/、music/、wallpapers/ 下的壁纸/动图/音乐以
 *      /theme-firefly-assets/<相对路径> 提供（外置，不内联 base64），
 *      使 client.js 的聚合 bundle 保持小体积（实测内联 base64 会把
 *      lib/client.js 撑到 82MB，导致 client-modules 聚合 95MB、浏览器
 *      Failed to load plugins）。
 *   3. 用户上传壁纸持久化：POST /theme-firefly-assets/upload 接收上传文件写入
 *      <DSH_HOME>/theme-firefly/wallpapers/（服务器磁盘），刷新/重启/换浏览器
 *      都在——不依赖浏览器 IndexedDB（IndexedDB 会因版本不匹配/配额超限静默失败，
 *      且换浏览器即丢）。
 */
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, normalize, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
};

/** 允许被静态服务的顶层目录（相对插件根）。 */
const ALLOWED_DIRS = new Set(['assets', 'GIF', 'music', 'wallpapers']);

/** 上传文件允许的扩展名（与客户端 input accept 一致）。 */
const ALLOWED_UPLOAD_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4']);

/** 用户壁纸存储目录：$DSH_HOME/theme-firefly/wallpapers/（DSH_HOME 缺失时回退 ~/.dsh）。 */
function wallpaperDir() {
  const base = process.env.DSH_HOME || join(os.homedir(), '.dsh');
  return join(base, 'theme-firefly', 'wallpapers');
}

/**
 * 服务端半注册 HTTP 前缀路由（真实 API：webServer.register({kind:'prefix', path, handler})）。
 * 分流规则：
 *   POST /theme-firefly-assets/upload → 接收 raw body 写入 wallpapers/，返回 {ok, url}
 *   GET  /theme-firefly-assets/wallpapers/<file> → 静态服务用户壁纸
 *   GET  /theme-firefly-assets/<assets|GIF|music>/<file> → 静态服务内置素材
 */
export function registerAssets(ctx) {
  if (typeof ctx?.inject !== 'function') return false;
  let wired = false;
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx?.get?.('webServer');
    if (!webServer?.register) return;
    try {
      webServer.register({
        kind: 'prefix',
        path: '/theme-firefly-assets',
        handler(req, res) {
          const url = new URL(req.url ?? '/', 'http://x');
          const pathname = decodeURIComponent(url.pathname);
          const rel = pathname.replace(/^\/theme-firefly-assets\//, '');
          const top = rel.split('/')[0];

          // ── POST 上传 ──
          if (req.method === 'POST' && rel === 'upload') {
            handleUpload(req, res);
            return;
          }

          // ── DELETE 删除用户壁纸 ──
          if (req.method === 'DELETE' && top === 'wallpapers') {
            handleDelete(req, res, rel);
            return;
          }

          // ── GET 用户壁纸清单 ──
          if (req.method === 'GET' && rel === 'wallpapers/list') {
            handleList(res);
            return;
          }

          // ── 目录白名单（wallpapers 在 wallpapersDir，其余在插件根）──
          if (!ALLOWED_DIRS.has(top)) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          const base = top === 'wallpapers' ? wallpaperDir() : ROOT;
          // rel 含顶层目录（如 wallpapers/custom-x.mp4），wallpapers 时 base 已是目录，去掉顶层
          const relFile = top === 'wallpapers' ? rel.slice('wallpapers/'.length) : rel;
          const file = normalize(join(base, relFile));
          if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile() || basename(file).startsWith('.trash-')) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
          createReadStream(file).pipe(res);
        },
      });
      wired = true;
    } catch (e) {
      /* 注册失败静默，主题其余部分照常 */
    }
  });
  return wired;
}

/** 删除用户壁纸文件（仅允许 wallpapers/ 目录内）。 */
function handleDelete(req, res, rel) {
  try {
    const dir = wallpaperDir();
    const relFile = rel.startsWith('wallpapers/') ? rel.slice('wallpapers/'.length) : rel;
    const file = normalize(join(dir, relFile));
    // 仅允许 wallpapers/ 目录内的常规文件（排除 .trash-* 回收文件自身）
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile() || basename(file).startsWith('.trash-')) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'bad file' }));
      return;
    }
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    // 用 rename 到回收命名（.trash 前缀），保留可恢复性而非直接删
    const trash = join(dir, '.trash-' + Date.now().toString(36) + '-' + rel.replace(/[/\\]/g, '_'));
    mkdirSync(dir, { recursive: true });
    renameSync(file, trash);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  }
}

/** 列出用户已上传壁纸（wallpapers/ 目录扫描），返回 [{id, kind, label, url}]。 */
function handleList(res) {
  try {
    const dir = wallpaperDir();
    if (!existsSync(dir)) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, items: [] }));
      return;
    }
    const items = readdirSync(dir)
      .filter((f) => !f.startsWith('.trash-') && ALLOWED_UPLOAD_EXT.has(extname(f).toLowerCase()))
      .map((f) => {
        const ext = extname(f).toLowerCase();
        return {
          id: f.replace(/\.[^.]+$/, ''),
          kind: ext === '.mp4' ? 'video' : 'image',
          label: f.replace(/\.[^.]+$/, ''),
          url: '/theme-firefly-assets/wallpapers/' + encodeURIComponent(f),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, items }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
  }
}

/** 处理上传：收集 raw body → 校验扩展名 → 写入 wallpapers/ → 返回 {ok, url}。 */
function handleUpload(req, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > 200 * 1024 * 1024) { // 单文件上限 200MB（mp4 动态壁纸）
      aborted = true;
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'file too large' }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    // 文件名从 ?name= 查询参数取（客户端 fetch 时带上）
    const url = new URL(req.url ?? '/', 'http://x');
    const name = decodeURIComponent(url.searchParams.get('name') ?? 'wallpaper');
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_UPLOAD_EXT.has(ext)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'unsupported type: ' + ext }));
      return;
    }
    try {
      const dir = wallpaperDir();
      mkdirSync(dir, { recursive: true });
      const id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      const file = join(dir, id + ext);
      writeFileSync(file, Buffer.concat(chunks));
      const kind = ext === '.mp4' ? 'video' : 'image';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        id,
        kind,
        label: name.replace(/\.[^.]+$/, ''),
        url: '/theme-firefly-assets/wallpapers/' + encodeURIComponent(id + ext),
      }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    }
  });
  req.on('error', () => { if (!aborted) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: 'stream error' })); } });
}

/** DSH 插件应用入口（DSH 调用）。 */
export function apply(ctx) {
  registerAssets(ctx);
}
