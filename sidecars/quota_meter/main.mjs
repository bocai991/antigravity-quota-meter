// 额度速览 sidecar
//
// 轻量设计：
//   * 不调用任何模型、不消耗 token：只读本地语言服务器的 RetrieveUserQuotaSummary。
//   * 后台默认每 2 分钟拉取一次（可调），面板只读缓存，不额外触发请求。
//   * 历史只在数值变化时记录，24 小时前的数据稀疏化，8 天前的删除，文件通常 < 200 KB。
//   * 系统通知只在跨越阈值时触发一次（Windows 通过 PowerShell toast，用完即退出）。
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const GROUP_ZH = { 'Gemini Models': 'Gemini 模型', 'Claude and GPT models': 'Claude 与 GPT 模型', 'Gemini 4 Argon': 'Gemini 4 Argon' };
const WIN_ZH = { '5h': '5 小时限额', weekly: '每周限额' };

// ---------- 持久化 ----------
function load() {
  const empty = { settings: { ...DEFAULTS }, samples: [], meta: {}, mark: null, runs: [], alerts: {}, events: [] };
  try {
    const d = JSON.parse(readFileSync(FILE, 'utf-8'));
    return { ...empty, ...d, settings: { ...DEFAULTS, ...(d.settings || {}) } };
  } catch {
    return empty;
  }
}
let db = load();
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
const frac = (b) => Math.max(0, Math.min(1, Number(b.remainingFraction ?? 0))); // proto3 JSON 省略 0
const pct = (f) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;

async function fetchQuota() {
  const res = await fetch(`http://${LS}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': CSRF },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`语言服务器返回 ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  return j.response || j;
}

async function poll(force = false) {
  try {
    const r = await fetchQuota();
    live = { groups: r.groups || [], description: r.description || '', fetchedAt: Date.now(), error: null };
    const v = {};
    for (const g of live.groups) {
      for (const b of g.buckets || []) {
        v[b.bucketId] = frac(b);
        db.meta[b.bucketId] = { group: g.displayName, window: b.window, reset: b.resetTime };
      }
    }
    record(v, force);
    checkAlerts();
    return true;
  } catch (e) {
    live = { ...live, error: String(e.message || e) };
    return false;
  }
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
    if (pts.length && s.v[id] < pts.at(-1).v - 0.15) break; // 中间发生过大幅回血重置
    pts.push({ t: s.t, v: s.v[id] });
  }
  if (pts.length < 2) return null;
  const dt = pts[0].t - pts.at(-1).t;
  if (dt < 4 * MIN) return null;
  const drop = pts.at(-1).v - pts[0].v;
  return drop > 0.001 ? (drop / dt) * HOUR : 0; // 每小时消耗的比例（忽略 <0.1% 的轻微抖动）
}

function seriesFor(id, window) {
  const span = window === '5h' ? 5 * HOUR : 7 * DAY;
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
      const name = `${GROUP_ZH[g.displayName] || g.displayName} · ${WIN_ZH[b.window] || b.displayName}`;
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

// ---------- 功能 3：任务油耗计量 ----------
// 按段计算净下降量：忽略服务端轻微上下抖动（<15%），只有大幅回升（>15%，即发生重置）才分段累加。
function usedSince(mark) {
  const used = {}, resets = {};
  const segStart = { ...mark.v }, segMin = { ...mark.v }, last = { ...mark.v };
  for (const k of Object.keys(segStart)) used[k] = 0;
  for (const s of db.samples) {
    if (s.t <= mark.t) continue;
    for (const [k, val] of Object.entries(s.v)) {
      if (segStart[k] === undefined) continue;
      if (val > segMin[k] + 0.15) {
        used[k] += Math.max(0, segStart[k] - segMin[k]);
        segStart[k] = segMin[k] = val;
        resets[k] = true;
      } else {
        if (val < segMin[k]) segMin[k] = val;
      }
      last[k] = val;
    }
  }
  for (const k of Object.keys(segStart)) {
    used[k] += Math.max(0, segStart[k] - last[k]);
  }
  return { used, resets };
}

// ---------- 对外状态 ----------
function state() {
  const groups = live.groups.map((g) => ({
    name: g.displayName,
    description: g.description || '',
    buckets: (g.buckets || []).map((b) => ({
      id: b.bucketId,
      window: b.window,
      label: b.displayName,
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
    mark: db.mark ? { ...db.mark, ...usedSince(db.mark) } : null,
    runs: db.runs,
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
app.api('/api/state', () => state(), 'GET');

let lastManual = 0;
app.api('/api/refresh', async () => {
  if (Date.now() - lastManual > 10e3) {
    lastManual = Date.now();
    await poll(true);
  }
  return state();
});

app.api('/api/mark', async (d) => {
  if (d.action === 'start') {
    if (!(await poll(true))) return { error: live.error };
    db.mark = { t: Date.now(), label: String(d.label || '').slice(0, 60), v: { ...db.samples.at(-1).v } };
  } else if (d.action === 'stop' && db.mark) {
    await poll(true);
    const { used, resets } = usedSince(db.mark);
    db.runs.unshift({ label: db.mark.label, start: db.mark.t, end: Date.now(), used, resets });
    db.runs = db.runs.slice(0, 15);
    db.mark = null;
  } else if (d.action === 'cancel') {
    db.mark = null;
  } else if (d.action === 'clearRuns') {
    db.runs = [];
  }
  save();
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
