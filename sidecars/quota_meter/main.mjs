// 额度速览 sidecar
//
// 轻量与低延迟设计：
//   * 0 Token 消耗：只读本机语言服务器的 RetrieveUserQuotaSummary 与 GetAllCascadeTrajectories。
//   * 标题零延迟兜底：持久化缓存对话标题 db.titles，并在语言服务器尚未懒加载工作区对话时直接从本地 transcript.jsonl 首条请求提取标题，彻底消除“对话 9d463d”占位名。
//   * 事件驱动采样：检测到本地任意对话新增模型调用步数时（且距上次采样 >15 秒），自动立即刷新一次额度；空闲时维持低频轮询。
import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LS = process.env.ANTIGRAVITY_LS_ADDRESS;
const CSRF = process.env.ANTIGRAVITY_CSRF_TOKEN;
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(__dirname, '.data');
const FILE = join(DATA_DIR, 'quota-history.json');

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const DEFAULTS = { threshold: 20, notify: true, notifyRecover: true, pollMin: 2 };
const RECOVER_AT = 0.9;
const RATE_WINDOW = 45 * MIN;

// ---------- 额度池 / 窗口自动识别 ----------
// 不写死任何池名、池数量或窗口：全部以语言服务器实时返回的 groups / buckets 为准。
// 池名做通用中文化（"X and Y models" → "X 与 Y 模型"），未知名称原样显示。
const zhGroup = (n) => String(n || '').replace(/\s+and\s+/gi, ' 与 ').replace(/\bmodels?\b/gi, '模型').replace(/\s+/g, ' ').trim();
const WIN_NAMED = { hourly: [HOUR, '每小时'], daily: [DAY, '每天'], weekly: [7 * DAY, '每周'], monthly: [30 * DAY, '每月'] };
const WIN_UNIT = { m: [MIN, '分钟'], min: [MIN, '分钟'], h: [HOUR, '小时'], hr: [HOUR, '小时'], d: [DAY, '天'], w: [7 * DAY, '周'] };
function winInfo(w, fallbackLabel) {
  const k = String(w || '').toLowerCase().trim();
  if (WIN_NAMED[k]) return { ms: WIN_NAMED[k][0], label: WIN_NAMED[k][1], known: true };
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|w)$/.exec(k);
  if (m) return { ms: Number(m[1]) * WIN_UNIT[m[2]][0], label: `${m[1]} ${WIN_UNIT[m[2]][1]}`, known: true };
  return { ms: 7 * DAY, label: fallbackLabel || w || '限额', known: false };
}
const winName = (w, fallback) => { const i = winInfo(w, fallback); return i.known ? `${i.label}限额` : i.label; };
const modelListOf = (g) => {
  const m = /Models within this group:\s*(.+)$/i.exec(g?.description || '');
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
// 用于检测"额度池结构变化"：只看池名与其包含的模型，不看 bucket（避免服务端偶发少返回某个窗口时误报）
const poolSigOf = (groups) => groups.map((g) => `${g.displayName}:${modelListOf(g).join('+')}`).sort().join('|');

function findBrainDir() {
  for (let d = DATA_DIR; d && d !== dirname(d); d = dirname(d)) {
    if (basename(d) === 'sidecar_data' && existsSync(join(dirname(d), 'brain'))) return join(dirname(d), 'brain');
  }
  const fallback = join(homedir(), '.gemini', 'antigravity', 'brain');
  return existsSync(fallback) ? fallback : null;
}

// ---------- 持久化 ----------
function load() {
  const empty = { settings: { ...DEFAULTS }, samples: [], meta: {}, titles: {}, alerts: {}, events: [] };
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf-8'));
    return {
      ...empty,
      ...d,
      titles: d.titles && typeof d.titles === 'object' ? d.titles : {},
      settings: { ...DEFAULTS, ...(d.settings || {}) },
    };
  } catch {
    return empty;
  }
}
let db = load();
for (const m of Object.values(db.meta || {})) {
  m.groupLabel ||= zhGroup(m.group);
  if (!m.winLabel) { const wi = winInfo(m.window); Object.assign(m, { winLabel: wi.label, winKnown: wi.known, winMs: wi.ms }); }
}
delete db.mark;
delete db.marks;
delete db.runs;

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FILE + '.tmp', JSON.stringify(db));
      renameSync(FILE + '.tmp', FILE);
    } catch (e) {
      console.error('[quota] save failed:', e.message);
    }
  }, 1500);
}

