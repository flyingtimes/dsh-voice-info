/**
 * dsh-voice-info — 语音播报插件（服务端）。
 *
 * 监听主对话的 turn/end，用 ble-speaker 连接（并保持）蓝牙音箱播放语音通知。
 *
 * 能力总览：
 * 1) 情境化播报  detail: fixed | template | excerpt | llm（逐级兜底）
 * 2) 免打扰      静音时段 quietHours / 冷却 cooldownMs / goal 续跑感知
 * 3) 可靠性      本机回退 / 连接保活 / 自检路由
 * 4) 阻塞提醒    reason=blocked（agent 在等用户确认）视为紧急：
 *                豁免冷却与时长门槛；静音时段按 blockedQuietPolicy 处理
 *                （skip=照常跳过 / local=切到本机扬声器播 / speaker=照播音箱）
 * 5) 过夜摘要    静音时段的播报入队，静音结束时刻汇总一次播报（LLM 压缩）
 * 6) GUI 配置    GET/POST /plugin-api/voice-info/config 实时读写配置（免重启）
 *
 * 工程约束：
 * - 播报完全旁路（不 await、失败只写日志），绝不影响对话主流程。
 * - 播放用 --keep --no-restore：连接保持、蓝牙不关。
 * - 串行队列：上一次播报没结束时新触发合并为一次。
 * - config 是存活对象：POST 路由就地修改，所有持有者立即可见
 *   （quietHours 每次判定时重解析；keepAlive 定时器仍需重启生效）。
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEST_PATH = '/plugin-api/voice-info/test';
const CONFIG_PATH = '/plugin-api/voice-info/config';
const DIGEST_FILE = path.join(PLUGIN_ROOT, 'digest-queue.json');
const CHIME_FILE = path.join(PLUGIN_ROOT, 'assets', 'dingdong.wav');

const DEFAULTS = {
  enabled: true,
  // 默认假定 ble-speaker 克隆在本插件旁边（../ble-speaker）；实际以 config.json 为准
  bleSpeakerDir: path.resolve(PLUGIN_ROOT, '..', 'ble-speaker'),
  device: 'airplus',
  keepConnection: true,
  announceOn: ['completed', 'blocked'],
  skipSubagents: true,
  minDurationMs: 60_000,
  volume: 1,
  logFile: '/tmp/dsh-voice-info.log',
  timeoutMs: 180_000,

  // 情境化播报
  detail: 'llm', // fixed | template | excerpt | llm
  text: '主人，我的任务完成了',
  templates: {
    completed: '主人，我的任务完成了，用时{duration}',
    error: '主人，任务出错了，用时{duration}',
    'max-tokens': '主人，任务达到长度上限',
    aborted: '主人，任务被中止了',
    blocked: '主人，我在等你确认，请回来处理',
    default: '主人，这一轮结束了，用时{duration}',
  },
  excerptPrefix: '主人，任务完成了：',
  llmPrefix: '主人，任务完成了。',
  llmMaxChars: 40,

  // 免打扰
  quietHours: ['01:00', '07:00'],
  cooldownMs: 90_000,
  goalAware: true,
  goalDebounceMs: 90_000,

  // 可靠性
  fallbackLocal: true,
  speakerRetries: 1, // 音箱连接尝试次数：失败立即降级本机，避免长重试拖慢播报
  keepAlive: false,
  keepAliveIntervalMs: 120_000,

  // 阻塞提醒（agent 等用户确认）
  blockedQuietPolicy: 'local', // skip | local | speaker
  blockedBypassCooldown: true,

  // 迟到通知治理
  cancelOnNewTurn: true, // 用户新开一轮时取消未播/播报中的旧通知

  // 预热与在场感知
  prewarm: true, // 轮次进行中后台预连音箱，turn/end 时秒出声
  afkSkipMs: 30_000, // 键鼠空闲低于该值视为"在场"，跳过非紧急播报；0=禁用

  // 提示音（叮咚）——先出提示音再出人声，缓解语音突兀
  chime: true,
  chimeDelayMs: 2_000,
  chimeFile: '', // 自定义提示音路径；空 = 内置合成的 assets/dingdong.wav

  // 语音引擎（cosyvoice = 本地 cosyvoice-server，音色自然；失败自动回退系统 say）
  ttsEngine: 'cosyvoice', // local | cosyvoice
  ttsVoice: 'f_young_soft', // cosyvoice 音色名（GET /plugin-api/voice-info/voices 可列全部）
  ttsSpeed: 1.0, // cosyvoice 语速倍率
  ttsUrl: 'http://127.0.0.1:9880',

  // 过夜摘要
  overnightDigest: true,
  digestMaxEntries: 100,
};

const TURN_REASONS = ['completed', 'max-tokens', 'blocked', 'aborted', 'error'];

/* ---------------- 基础工具 ---------------- */

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'config.json'), 'utf8'));
    return { ...DEFAULTS, ...raw, templates: { ...DEFAULTS.templates, ...(raw.templates || {}) } };
  } catch {
    return { ...DEFAULTS, templates: { ...DEFAULTS.templates } };
  }
}

