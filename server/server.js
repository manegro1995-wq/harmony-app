// ══════════════════════════════════════════════════════════════════
// Harmony AI proxy · zero dependencies · Node 18+
// ══════════════════════════════════════════════════════════════════
// The single job of this service: hold the API key, and stream replies
// to the browser in the exact SSE shape the client already parses.
//
// The client contract was not invented here — it was read out of
// HarmonyApp.security.callAPIStream(). Do not change it casually:
//
//   POST /api/chat
//   { message, companion, userName, sessionId,
//     history:[{role,content}], context?, recentOpeners?, emotion? }
//   → text/event-stream, frames of:  data: {"text":"…"}
//
// Status codes matter as much as the body. The client retries 429 and
// 5xx but treats other 4xx as final (see the retry loop in
// _getAIResponse), so returning 400 for a rate limit would make a
// recoverable blip look permanent to the person waiting.
//
// NO FRAMEWORK, DELIBERATELY. This is one route. Express would add ~70
// transitive packages to a service whose entire security value is that
// it holds a secret — every one of those is a supply-chain path to that
// secret, in exchange for sugar over `req.url === '/api/chat'`.
// ══════════════════════════════════════════════════════════════════

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSystemBlocks, COMPANION_IDS } from './personas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PORT = 8080,
  ANTHROPIC_API_KEY,
  MODEL = 'claude-sonnet-4-6',
  ALLOWED_ORIGINS = '',
  MAX_TOKENS = '1024',
  UPSTREAM_TIMEOUT_MS = '60000',
  PROMPT_CACHE = '1',
  UPSTREAM_URL = 'https://api.anthropic.com/v1/messages'
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set. Refusing to start.');
  process.exit(1);
}

const ORIGINS = ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
if (!ORIGINS.length) console.warn('WARNING: ALLOWED_ORIGINS empty — all browser origins will be refused.');

const MAX_BODY = 64 * 1024;   // generous for 14 turns; too small to fund a denial-of-wallet

// ── Rate limiting ─────────────────────────────────────────────────
// Two buckets, because they stop two different things: per-IP stops one
// person hammering the service, per-session stops one runaway tab.
// In-memory on purpose for a single instance — the moment you run two,
// move this to Redis or it silently doubles everyone's quota.
const buckets = new Map();
function take(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  if (b.n >= limit) return false;
  b.n++; return true;
}
setInterval(() => {                       // an unbounded Map is a memory leak wearing a hat
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

// ── Validation ────────────────────────────────────────────────────
const clamp = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

export function validate(body) {
  const companion = COMPANION_IDS.includes(body?.companion) ? body.companion : 'noam';

  // A name is a name. Newlines and braces are exactly how you would try
  // to climb out of the {{NAME}} slot into the prompt around it.
  const userName = clamp(body?.userName, 40).replace(/[\r\n{}]/g, '').trim() || 'חבר';

  const history = (Array.isArray(body?.history) ? body.history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-14)
    .map(m => ({ role: m.role, content: clamp(m.content, 4000) }))
    .filter(m => m.content.trim());

  // The upstream requires the first message to be from the user. A refresh
  // mid-turn can leave an assistant message stranded at the front.
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length) return { error: 'empty_history' };

  return {
    companion, userName, history,
    context: clamp(body?.context, 4000),
    recentOpeners: Array.isArray(body?.recentOpeners) ? body.recentOpeners : [],
    emotion: clamp(body?.emotion?.label ?? body?.emotion, 32)
  };
}

// ── Upstream SSE reader ───────────────────────────────────────────
// The same class of bug the browser had: a chunk boundary is not a line
// boundary. Buffer across reads, parse only complete lines, or you
// silently drop whichever token straddled a packet.
export async function* upstreamText(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') yield evt.delta.text;
        if (evt.type === 'error') throw new Error('upstream_error');
      }
    }
  } finally { try { await reader.cancel(); } catch {} }
}

// ── HTTP plumbing ─────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

const json = (res, code, obj, extra = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(obj));
};

function corsHeaders(origin) {
  if (!origin || !ORIGINS.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'vary': 'Origin',
    'access-control-allow-headers': 'Content-Type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-max-age': '86400'
  };
}