// ---------- 拉取 ----------
let live = { groups: [], description: '', fetchedAt: 0, error: null };
const frac = (b) => Math.max(0, Math.min(1, Number(b.remainingFraction ?? 0)));
const pct = (f) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;

async function lsrpc(method, body = {}) {
  const res = await fetch(`http://${LS}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': CSRF },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`语言服务器返回 ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  return j.response || j;
}

let trajCache = { at: 0, map: {} };
async function fetchTrajectories(force = false) {
  if (!force && Date.now() - trajCache.at < 30000 && Object.keys(trajCache.map).length) return trajCache.map;
  try {
    const r = await lsrpc('GetAllCascadeTrajectories');
    const map = r.trajectorySummaries || {};
    trajCache = { at: Date.now(), map };
    let dirty = false;
    for (const [id, info] of Object.entries(map)) {
      const t = (info?.annotations?.title || info?.summary || '').trim();
      if (t && db.titles[id] !== t) {
        db.titles[id] = t;
        dirty = true;
      }
    }
    if (dirty) save();
  } catch {}
  return trajCache.map;
}

let pollInFlight = null;
async function poll(force = false) {
  if (pollInFlight) return pollInFlight;
  pollInFlight = (async () => {
    try {
      const [r] = await Promise.all([lsrpc('RetrieveUserQuotaSummary'), fetchTrajectories(true)]);
      live = { groups: r.groups || [], description: r.description || '', fetchedAt: Date.now(), error: null };
      const v = {};
      for (const g of live.groups) {
        for (const b of g.buckets || []) {
          v[b.bucketId] = frac(b);
          const wi = winInfo(b.window, b.displayName);
          db.meta[b.bucketId] = { group: g.displayName, groupLabel: zhGroup(g.displayName), window: b.window, winLabel: wi.label, winKnown: wi.known, winMs: wi.ms, reset: b.resetTime };
        }
      }
      detectPoolChange();
      record(v, force);
      checkAlerts();
      return true;
    } catch (e) {
      live = { ...live, error: String(e.message || e) };
      return false;
    } finally {
      pollInFlight = null;
    }
  })();
  return pollInFlight;
}

function record(v, force) {
  const now = Date.now();
  const last = db.samples.at(-1);
  const changed = !last || Object.keys(v).some((k) => Math.abs((last.v[k] ?? -1) - v[k]) > 0.0002);
  if (!force && !changed && now - last.t < 10 * MIN) return;
  db.samples.push({ t: now, v });
  const out = [];
  let kept = 0;
  for (const s of db.samples) {
    if (now - s.t > 8 * DAY) continue;
    if (now - s.t > DAY && s.t - kept < 15 * MIN) continue;
    out.push(s);
    kept = s.t;
  }
  db.samples = out;
  save();
}

// ---------- 功能 1：消耗速率 / 曲线 ----------
function rateFor(id) {
  const now = Date.now();
  const pts = [];
  for (let i = db.samples.length - 1; i >= 0; i--) {
    const s = db.samples[i];
    if (s.v[id] === undefined || now - s.t > RATE_WINDOW) break;
    if (pts.length && s.v[id] < pts.at(-1).v - 0.04) break;
    pts.push({ t: s.t, v: s.v[id] });
  }
  if (pts.length < 2) return null;
  const dt = pts[0].t - pts.at(-1).t;
  if (dt < 4 * MIN) return null;
  const drop = pts.at(-1).v - pts[0].v;
  return drop > 0.001 ? (drop / dt) * HOUR : 0;
}

function seriesFor(id, window) {
  const span = Math.min(winInfo(window).ms, 7 * DAY);
  const now = Date.now();
  let pts = db.samples.filter((s) => now - s.t <= span && s.v[id] !== undefined).map((s) => [s.t, +s.v[id].toFixed(4)]);
  if (pts.length > 60) {
    const step = pts.length / 60;
    pts = Array.from({ length: 60 }, (_, i) => pts[Math.floor(i * step)]).concat([pts.at(-1)]);
  }
  return { span, pts };
}

// ---------- 功能 2：预警与恢复通知 ----------
function resetText(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return '即将重置';
  const m = Math.floor(ms / MIN), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return `${d ? `${d}天${h}小时` : h ? `${h}小时${m % 60}分` : `${m % 60}分钟`}后重置`;
}

function checkAlerts() {
  const th = db.settings.threshold / 100;
  let dirty = false;
  for (const g of live.groups) {
    for (const b of g.buckets || []) {
      const f = frac(b);
      const a = (db.alerts[b.bucketId] ||= {});
      const name = `${zhGroup(g.displayName)} · ${winName(b.window, b.displayName)}`;
      if (f < 0.05 && !a.crit) {
        a.crit = a.low = true;
        dirty = true;
        notify('额度即将用完', `${name} 仅剩 ${pct(f)}，${resetText(b.resetTime)}`);
      } else if (f < th && !a.low) {
        a.low = true;
        dirty = true;
        notify('额度偏低', `${name} 剩余 ${pct(f)}，${resetText(b.resetTime)}`);
      } else if (a.low && f >= RECOVER_AT) {
        a.low = a.crit = false;
        dirty = true;
        if (db.settings.notifyRecover) notify('额度已恢复', `${name} 已恢复到 ${pct(f)}`);
      }
    }
  }
  if (dirty) save();
}

function notify(title, body) {
  db.events.push({ t: Date.now(), title, body });
  db.events = db.events.slice(-20);
  save();
  if (!db.settings.notify) return;
  toast(title, body);
}

function toast(title, body) {
  if (process.platform === 'linux') {
    execFile(
      'notify-send',
      ['-a', 'Antigravity 额度速览', String(title), String(body)],
      { timeout: 10000 },
      (err) => err && console.error('[quota] toast failed:', err.message),
    );
    return;
  }
  if (process.platform !== 'win32') return;
  const x = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${x(title)}</text><text>${x(body)}</text></binding></visual></toast>`;
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$d = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$d.LoadXml('${xml}')`,
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($d))",
  ].join('\n');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20000 },
    (err) => err && console.error('[quota] toast failed:', err.message),
  );
}