/** 把存活配置持久化回 config.json（保留 _comment） */
function persistConfig(config) {
  const file = path.join(PLUGIN_ROOT, 'config.json');
  let comment = {};
  try { comment = JSON.parse(readFileSync(file, 'utf8'))._comment || {}; } catch { /* 新文件 */ }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'templates') continue;
    if (config[k] !== undefined) out[k] = config[k];
  }
  out.templates = { ...config.templates };
  out._comment = comment;
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
}

function logLine(config, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { console.log(`[voice-info] ${message}`); } catch { /* ignore */ }
  try {
    import('node:fs').then((fs) => fs.appendFileSync(config.logFile, line)).catch(() => {});
  } catch { /* ignore */ }
}

/** 通用子进程执行（永不抛出，返回 {ok, exitCode, stdout, stderr}；signal 中止→exitCode='aborted'） */
function runCommand(cmd, args, { cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener?.('abort', onAbort);
      resolve({ ok, exitCode: code, stdout, stderr: stderr.slice(-1500) });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(false, 'timeout');
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(false, 'aborted');
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener?.('abort', onAbort);
    }
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: 'spawn-error', stdout, stderr: String(err?.message || err) });
    });
    child.on('close', (code) => finish(code === 0, code));
  });
}

/* ---------------- 情境化播报文本 ---------------- */

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}小时${m}分钟` : `${h}小时`;
}

function sanitizeForSpeech(input, maxChars = 60) {
  let s = String(input || '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!?\[[^\]]*\]\([^)]*\)/g, '链接');
  s = s.replace(/https?:\/\/\S+/g, '链接');
  s = s.replace(/[#*_>|~\[\]()#-]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const m = /[。！？；;.!?]/.exec(s);
  if (m && m.index > 4 && m.index + 1 <= maxChars) s = s.slice(0, m.index + 1);
  if (s.length > maxChars) s = s.slice(0, maxChars - 1) + '…';
  return s.trim();
}

function extractText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((b) => b?.type === 'text').map((b) => b?.text || '').join(' ').trim();
}

function renderTemplate(tpl, durationMs) {
  const d = formatDuration(durationMs);
  let out = String(tpl || '').replace(/\{duration\}/g, d);
  if (!d) out = out.replace(/[，,]\s*用时\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return out;
}

function resolveLlmRoute(ctx) {
  try {
    const def = ctx.get('agentDefaultModel');
    if (def && typeof def.currentSelection === 'function') {
      const sel = def.currentSelection();
      if (sel?.provider && sel?.model) return { provider: sel.provider, model: sel.model };
    }
  } catch { /* fall through */ }
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
}

/** 组装模型流为文本 */
function assembleStreamText(chunks) {
  const byIndex = new Map();
  const order = [];
  for (const c of chunks) {
    if (c.type === 'block-start' && !byIndex.has(c.index)) { byIndex.set(c.index, ''); order.push(c.index); }
    else if (c.type === 'text-delta') {
      if (!byIndex.has(c.index)) { byIndex.set(c.index, ''); order.push(c.index); }
      byIndex.set(c.index, byIndex.get(c.index) + (c.text || ''));
    } else if (c.type === 'block-end') {
      if (!byIndex.has(c.index)) order.push(c.index);
      byIndex.set(c.index, c.block?.type === 'text' ? c.block.text || '' : '');
    }
  }
  return order.sort((a, b) => a - b).map((i) => byIndex.get(i)).join('').trim();
}

/** 一次小 LLM 调用；失败返回空串（调用方走兜底） */
async function llmOnce(ctx, { system, prompt, maxChars }) {
  const llm = (() => { try { return ctx?.llm ?? null; } catch { return null; } })();
  if (!llm) return '';
  const route = resolveLlmRoute(ctx);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const chunks = [];
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 300,
      signal: ac.signal,
    })) {
      if (ac.signal.aborted) break;
      chunks.push(chunk);
    }
    return sanitizeForSpeech(assembleStreamText(chunks), maxChars);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function buildAnnounceText(ctx, config, { reason, durationMs, material }) {
  const tpl = (r) => renderTemplate(config.templates[r] || config.templates.default, durationMs);
  try {
    if (config.detail === 'llm' && material) {
      const s = await llmOnce(ctx, {
        system: '你是语音播报文案生成器，只输出一句适合朗读的中文。',
        prompt: [
          `把下面这轮编程助手的工作压缩成一句不超过${config.llmMaxChars}字的中文语音播报，`,
          '口语化、说结果（改了什么/修好了什么/交付了什么），不要标点堆叠，不要开头结尾客套，直接输出这句话。',
          '材料：',
          `用户要求：${material.userText || '(无)'}`,
          `助手最终回复：${material.assistantText || '(无)'}`,
          `用时：${formatDuration(material.durationMs) || '未知'}`,
        ].join('\n'),
        maxChars: config.llmMaxChars,
      });
      if (s) return `${config.llmPrefix}${s}`;
    }
    if ((config.detail === 'excerpt' || config.detail === 'llm') && material?.assistantText) {
      const s = sanitizeForSpeech(material.assistantText);
      if (s) return `${config.excerptPrefix}${s}`;
    }
    if (config.detail === 'fixed') return config.text;
    return tpl(reason);
  } catch {
    return config.text;
  }
}

/* ---------------- 静音时段 ---------------- */

function parseQuietHours(config) {
  const [a, b] = Array.isArray(config.quietHours) ? config.quietHours : [];
  const pm = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const [h, min] = [Number(m[1]), Number(m[2])];
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const s = pm(a);
  const e = pm(b);
  if (s === null || e === null || s === e) return null;
  return { start: s, end: e };
}

function inQuietHours(qh, now = new Date()) {
  if (!qh) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return qh.start < qh.end
    ? cur >= qh.start && cur < qh.end
    : cur >= qh.start || cur < qh.end; // 跨零点
}

/** 距下一个 HH:mm 边界的毫秒数（已过则明天） */
function msUntilNextOccurrence(minutes, now = new Date()) {
  const target = new Date(now);
  target.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/* ---------------- 播放执行 ---------------- */

const cliPath = (config) => path.join(config.bleSpeakerDir, 'src', 'cli.js');

/** 用户键鼠空闲时长（ms）；非 darwin 或读取失败返回 null（视为未知，不拦截） */
async function getUserIdleMs() {
  if (Number.isFinite(Number(process.env.VI_TEST_IDLE_MS))) return Number(process.env.VI_TEST_IDLE_MS);
  if (process.platform !== 'darwin') return null;
  const r = await runCommand('sh', ['-c', "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'"], { timeoutMs: 3000 });
  if (!r.ok) return null;
  const ns = Number(String(r.stdout).trim());
  return Number.isFinite(ns) && ns >= 0 ? Math.round(ns / 1e6) : null;
}

/** 用户在场（最近 afkSkipMs 内有键鼠操作）→ 语音通知无意义 */
async function isUserPresent(config) {
  if (!config.afkSkipMs || config.afkSkipMs <= 0) return false;
  const idle = await getUserIdleMs();
  return idle !== null && idle < config.afkSkipMs;
}

/** 后台预连音箱：轮次进行中把连接建立好，播报时秒出声 */
function createPrewarmer(config) {
  let inFlight = false;
  let lastDoneAt = 0;
  return {
    async warm(reason) {
      if (!config.prewarm || inFlight) return;
      if (Date.now() - lastDoneAt < 60_000) return; // 1 分钟内不重复预热
      const qh = parseQuietHours(config);
      if (inQuietHours(qh) && config.blockedQuietPolicy !== 'speaker') return; // 静音期不出声，预热无意义
      inFlight = true;
      const started = Date.now();
      try {
        const r = await runCommand(process.execPath,
          [cliPath(config), 'connect', config.device, '--retries', String(config.speakerRetries ?? 1)],
          { cwd: config.bleSpeakerDir, timeoutMs: 60_000 });
        lastDoneAt = Date.now();
        if (r.ok) logLine(config, `预热成功 (${((Date.now() - started) / 1000).toFixed(1)}s, ${reason}): 音箱已就绪`);
        else logLine(config, `预热失败 (${reason}): 音箱不可达，播报时将走本机回退`);
      } finally {
        inFlight = false;
      }
    },
  };
}

/** 有效的提示音文件路径（chime 关闭或文件缺失返回 ''） */
function effectiveChime(config) {
  if (!config.chime) return '';
  return config.chimeFile && String(config.chimeFile).trim() ? String(config.chimeFile).trim() : CHIME_FILE;
}

/** TTS 引擎标志（cosyvoice 时传给 ble-speaker CLI） */
function ttsFlags(config) {
  if (config.ttsEngine !== 'cosyvoice') return [];
  const flags = ['--engine', 'cosyvoice', '--voice', String(config.ttsVoice || '专业播客女生')];
  if (Number.isFinite(config.ttsSpeed) && config.ttsSpeed > 0) flags.push('--speed', String(config.ttsSpeed));
  if (config.ttsUrl) flags.push('--tts-url', String(config.ttsUrl));
  return flags;
}

function announceOnce(config, text, signal) {
  const args = [cliPath(config), 'run', config.device, '--text', text, '--volume', String(config.volume), '--retries', String(config.speakerRetries ?? 1), ...ttsFlags(config)];
  const chime = effectiveChime(config);
  if (chime) args.push('--chime', chime, '--chime-delay', String(config.chimeDelayMs ?? 2000));
  if (config.keepConnection) args.push('--keep', '--no-restore');
  return runCommand(process.execPath, args, { cwd: config.bleSpeakerDir, timeoutMs: config.timeoutMs, signal });
}

async function fallbackPlayLocal(config, text) {
  const chime = effectiveChime(config);
  const args = [cliPath(config), 'play', '--text', text, '--volume', String(config.volume), ...ttsFlags(config)];
  if (chime) args.push('--chime', chime, '--chime-delay', String(config.chimeDelayMs ?? 2000));
  const r1 = await runCommand(process.execPath, args, { cwd: config.bleSpeakerDir, timeoutMs: 180_000 });
  if (r1.ok) return { ok: true, via: 'ble-speaker-play' };
  if (process.platform === 'darwin') {
    // 最末级兜底：直接 say（也先出提示音）
    if (chime) {
      await runCommand('afplay', ['-v', String(Math.max(0, Math.min(1, config.volume))), chime], { timeoutMs: 30_000 }).catch(() => {});
      if (config.chimeDelayMs > 0) await new Promise((r) => setTimeout(r, Math.min(config.chimeDelayMs, 10_000)));
    }
    const r2 = await runCommand('say', [text], { timeoutMs: 60_000 });
    if (r2.ok) return { ok: true, via: 'say' };
  }
  return { ok: false, via: 'none' };
}

/** 名称粗匹配：当前系统输出是否像我们的蓝牙设备 */
function nameLooksLikeDevice(outputName, deviceName) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const a = norm(outputName);
  const b = norm(deviceName);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

/**
 * 强制本机播放（不经过蓝牙音箱）：若当前系统输出是我们的蓝牙设备，
 * 临时切到其他输出 → say → 切回。用于静音时段的阻塞提醒。
 */
async function speakOnMacOutput(config, text) {
  let prev = null;
  try {
    const cur = await runCommand('SwitchAudioSource', ['-t', 'output', '-c'], { timeoutMs: 5000 });
    const currentName = (cur.stdout || '').trim();
    if (cur.ok && currentName && nameLooksLikeDevice(currentName, config.device)) {
      const list = await runCommand('SwitchAudioSource', ['-a', '-t', 'output'], { timeoutMs: 5000 });
      const candidates = (list.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const alt = candidates.find((n) => !nameLooksLikeDevice(n, config.device) && !/bluetooth|蓝牙/i.test(n));
      if (alt) {
        const sw = await runCommand('SwitchAudioSource', ['-t', 'output', '-s', alt], { timeoutMs: 5000 });
        if (sw.ok) {
          prev = currentName;
          logLine(config, `阻塞提醒：输出临时切换 ${currentName} → ${alt}`);
        }
      }
    }
  } catch { /* 切换失败就原样播 */ }
  // 提示音先行（输出切换完成后播放，保证从同一设备出声）
  const chime = effectiveChime(config);
  if (chime && process.platform === 'darwin') {
    await runCommand('afplay', ['-v', String(Math.max(0, Math.min(1, config.volume))), chime], { timeoutMs: 30_000 }).catch(() => {});
    if (config.chimeDelayMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(config.chimeDelayMs, 10_000)));
    }
  }
  let ok = false;
  if (process.platform === 'darwin') {
    // 优先走 ble-speaker play（带 cosyvoice 引擎与缓存），失败再裸 say
    const args = [cliPath(config), 'play', '--text', text, '--volume', String(config.volume), ...ttsFlags(config)];
    const r = await runCommand(process.execPath, args, { cwd: config.bleSpeakerDir, timeoutMs: 180_000 });
    ok = r.ok;
    if (!ok) {
      const r2 = await runCommand('say', [text], { timeoutMs: 60_000 });
      ok = r2.ok;
    }
  } else {
    const r = await runCommand(process.execPath, [cliPath(config), 'play', '--text', text], { cwd: config.bleSpeakerDir, timeoutMs: 90_000 });
    ok = r.ok;
  }
  if (prev) {
    const back = await runCommand('SwitchAudioSource', ['-t', 'output', '-s', prev], { timeoutMs: 5000 });
    if (back.ok) logLine(config, `阻塞提醒：输出已切回 ${prev}`);
  }
  return ok;
}

/* ---------------- 过夜摘要 ---------------- */

function createDigest(ctx, config, announcer) {
  let queue = [];
  let timer = null;
  try { queue = JSON.parse(readFileSync(DIGEST_FILE, 'utf8')); if (!Array.isArray(queue)) queue = []; } catch { queue = []; }

  const persist = () => {
    try { writeFileSync(DIGEST_FILE, JSON.stringify(queue.slice(-config.digestMaxEntries))); } catch { /* ignore */ }
  };

  async function buildText() {
    const entries = queue.slice();
    if (config.detail === 'llm' && entries.length > 1) {
      const s = await llmOnce(ctx, {
        system: '你是语音播报文案生成器，只输出一段适合朗读的中文。',
        prompt: [
          `用户夜里设置了静音时段，期间有${entries.length}条被静音的任务播报。把要点合并成不超过60字的一段中文，`,
          '说明完成了几个任务、有没有出错或还在等确认，口语化，直接输出内容。',
          '条目：',
          ...entries.map((e, i) => `${i + 1}. [${e.reason}] ${e.text}`),
        ].join('\n'),
        maxChars: 80,
      });
      if (s) return `主人，早上好。${s}`;
    }
    const needAttention = entries.filter((e) => e.reason === 'error' || e.reason === 'blocked').length;
    let s = `主人，早上好。夜里静音期间共有${entries.length}次任务播报被存入摘要`;
    if (needAttention) s += `，其中${needAttention}次出错或在等确认，需要你看一下`;
    return s;
  }

  async function fire() {
    if (!queue.length) { schedule(); return; }
    const entries = queue.slice();
    const text = await buildText();
    queue = [];
    persist();
    logLine(config, `过夜摘要播报: ${text}`);
    const outcome = await announcer.trigger(text, { manual: true });
    if (outcome && outcome.cancelled) {
      // 被新轮次取消 → 原条目重新入队，等下次排程补播
      for (const e of entries) enqueue(e);
      logLine(config, `过夜摘要被取消，${entries.length} 条已重新入队`);
    }
    schedule();
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!config.overnightDigest) return;
    const qh = parseQuietHours(config);
    if (!qh) return;
    // 重启后队列非空且已出静音时段 → 尽快补播
    if (queue.length && !inQuietHours(qh)) {
      logLine(config, `发现 ${queue.length} 条未播的过夜摘要，10s 后补播`);
      timer = setTimeout(() => fire().catch((e) => logLine(config, `摘要播报异常: ${e?.message || e}`)), 10_000);
      return;
    }
    const delay = msUntilNextOccurrence(qh.end);
    const at = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(() => fire().catch((e) => logLine(config, `摘要播报异常: ${e?.message || e}`)), delay);
    logLine(config, `过夜摘要已排程: ${at}`);
  }

  return {
    enqueue(entry) {
      queue.push({ at: new Date().toISOString(), reason: entry.reason || 'completed', text: entry.text });
      if (queue.length > config.digestMaxEntries) queue = queue.slice(-config.digestMaxEntries);
      persist();
    },
    schedule,
    fire,
    size: () => queue.length,
    peek: () => queue.slice(),
  };
}

/* ---------------- 播报器 ---------------- */

function createAnnouncer(config, digestRef) {
  const queue = []; // 待播项 {text, opts, done}
  let draining = false;
  let current = null; // 进行中项 {text, ac}
  let lastAnnounceAt = 0;
  const status = { lastOutcome: null, lastText: '', lastAt: 0 };

  async function speakOnce(text, signal) {
    const started = Date.now();
    logLine(config, `开始播报: ${text}`);
    const result = await announceOnce(config, text, signal);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      status.lastOutcome = 'ok';
      status.lastText = text;
      status.lastAt = Date.now();
      logLine(config, `播报完成 (${secs}s): ${text}`);
      return { played: true };
    }
    if (result.exitCode === 'aborted') {
      logLine(config, `播报被取消 (${secs}s): ${text}`);
      return { cancelled: true };
    }
    status.lastOutcome = 'error';
    status.lastText = text;
    status.lastAt = Date.now();
    logLine(config, `播报失败 exit=${result.exitCode} (${secs}s): ${result.stderr.trim().split('\n').pop() || '(no stderr)'}`);
    if (config.fallbackLocal) {
      logLine(config, '降级本机播放…');
      const fb = await fallbackPlayLocal(config, text);
      if (fb.ok) logLine(config, `本机回退成功 (via ${fb.via})`);
      else logLine(config, '本机回退也失败，本次通知无声');
    }
    return { played: config.fallbackLocal };
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length) {
        const item = queue.shift();
        const { text } = item;
        const { manual = false, urgent = false } = item.opts || {};
        let outcome = {};
        const qh = parseQuietHours(config); // 每次重解析：POST 改配置即时生效
        const quiet = !manual && inQuietHours(qh);
        if (quiet) {
          if (urgent && config.blockedQuietPolicy === 'speaker') {
            logLine(config, `阻塞提醒豁免静音时段，照常音箱播报: ${text}`);
            const ac = new AbortController();
            current = { text, ac };
            lastAnnounceAt = Date.now();
            outcome = await speakOnce(text, ac.signal);
            current = null;
          } else if (urgent && config.blockedQuietPolicy === 'local') {
            logLine(config, `静音时段阻塞提醒走本机播放: ${text}`);
            const ok = await speakOnMacOutput(config, text);
            status.lastOutcome = ok ? 'ok' : 'error';
            status.lastText = text;
            status.lastAt = Date.now();
            if (!ok) logLine(config, '本机播放失败，阻塞提醒无声');
          } else if (config.overnightDigest && digestRef.current && !urgent) {
            digestRef.current.enqueue({ text, reason: 'completed' });
            logLine(config, `静音时段，已入过夜摘要队列 (共 ${digestRef.current.size()} 条): ${text}`);
          } else {
            logLine(config, `静音时段跳过播报 (${config.quietHours.join('-')}): ${text}`);
          }
        } else {
          // 在场感知：用户正在电脑前（键鼠活跃），非紧急播报无意义
          if (!manual && !urgent && await isUserPresent(config)) {
            logLine(config, `用户在场（键鼠活跃），跳过播报: ${text}`);
          } else {
            const bypassCooldown = manual || (urgent && config.blockedBypassCooldown);
            if (!bypassCooldown && config.cooldownMs > 0 && Date.now() - lastAnnounceAt < config.cooldownMs) {
              logLine(config, `冷却中跳过播报 (距上次 ${Math.round((Date.now() - lastAnnounceAt) / 1000)}s < ${Math.round(config.cooldownMs / 1000)}s): ${text}`);
            } else {
              const ac = new AbortController();
              current = { text, ac };
              lastAnnounceAt = Date.now();
              outcome = await speakOnce(text, ac.signal);
              current = null;
            }
          }
        }
        item.done?.(outcome);
      }
    } finally {
      draining = false;
      current = null;
    }
  }

  /**
   * 入队一条播报。resolve 于该条处理完，携带 {played}/{cancelled}。
   * @param {object} opts
   *  - manual: 手动试听（豁免静音/冷却）
   *  - urgent: 阻塞提醒（豁免冷却；静音时段按 blockedQuietPolicy）
   */
  function trigger(text, opts = {}) {
    return new Promise((resolve) => {
      queue.push({ text, opts, done: resolve });
      if (draining) logLine(config, `播报进行中，合并本次触发（排队 ${queue.length}）`);
      drain();
    });
  }

  /**
   * 取消所有待播与播报中的通知（用户新开一轮 = 人在电脑前，迟到的通知只剩困惑）。
   * 返回取消条数。
   */
  function cancelAll(reason) {
    let n = queue.length;
    for (const item of queue.splice(0)) item.done?.({ cancelled: true });
    const inflight = current;
    if (inflight) {
      inflight.ac.abort();
      n++;
    }
    if (n) logLine(config, `${reason}，取消 ${n} 条未播/播报中的通知`);
    return n;
  }

  return {
    trigger,
    cancelAll,
    status,
    isBusy: () => draining,
    quietHoursActive: () => inQuietHours(parseQuietHours(config)),
  };
}

/* ---------------- HTTP 路由（自检 + 配置） ---------------- */

const numIn = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const boolIn = (v) => (typeof v === 'boolean' ? v : undefined);

/** 可写字段白名单：校验器返回 undefined 表示拒绝该字段 */
const WRITABLE = {
  enabled: boolIn,
  detail: (v) => ['fixed', 'template', 'excerpt', 'llm'].includes(v) ? v : undefined,
  volume: numIn(0, 1),
  text: (v) => (typeof v === 'string' && v.trim() && v.length <= 120 ? v : undefined),
  announceOn: (v) => (Array.isArray(v) && v.length && v.every((k) => TURN_REASONS.includes(k)) ? v : undefined),
  quietHours: (v) => {
    if (Array.isArray(v) && v.length === 0) return v;
    if (Array.isArray(v) && v.length === 2 && v.every((s) => /^\d{1,2}:\d{2}$/.test(String(s)))) return v.map(String);
    return undefined;
  },
  cooldownMs: numIn(0, 3_600_000),
  minDurationMs: numIn(0, 3_600_000),
  goalAware: boolIn,
  goalDebounceMs: numIn(1000, 3_600_000),
  blockedQuietPolicy: (v) => ['skip', 'local', 'speaker'].includes(v) ? v : undefined,
  blockedBypassCooldown: boolIn,
  cancelOnNewTurn: boolIn,
  speakerRetries: numIn(1, 5),
  prewarm: boolIn,
  afkSkipMs: numIn(0, 3_600_000),
  chime: boolIn,
  chimeDelayMs: numIn(0, 10_000),
  chimeFile: (v) => (typeof v === 'string' && v.trim() === '' ? v : (typeof v === 'string' && v.length <= 512 ? v : undefined)),
  ttsEngine: (v) => ['local', 'cosyvoice'].includes(v) ? v : undefined,
  ttsVoice: (v) => (typeof v === 'string' && v.trim() && v.length <= 64 ? v : undefined),
  ttsSpeed: numIn(0.5, 2),
  ttsUrl: (v) => (typeof v === 'string' && /^https?:\/\/.+/.test(v) && v.length <= 256 ? v : undefined),
  overnightDigest: boolIn,
  fallbackLocal: boolIn,
  keepAlive: boolIn, // 以下两项改后需重启（定时器在 apply 时建立）
  keepAliveIntervalMs: numIn(30_000, 3_600_000),
};

function tailLog(config, lines = 15) {
  try {
    return readFileSync(config.logFile, 'utf8').trim().split('\n').slice(-lines);
  } catch {
    return [];
  }
}

function snapshotConfig(config) {
  const out = {};
  for (const k of Object.keys(WRITABLE)) out[k] = config[k];
  out.device = config.device;
  out.bleSpeakerDir = config.bleSpeakerDir;
  out.llmMaxChars = config.llmMaxChars;
  return out;
}

function registerRoutes(ctx, config, state) {
  const withService = (name, fn) => {
    let svc = null;
    try { svc = ctx[name]; } catch { /* undeclared */ }
    if (svc) { fn(svc); return; }
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject([name], (c) => {
          try { fn(c[name]); } catch (e) { logLine(config, `路由注册失败: ${e?.message || e}`); }
        });
      }
    } catch { /* service 不存在 */ }
  };
  withService('webServer', (webServer) => {
    webServer.register({
      kind: 'exact',
      path: TEST_PATH,
      handler: async (req, res) => {
        const send = (status, payload) => {
          const body = JSON.stringify(payload);
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        };
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          if (url.searchParams.get('announce') === '1' || req.method === 'POST') {
            state.manualAnnounce();
            send(200, { ok: true, triggered: true, note: '手动测试播报已入队（绕过静音/冷却）' });
            return;
          }
          const st = state;
          send(200, {
            ok: true, plugin: 'voice-info', path: TEST_PATH,
            usage: 'GET ?announce=1 触发一次真实测试播报',
            state: st.snapshotState(),
            lastLog: tailLog(config),
          });
        } catch (err) {
          send(500, { ok: false, error: String(err?.message || err) });
        }
      },
    });

    webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: async (req, res) => {
        const send = (status, payload) => {
          const body = JSON.stringify(payload);
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        };
        try {
          if (req.method === 'GET') {
            send(200, { ok: true, config: snapshotConfig(config), state: state.snapshotState() });
            return;
          }
          if (req.method !== 'POST') { send(405, { ok: false, error: 'method not allowed' }); return; }
          const chunks = [];
          let size = 0;
          await new Promise((resolve, reject) => {
            req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
            req.on('end', resolve);
            req.on('error', reject);
          });
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(400, { ok: false, error: 'invalid JSON' }); return; }
          if (!body || typeof body !== 'object') { send(400, { ok: false, error: 'body must be object' }); return; }
          const applied = {};
          const rejected = [];
          for (const [k, v] of Object.entries(body)) {
            if (!(k in WRITABLE)) { rejected.push(k); continue; }
            const clean = WRITABLE[k](v);
            if (clean === undefined) { rejected.push(k); continue; }
            config[k] = clean; // 就地修改：所有持有者立即可见
            applied[k] = clean;
          }
          if (Object.keys(applied).length) {
            try { persistConfig(config); } catch (err) { send(500, { ok: false, error: `persist failed: ${err?.message || err}` }); return; }
          }
          if ('quietHours' in applied || 'overnightDigest' in applied) state.rescheduleDigest();
          logLine(config, `配置已更新: ${JSON.stringify(applied)}${rejected.length ? `，拒绝: ${rejected.join(',')}` : ''}`);
          send(200, {
            ok: true, applied, rejected,
            restartRequired: Object.keys(applied).some((k) => k === 'keepAlive' || k === 'keepAliveIntervalMs')
              ? ['keepAlive', 'keepAliveIntervalMs']
              : [],
            config: snapshotConfig(config),
          });
        } catch (err) {
          send(500, { ok: false, error: String(err?.message || err) });
        }
      },
    });
    // 音色列表：代理 cosyvoice /healthz（引擎选 local 或服务未启动时返回空列表）
    webServer.register({
      kind: 'exact',
      path: '/plugin-api/voice-info/voices',
      handler: async (req, res) => {
        const send = (status, payload) => {
          const body = JSON.stringify(payload);
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        };
        try {
          const url = `${String(config.ttsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')}/healthz`;
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 3000);
          let voices = [];
          let serverUp = false;
          try {
            const r = await fetch(url, { signal: ac.signal });
            clearTimeout(timer);
            if (r.ok) {
              const j = await r.json();
              voices = Array.isArray(j.voices) ? j.voices : [];
              serverUp = true;
            }
          } catch {
            clearTimeout(timer);
          }
          send(200, { ok: true, engine: config.ttsEngine, serverUp, voices });
        } catch (err) {
          send(500, { ok: false, error: String(err?.message || err) });
        }
      },
    });
    logLine(config, `自检路由已注册: GET ${TEST_PATH} | GET/POST ${CONFIG_PATH} | GET /plugin-api/voice-info/voices`);
  });
}