// ── Static file serving ───────────────────────────────────────────
function serveStatic(req, res) {
  let filePath = path.join(__dirname, '..', req.url === '/' ? 'index.html' : req.url);
  
  // Prevent directory traversal
  if (!path.resolve(filePath).startsWith(path.resolve(__dirname, '..'))) {
    return json(res, 403, { error: 'forbidden' });
  }

  try {
    const stats = fs.statSync(filePath);
    
    // For directories, serve index.html
    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath);
    
    const mimeTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(content);
  } catch (e) {
    // If file doesn't exist and it's not an API call, serve index.html (SPA fallback)
    if (!req.url.startsWith('/api/')) {
      try {
        const indexPath = path.join(__dirname, '..', 'index.html');
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(content);
        return;
      } catch {}
    }
    json(res, 404, { error: 'not_found' });
  }
}

async function handleChat(req, res, cors) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress || 'unknown';

  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, e.message === 'payload_too_large' ? 413 : 400, { error: e.message }, cors); }

  const session = clamp(body?.sessionId, 64) || ip;
  if (!take('ip:' + ip, 40, 60_000) || !take('sess:' + session, 20, 60_000)) {
    // 429, not 400 — the client's retry treats this one as recoverable.
    return json(res, 429, { error: 'rate_limited' }, { ...cors, 'retry-after': '30' });
  }

  const v = validate(body);
  if (v.error) return json(res, 400, { error: v.error }, cors);

  // NOTE: body.system is deliberately ignored. See personas.js.
  //
  // Two blocks, stable first. The stable one carries the cache marker and
  // is ~3,000 tokens that never change during a conversation; a cache read
  // costs a tenth of a fresh one, so from the second message onward this is
  // most of the bill removed. Everything that changes per turn sits after
  // the marker, because the cache is prefix-matched and one altered
  // character before it throws the whole thing away.
  const blocks = composeSystemBlocks(v);
  const tail = blocks.dynamic
    + (v.context ? `\n\n── הקשר מהאפליקציה ──\n${v.context}` : '');
  const system = [
    PROMPT_CACHE === '1'
      ? { type: 'text', text: blocks.stable, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: blocks.stable },
    ...(tail ? [{ type: 'text', text: tail }] : [])
  ];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(UPSTREAM_TIMEOUT_MS));
  req.on('close', () => ac.abort());   // tab closed → stop paying for tokens nobody will read

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: Number(MAX_TOKENS),
        system, messages: v.history, stream: true
      })
    });

    if (!upstream.ok) {
      // Never forward an upstream body — it can carry provider detail the
      // browser has no business seeing. Map to a status the client's retry
      // reads correctly, and stop there.
      const out = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400;
      console.warn('upstream', upstream.status, '->', out);   // status only, never content
      return json(res, out, { error: 'upstream_' + upstream.status }, cors);
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      // Nginx and several PaaS proxies buffer by default, which turns
      // streaming back into one blob at the end. Forgetting this is the
      // classic "why does it stream locally but not in production".
      'x-accel-buffering': 'no',
      ...cors
    });

    for await (const text of upstreamText(upstream, ac.signal)) {
      if (res.writableEnded) break;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (e) {
    const aborted = e?.name === 'AbortError';
    console.warn('chat failed:', aborted ? 'aborted/timeout' : e?.message);
    if (res.headersSent) {
      // Mid-stream: the client already has partial text and by design will
      // keep it rather than retry, because a retry restarts the reply and
      // the companion appears to contradict itself.
      res.end();
    } else {
      json(res, aborted ? 504 : 502, { error: 'upstream_unavailable' }, cors);
    }
  } finally { clearTimeout(timer); }
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') { res.writeHead(cors ? 204 : 403, cors || {}); return res.end(); }
  if (req.url === '/health')    return json(res, 200, { ok: true, model: MODEL });

  if (req.url === '/api/chat' && req.method === 'POST') {
    // A wildcard here would let any site on the internet spend this key
    // from a visitor's browser. Allowlist, never '*'.
    if (!cors) return json(res, 403, { error: 'origin_not_allowed' });
    return handleChat(req, res, cors);
  }

  // Serve static files (HTML, CSS, JS, images, etc.)
  serveStatic(req, res);
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => {
    console.log(`harmony-proxy :${PORT} · model=${MODEL} · origins=${ORIGINS.length || 'NONE'}`);
  });
}

// ── ON LOGGING ────────────────────────────────────────────────────
// Nothing here logs a message, a reply, a name, or a history. That is
// not an oversight for someone to tidy up later when they add
// observability. This service carries what people say when they are not
// okay, and the only defensible posture is that it cannot be read off a
// log drain, a crash dump or an APM trace. Log counts, statuses,
// latencies. Never content.