// ---------- 功能 3：按「对话列表」自动统计并行任务油耗 ----------
// 模型 → 额度池：完全依据服务端实时返回的分组自动识别，不写死任何池名。
//   1. 精确匹配：模型 id 以分组内某个模型名（或分组名本身，如 "Gemini 4 Argon"）开头，取最长（最具体）的匹配；
//   2. 厂商兜底：按模型 id 的厂商前缀（gemini / claude / gpt ...）找包含同厂商模型最多的分组；
//   3. 仍无法识别时归入第一个分组。
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
let poolMemo = { sig: '', map: new Map() };
function poolOfModel(m) {
  const sig = poolSigOf(live.groups);
  if (poolMemo.sig !== sig) poolMemo = { sig, map: new Map() };
  if (poolMemo.map.has(m)) return poolMemo.map.get(m);
  const id = norm(m);
  const cands = live.groups.map((g) => ({ name: g.displayName, keys: [...modelListOf(g), g.displayName].map(norm).filter(Boolean) }));
  let best = null, bestLen = 0;
  for (const c of cands) for (const k of c.keys) if (id.startsWith(k) && k.length > bestLen) { best = c.name; bestLen = k.length; }
  if (!best) {
    const vendor = (/^[a-z]+/.exec(String(m || '').toLowerCase()) || [''])[0];
    let bestN = 0;
    for (const c of cands) {
      const n = c.keys.filter((k) => vendor && k.startsWith(vendor)).length;
      if (n > bestN) { best = c.name; bestN = n; }
    }
  }
  best ||= cands[0]?.name || '未知额度池';
  poolMemo.map.set(m, best);
  return best;
}

// 额度池结构变化检测：池子新增 / 消失 / 合并时记录提醒（例如 Argon 并入 Gemini 池）
function detectPoolChange() {
  if (!live.groups.length) return;
  const sig = poolSigOf(live.groups);
  const names = live.groups.map((g) => g.displayName);
  const prev = db.pools;
  db.pools = { sig, names };
  if (!prev || !prev.sig) return save();
  if (prev.sig === sig) return;
  const added = names.filter((n) => !prev.names.includes(n)).map(zhGroup);
  const removed = prev.names.filter((n) => !names.includes(n)).map(zhGroup);
  const parts = [];
  if (added.length) parts.push(`新增：${added.join('、')}`);
  if (removed.length) parts.push(`移除：${removed.join('、')}`);
  if (!parts.length) parts.push('池内包含的模型发生了调整');
  notify('额度池结构已变化', `现在共 ${names.length} 个额度池。${parts.join('；')}`);
}