/* ---------------- 插件入口 ---------------- */

export function apply(ctx) {
  const config = loadConfig();
  if (!config.enabled) {
    logLine(config, '插件已禁用 (config.enabled=false)');
    return;
  }

  const digestRef = { current: null };
  const announcer = createAnnouncer(config, digestRef);
  const digest = createDigest(ctx, config, announcer);
  const prewarmer = createPrewarmer(config);
  digestRef.current = digest;

  logLine(config, `已启用: device=${config.device} detail=${config.detail} keep=${config.keepConnection} minDuration=${Math.round(config.minDurationMs / 1000)}s cooldown=${Math.round(config.cooldownMs / 1000)}s quiet=${JSON.stringify(config.quietHours)} goalAware=${config.goalAware} blockedPolicy=${config.blockedQuietPolicy} digest=${config.overnightDigest} prewarm=${config.prewarm} afkSkip=${Math.round(config.afkSkipMs / 1000)}s`);

  // ---- 会话状态跟踪 ----
  const turnStarts = new Map();
  const lastAssistant = new Map();
  const lastUserText = new Map();
  const goalActive = new Map();
  const pendingGoal = new Map();
  const cap = (m) => { if (m.size > 256) m.clear(); };

  const manualAnnounce = () => {
    // 试听用专属文案：不说"任务完成"，避免与真实完成通知混淆
    const text = '主人，这是一条测试播报';
    logLine(config, `手动测试播报: ${text}`);
    announcer.trigger(text, { manual: true })
      .catch((err) => logLine(config, `播报异常: ${err?.message || err}`));
  };

  const doAnnounce = ({ reason, durationMs, material, sid, turn }) => {
    const urgent = reason === 'blocked';
    buildAnnounceText(ctx, config, { reason, durationMs, material })
      .then((text) => {
        logLine(config, `触发播报${urgent ? '(阻塞提醒)' : ''}: session=${sid} turn=${turn} reason=${reason}`);
        return announcer.trigger(text, { manual: false, urgent });
      })
      .catch((err) => logLine(config, `播报异常: ${err?.message || err}`));
  };

  const cancelPendingGoal = (sid) => {
    const p = pendingGoal.get(sid);
    if (p) {
      clearTimeout(p.timer);
      pendingGoal.delete(sid);
      logLine(config, `goal 续跑出现新轮次，取消未决播报: session=${sid}`);
    }
  };

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || !session) return;
      const sid = session.id ?? '?';
      const isTop = !session.header?.parentSession;

      if (event.type === 'turn/start') {
        turnStarts.set(sid, Number.isSafeInteger(event.time) ? event.time : Date.now());
        cancelPendingGoal(sid);
        // 人在电脑前开始新一轮：迟到的旧通知只剩困惑，直接取消
        if (config.skipSubagents && !isTop) return;
        if (config.cancelOnNewTurn !== false) announcer.cancelAll('新轮次开始');
        // 预热：轮次进行中把音箱连接建好，播报时秒出声（fire-and-forget）
        prewarmer.warm(`session=${sid}`).catch(() => {});
        return;
      }

      if (event.type === 'user/message') {
        const src = event.data?.message?.source;
        const text = extractText(event.data?.message);
        if (src?.kind === 'goal') goalActive.set(sid, true);
        else if (src?.kind) goalActive.delete(sid);
        if (text) lastUserText.set(sid, text.slice(0, 2000));
        cap(lastUserText);
        cap(goalActive);
        return;
      }

      if (event.type === 'assistant/message') {
        const text = extractText(event.data?.message);
        if (text) lastAssistant.set(sid, text.slice(0, 4000));
        cap(lastAssistant);
        return;
      }

      if (event.type !== 'turn/end') return;

      // ---- turn/end ----
      if (config.skipSubagents && !isTop) return;
      const reason = event.data?.reason?.kind;
      if (!config.announceOn.includes(reason)) return;

      const turn = event.data?.turn;
      const endTime = Number.isSafeInteger(event.time) ? event.time : Date.now();
      const startTime = turnStarts.get(sid);
      turnStarts.delete(sid);
      let durationMs;
      if (startTime !== undefined) {
        durationMs = Math.max(0, endTime - startTime);
        // 阻塞提醒不受时长门槛限制：等确认往往很快发生，但最需要立刻知道
        if (durationMs < config.minDurationMs && reason !== 'blocked') {
          logLine(config, `轮次过短跳过播报: session=${sid} turn=${turn} duration=${(durationMs / 1000).toFixed(1)}s < ${(config.minDurationMs / 1000).toFixed(0)}s`);
          return;
        }
      }
      const material = {
        userText: lastUserText.get(sid) || '',
        assistantText: lastAssistant.get(sid) || '',
        durationMs,
      };
      const meta = `session=${sid} turn=${turn} reason=${reason}${durationMs !== undefined ? ` duration=${(durationMs / 1000).toFixed(1)}s` : ' duration=?'}`;

      if (config.goalAware && reason !== 'blocked' && goalActive.get(sid)) {
        cancelPendingGoal(sid);
        const delay = Math.max(1000, config.goalDebounceMs);
        const timer = setTimeout(() => {
          pendingGoal.delete(sid);
          goalActive.delete(sid);
          logLine(config, `goal 空闲 ${Math.round(delay / 1000)}s，视为目标完成，播报 (${meta})`);
          doAnnounce({ reason, durationMs, material, sid, turn });
        }, delay);
        pendingGoal.set(sid, { timer });
        logLine(config, `goal 轮次结束，${Math.round(delay / 1000)}s 内无新轮次才播报 (${meta})`);
        return;
      }

      logLine(config, `turn/end 触发${startTime === undefined ? '(时长未知,保守播报)' : ''}: ${meta}`);
      doAnnounce({ reason, durationMs, material, sid, turn });
    } catch (err) {
      logLine(config, `事件处理异常(已忽略): ${err?.message || err}`);
    }
  }, { global: true });

  // ---- 过夜摘要排程 ----
  if (config.overnightDigest) digest.schedule();

  // ---- 连接保活（可选） ----
  if (config.keepAlive) {
    const warm = async () => {
      if (announcer.isBusy()) return;
      const r = await runCommand(process.execPath, [cliPath(config), 'connect', config.device],
        { cwd: config.bleSpeakerDir, timeoutMs: 60_000 });
      if (!r.ok) logLine(config, `保活重连失败 exit=${r.exitCode}: ${r.stderr.trim().split('\n').pop() || ''}`);
    };
    const ms = Math.max(30_000, config.keepAliveIntervalMs);
    if (typeof ctx.setInterval === 'function') ctx.setInterval(warm, ms);
    else {
      const t = setInterval(warm, ms);
      try { ctx.on('dispose', () => clearInterval(t)); } catch { t.unref?.(); }
    }
    logLine(config, `连接保活已开启: 每 ${Math.round(ms / 1000)}s 检查/重连 ${config.device}`);
  }

  // ---- HTTP 路由 ----
  registerRoutes(ctx, config, {
    manualAnnounce,
    rescheduleDigest: () => digest.schedule(),
    // 按请求计算纯值快照（函数无法过 JSON）
    snapshotState: () => ({
      busy: announcer.isBusy(),
      quietHoursActive: announcer.quietHoursActive(),
      lastOutcome: announcer.status.lastOutcome,
      lastText: announcer.status.lastText,
      lastAt: announcer.status.lastAt,
      digestQueue: digest.size(),
      digestPeek: digest.peek(),
    }),
  });
}

// 无硬依赖：webServer/llm 均运行时探测，缺失时优雅降级
export const inject = [];