const factorOfModel = (m) => (/flash|hydrogen/i.test(m) ? 0.25 : /opus|carbon/i.test(m) ? 2.5 : 1.0);
const shortModel = (m) =>
  String(m || '')
    .replace(/-(high|medium|low)$/i, '')
    .replace(/(\d)-(\d)/g, '$1.$2')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');

const transcriptCache = new Map(); // convId -> { offset, mtime, steps, modelSet, models, tokens, firstPrompt }
let lastTotalSteps = 0;

// 增量读取 transcript.jsonl：只读取上次 offset 之后新追加的字节，避免反复将整份大文件读入内存
function readTranscriptSteps(brainDir, id) {
  const empty = { steps: [], models: [], tokens: { input: 0, cache: 0, output: 0, total: 0 }, firstPrompt: '', mtime: 0 };
  if (!brainDir) return empty;
  const p = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
  let st;
  try {
    st = statSync(p);
  } catch {
    transcriptCache.delete(id);
    return empty;
  }
  let entry = transcriptCache.get(id);
  if (entry && entry.size === st.size && entry.mtime === st.mtimeMs) return entry;
  // 若文件被截断或首次读取，则从头初始化；若只是追加了新行，则仅从上次 offset 读取新增字节
  if (!entry || st.size < entry.offset) {
    entry = { offset: 0, size: 0, mtime: 0, steps: [], modelSet: new Set(), models: [], tokens: { input: 0, cache: 0, output: 0, total: 0 }, firstPrompt: '' };
  }
  const toRead = st.size - entry.offset;
  if (toRead > 0) {
    let fd;
    try {
      fd = openSync(p, 'r');
      const buf = Buffer.allocUnsafe(toRead);
      const bytes = readSync(fd, buf, 0, toRead, entry.offset);
      const chunk = buf.toString('utf-8', 0, bytes);
      const lastNL = chunk.lastIndexOf('\n');
      const complete = lastNL >= 0 ? chunk.slice(0, lastNL + 1) : chunk;
      entry.offset += Buffer.byteLength(complete, 'utf-8');
      for (const line of complete.split('\n')) {
        if (!entry.firstPrompt && line.includes('"USER_INPUT"')) {
          try {
            const u = JSON.parse(line);
            const m = /<USER_REQUEST>\s*([^\r\n<]+)/.exec(u.content || '');
            if (m) entry.firstPrompt = m[1].trim().slice(0, 28);
          } catch {}
        }
        if (!line.includes('"PLANNER_RESPONSE"')) continue;
        const obj = JSON.parse(line);
        if (obj.type !== 'PLANNER_RESPONSE' || !obj.model) continue;
        const t = Date.parse(obj.created_at) || 0;
        const inp = Number(obj.input_tokens || 0);
        const cache = Number(obj.cache_read_tokens || 0);
        const out = Number(obj.output_tokens || 0);
        entry.tokens.input += inp;
        entry.tokens.cache += cache;
        entry.tokens.output += out;
        entry.tokens.total += inp + cache + out;
        const w = Math.max(200, (inp + cache * 0.1 + out * 4) * factorOfModel(obj.model));
        entry.steps.push({ t, model: obj.model, w });
        entry.modelSet.add(shortModel(obj.model));
      }
      entry.models = [...entry.modelSet];
    } catch {} finally {
      if (fd !== undefined) try { closeSync(fd); } catch {}
    }
  }
  entry.size = st.size;
  entry.mtime = st.mtimeMs;
  transcriptCache.set(id, entry);
  return entry;
}

function extractDrops(sinceT = 0) {
  const samples = db.samples;
  if (!samples.length) return [];
  const buckets = Object.keys(db.meta);
  const runMin = {};
  const drops = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    for (const b of buckets) {
      const val = s.v[b];
      if (val === undefined) continue;
      if (runMin[b] === undefined) {
        runMin[b] = val;
        if (sinceT <= 0 && i === 0 && 1 - val > 0.0005) {
          drops.push({ t0: 0, t1: s.t, bucket: b, pool: db.meta[b].group, window: db.meta[b].window, drop: 1 - val, pre: true, reset: false });
        }
        continue;
      }
      let drop = 0, reset = false;
      if (val < runMin[b]) {
        drop = runMin[b] - val;
        runMin[b] = val;
      } else if (val > runMin[b] + 0.04) {
        drop = Math.max(0, 1 - val);
        runMin[b] = val;
        reset = true;
      }
      if (drop > 0.0001 && s.t > sinceT) {
        const t0 = Math.max(sinceT, samples[i - 1].t);
        drops.push({ t0, t1: s.t, bucket: b, pool: db.meta[b].group, window: db.meta[b].window, drop, pre: false, reset });
      }
    }
  }
  return drops;
}

function resolveTitle(id, info, firstPrompt) {
  const liveTitle = (info?.annotations?.title || info?.summary || '').trim();
  if (liveTitle) {
    if (db.titles[id] !== liveTitle) {
      db.titles[id] = liveTitle;
      save();
    }
    return liveTitle;
  }
  if (db.titles[id]) return db.titles[id];
  if (firstPrompt) return firstPrompt;
  return `对话 ${id.slice(0, 6)}`;
}

let convStatsCache = { sig: '', list: [] };

function buildConversationStats() {
  const brainDir = findBrainDir();
  const summaries = trajCache.map || {};
  const diskDirs = brainDir ? readdirSync(brainDir).filter((d) => /^[0-9a-f-]{20,}$/i.test(d)) : [];
  // 清理已删除对话的缓存，防止长期运行内存增长
  const activeIdSet = new Set([...Object.keys(summaries), ...diskDirs]);
  for (const cachedId of transcriptCache.keys()) {
    if (!activeIdSet.has(cachedId)) transcriptCache.delete(cachedId);
  }

  // 先增量刷新各对话 transcript，并生成数据指纹；若指纹未变则直接复用上次归属计算结果
  const sigParts = [`s:${db.samples.length}:${db.samples.at(-1)?.t || 0}`];
  for (const id of activeIdSet) {
    const tr = readTranscriptSteps(brainDir, id);
    const info = summaries[id];
    sigParts.push(`${id}:${tr.size || 0}:${info?.status || ''}:${info?.annotations?.title || info?.summary || ''}`);
  }
  const sig = sigParts.join('|');
  if (sig === convStatsCache.sig && convStatsCache.list.length) {
    const now = Date.now();
    return convStatsCache.list.map((c) => ({ ...c, active: c.status === 'running' || now - c.updatedAt < 45 * MIN }));
  }

  const convMap = new Map();

  for (const [id, info] of Object.entries(summaries)) {
    const rootId = info.trajectoryMetadata?.rootConversationId || id;
    if (rootId !== id) continue;
    const status = info.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'running' : 'idle';
    const createdAt = Date.parse(info.createdTime) || 0;
    const updatedAt = Date.parse(info.lastModifiedTime || info.lastUserInputTime || info.createdTime) || 0;
    convMap.set(id, {
      id,
      info,
      title: resolveTitle(id, info, ''),
      status,
      createdAt,
      updatedAt,
      stepCount: info.stepCount || 0,
      steps: [],
      models: new Set(),
      tokens: { input: 0, cache: 0, output: 0, total: 0 },
      used: {},
      resets: {},
    });
  }

  const ids = new Set([...convMap.keys(), ...(brainDir ? readdirSync(brainDir).filter((d) => /^[0-9a-f-]{20,}$/i.test(d)) : [])]);
  let totalStepsNow = 0;
  for (const id of ids) {
    const info = summaries[id];
    const rootId = info?.trajectoryMetadata?.rootConversationId || id;
    const { steps, models, tokens, firstPrompt } = readTranscriptSteps(brainDir, id);
    if (!convMap.has(rootId)) {
      if (!steps.length && !info) continue;
      convMap.set(rootId, {
        id: rootId,
        info,
        title: resolveTitle(rootId, info, firstPrompt),
        status: info?.status === 'CASCADE_RUN_STATUS_RUNNING' ? 'running' : 'idle',
        createdAt: 0,
        updatedAt: 0,
        stepCount: 0,
        steps: [],
        models: new Set(),
        tokens: { input: 0, cache: 0, output: 0, total: 0 },
        used: {},
        resets: {},
      });
    }
    const target = convMap.get(rootId);
    if (rootId === id) target.title = resolveTitle(rootId, target.info || info, firstPrompt);
    target.steps.push(...steps);
    totalStepsNow += steps.length;
    for (const m of models) target.models.add(m);
    target.tokens.input += tokens.input;
    target.tokens.cache += tokens.cache;
    target.tokens.output += tokens.output;
    target.tokens.total += tokens.total;
    if (steps.length) {
      const firstT = steps[0].t, lastT = steps.at(-1).t;
      if (!target.createdAt || (firstT && firstT < target.createdAt)) target.createdAt = firstT;
      if (lastT > target.updatedAt) target.updatedAt = lastT;
    }
  }

  // 若检测到对话刚刚产生了新的模型调用步数，且距上次额度拉取 >15s，异步触发一次即时额度采样
  if (lastTotalSteps > 0 && totalStepsNow > lastTotalSteps && Date.now() - live.fetchedAt > 15e3) {
    poll(false);
  }
  lastTotalSteps = totalStepsNow;

  const allDrops = extractDrops(0);
  for (const d of allDrops) {
    const weights = new Map();
    let sum = 0;
    const winStart = d.pre ? d.t1 - Math.min(winInfo(d.window).ms, 7 * DAY) : d.t0 - 120e3;
    const winEnd = d.t1 + 45e3;
    for (const [id, c] of convMap.entries()) {
      const w = c.steps.filter((st) => poolOfModel(st.model) === d.pool && st.t >= winStart && st.t <= winEnd).reduce((a, x) => a + x.w, 0);
      if (w > 0) {
        weights.set(id, w);
        sum += w;
      }
    }
    if (!sum && !d.pre) {
      for (const [id, c] of convMap.entries()) {
        const w = c.steps.filter((st) => poolOfModel(st.model) === d.pool && st.t >= d.t0 - 20 * MIN && st.t <= d.t1 + 60e3).reduce((a, x) => a + x.w, 0);
        if (w > 0) {
          weights.set(id, w);
          sum += w;
        }
      }
    }
    if (sum > 0) {
      for (const [id, w] of weights.entries()) {
        const c = convMap.get(id);
        c.used[d.bucket] = (c.used[d.bucket] || 0) + d.drop * (w / sum);
        if (d.reset) c.resets[d.bucket] = true;
      }
    }
  }

  const now = Date.now();
  const list = [...convMap.values()]
    .map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      active: c.status === 'running' || now - c.updatedAt < 45 * MIN,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      modelSteps: c.steps.length,
      models: [...c.models],
      tokens: c.tokens,
      used: c.used,
      resets: c.resets,
    }))
    .sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.updatedAt - a.updatedAt);
  convStatsCache = { sig, list };
  return list;
}

// ---------- 对外状态 ----------
function state() {
  const groups = live.groups.map((g) => ({
    name: g.displayName,
    label: zhGroup(g.displayName),
    models: modelListOf(g).length ? modelListOf(g) : [g.displayName],
    description: g.description || '',
    buckets: (g.buckets || []).map((b) => ({
      id: b.bucketId,
      window: b.window,
      label: b.displayName,
      winLabel: winInfo(b.window, b.displayName).label,
      winKnown: winInfo(b.window, b.displayName).known,
      winMs: winInfo(b.window, b.displayName).ms,
      frac: frac(b),
      reset: b.resetTime,
      ratePerHour: rateFor(b.bucketId),
      series: seriesFor(b.bucketId, b.window),
    })),
  }));
  return {
    groups,
    description: live.description,
    fetchedAt: live.fetchedAt,
    error: live.error,
    settings: db.settings,
    meta: db.meta,
    conversations: buildConversationStats(),
    events: db.events.slice(-10).reverse(),
    now: Date.now(),
  };
}

// ---------- 轮询 ----------
let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await poll();
    schedule();
  }, db.settings.pollMin * MIN);
}

// ---------- 路由 ----------
const app = new SidecarApp();
app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.api('/api/state', async () => {
  await fetchTrajectories(false);
  return state();
}, 'GET');

let lastManual = 0;
app.api('/api/refresh', async () => {
  if (Date.now() - lastManual > 3e3) {
    lastManual = Date.now();
    await poll(true);
  } else {
    await fetchTrajectories(true);
  }
  return state();
});

app.api('/api/settings', (d) => {
  const s = db.settings;
  if (d.threshold !== undefined) s.threshold = Math.min(60, Math.max(5, Math.round(Number(d.threshold) || DEFAULTS.threshold)));
  if (d.pollMin !== undefined && [1, 2, 5, 10].includes(Number(d.pollMin))) s.pollMin = Number(d.pollMin);
  if (d.notify !== undefined) s.notify = !!d.notify;
  if (d.notifyRecover !== undefined) s.notifyRecover = !!d.notifyRecover;
  save();
  schedule();
  return state();
});

app.api('/api/test-notify', () => {
  toast('额度速览', '通知测试：额度变化时会这样提醒你');
  return { ok: true };
});

app.run();
poll().then(schedule);
