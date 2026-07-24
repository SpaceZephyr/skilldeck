#!/usr/bin/env node
// SkillDeck · 可视化 Skill 控制台
// 零依赖：读取本地 Skill 文件夹 → 卡片展示 → 一键把命令投送给 codex / qodercli 执行并流式输出。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 4177;
const PUBLIC = path.join(__dirname, 'public');
const DEFAULT_SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');
// 让子进程能找到装在 ~/.local/bin 的 qodercli 等
const CHILD_PATH = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`;

// ---------- 配置（DeepSeek）与专家存储 ----------
const CONFIG_FILE = path.join(__dirname, '.skilldeck.local.json');
const EXPERTS_FILE = path.join(__dirname, 'experts.json');

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || cfg.deepseekApiKey || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || cfg.model || 'deepseek-chat',
  };
}
function loadExperts() {
  try {
    const j = JSON.parse(fs.readFileSync(EXPERTS_FILE, 'utf8'));
    return Array.isArray(j) ? j : (j.experts || []);
  } catch (_) { return []; }
}
function saveExperts(list) {
  fs.writeFileSync(EXPERTS_FILE, JSON.stringify(list, null, 2));
}
function newExpertId() {
  return 'exp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 目录历史（本机状态，gitignore）
const STATE_FILE = path.join(__dirname, '.skilldeck.state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
}
function recordDir(dir) {
  if (!dir) return;
  const s = loadState();
  const list = Array.isArray(s.recentDirs) ? s.recentDirs : [];
  s.recentDirs = [dir, ...list.filter((d) => d !== dir)].slice(0, 12);
  saveState(s);
}
function recentDirs() {
  const s = loadState();
  const list = Array.isArray(s.recentDirs) ? s.recentDirs : [];
  // 默认目录 + 专家里出现过的目录都并进来，保证历史齐全
  const fromExperts = loadExperts().map((e) => e.dir).filter(Boolean);
  return [...new Set([...list, ...fromExperts, DEFAULT_SKILLS_DIR])];
}
// macOS 原生「选择文件夹」对话框，返回绝对路径
function pickFolder() {
  try {
    const out = execSync(
      `osascript -e 'POSIX path of (choose folder with prompt "选择本地 Skill 文件夹")'`,
      { encoding: 'utf8' }
    ).trim();
    return out.replace(/\/$/, '');
  } catch (_) {
    return null; // 用户取消或非 macOS
  }
}

// ---------- Skill 解析 ----------
function parseFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split('\n');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2];
    // YAML 块标量（description: > 或 |）或空值 → 收集后续缩进行
    if (val === '' || /^[|>][+-]?\s*$/.test(val)) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j].replace(/^\s+/, ''));
        j++;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      val = block.join(' ').replace(/\s+/g, ' ').trim();
      i = j;
    } else {
      val = val.trim();
      i++;
    }
    out[key] = val;
  }
  return out;
}

// 关键词规则分类（离线、可扩展）
const CATEGORY_RULES = [
  ['标题/爆款', /标题|爆款|10万|起名|命名/],
  ['写作', /写作|文章|改写|润色|公众号|文案|口播|翻译|humaniz/i],
  ['图片/设计', /配图|封面|图片|设计|海报|logo|绘图|绘|视觉|image|design|draw|poster/i],
  ['PPT/幻灯片', /ppt|slide|幻灯|演示|deck|presentation/i],
  ['视频/音频', /视频|音频|录音|字幕|播客|video|audio|remotion|ffmpeg|tts|asr|妙记/i],
  ['产品/PM', /\bpm\b|产品|prd|原型|需求|roadmap|竞品|okr|prototype|proto/i],
  ['飞书/协作', /飞书|lark|多维表格|云文档|知识库|审批|日历|妙记/i],
  ['编程/开发', /代码|编程|coding|code|repo|调试|debug|mcp|skill.*creat|插件|extension|git/i],
  ['信息获取', /rss|抓取|爬|采集|搜索|热点|feed|scrap|news|trend|职位|job/i],
  ['数据/表格', /excel|表格|数据|xlsx|csv|财务|对账|报表|analy/i],
];
function classify(name, desc) {
  const text = `${name} ${desc}`;
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return '其它';
}

function readSkills(dir) {
  const skills = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `无法读取目录：${dir}（${e.code}）`, skills: [] };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillDir = path.join(dir, ent.name);
    // 兼容 SKILL.md / skill.md
    const candidate = ['SKILL.md', 'skill.md', 'Skill.md']
      .map((f) => path.join(skillDir, f))
      .find((p) => fs.existsSync(p));
    if (!candidate) continue;
    let fm = {};
    try {
      fm = parseFrontmatter(fs.readFileSync(candidate, 'utf8'));
    } catch (_) {}
    const name = fm.name || ent.name;
    const desc = fm.description || '（无描述）';
    // 一句话简介：取描述的第一句（到第一个句号/触发词之前）
    const oneLine = desc.split(/。|\.\s|；|当用户|触发/)[0].slice(0, 60) + '';
    skills.push({
      id: ent.name,
      name,
      folder: ent.name,
      oneLine: oneLine || desc.slice(0, 60),
      description: desc,
      category: classify(name, desc),
      path: skillDir,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { skills, dir };
}

// ---------- agent 探测 ----------
function detectAgents() {
  const found = [];
  for (const [id, bin, run] of [
    ['codex', 'codex', (p) => ['exec', p]],
    ['qodercli', 'qodercli', (p) => ['-p', p]],
  ]) {
    try {
      execSync(`command -v ${bin}`, { env: { ...process.env, PATH: CHILD_PATH }, stdio: 'ignore' });
      found.push({ id, bin, buildArgs: run });
    } catch (_) {}
  }
  return found;
}
const AGENTS = detectAgents();

// 定位某个 Skill 的 SKILL.md 绝对路径（兼容大小写）
function getSkillFile(dir, folder) {
  return ['SKILL.md', 'skill.md', 'Skill.md']
    .map((f) => path.join(dir || DEFAULT_SKILLS_DIR, folder, f))
    .find((x) => fs.existsSync(x)) || '';
}

// 读取某个 Skill 的 SKILL.md 正文（去掉 frontmatter），用于注入到命令
function getSkillBody(dir, folder) {
  const p = getSkillFile(dir, folder);
  if (!p) return '';
  const md = fs.readFileSync(p, 'utf8');
  return md.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

// 构造「粘贴到 Codex 的口令」——不依赖具体 agent 二进制。
//   mode=path（默认）：给 Codex 指路——调用哪个 Skill + 补充说明 + SKILL.md 调用地址，让 Codex 自己读。短且稳。
//   mode=inject：把 SKILL.md 正文整篇塞进去（换机器 / Codex 读不到该路径时用）。
function buildPrompt(name, task, dir, folder, mode) {
  const note = task || '（无，按该 Skill 的默认流程执行）';
  if (mode === 'inject') {
    const body = folder ? getSkillBody(dir || DEFAULT_SKILLS_DIR, folder) : '';
    if (body) {
      return (
        `请严格按照下面这份《Skill 说明书》的方法来完成任务，只输出最终结果，不要复述说明书。\n\n` +
        `===== Skill 说明书：${name} =====\n${body}\n\n` +
        `===== 你的任务 =====\n${note}`
      );
    }
  }
  // 默认：路径式口令
  const file = folder ? getSkillFile(dir, folder) : '';
  return (
    `请调用 Skill：${name}\n` +
    `补充说明：${note}\n` +
    `Skill 调用地址：${file || '（未找到 SKILL.md）'}`
  );
}

// 把专家里的 folder 列表解析成 Skill 元信息
function resolveSkills(dir, folders) {
  const { skills } = readSkills(dir);
  const byFolder = new Map((skills || []).map((s) => [s.folder, s]));
  return (folders || []).map((f) => byFolder.get(f)).filter(Boolean);
}

// 构造「专家口令」：让 Codex 在整段对话里按关键词自动挑用这组 Skill，并在每步后提示下一步可用的 Skill
function buildExpertPrompt(expert, dir) {
  const useDir = expert.dir || dir || DEFAULT_SKILLS_DIR;
  const items = resolveSkills(useDir, expert.skills);
  const lines = items
    .map((s) => `- ${s.name}：${s.oneLine} → 调用地址：${getSkillFile(useDir, s.folder)}`)
    .join('\n');
  return (
    `你现在担任「${expert.name}」${expert.emoji ? '（' + expert.emoji + '）' : ''}。${expert.description || ''}\n\n` +
    `以下是本次对话中你可以随时调用的一组 Skill。工作方式：\n` +
    `1. 根据我发来的内容或关键词，自动判断该用哪个 Skill；\n` +
    `2. 调用时按该 Skill「调用地址」里的 SKILL.md 说明来执行；\n` +
    `3. 每完成一步，主动告诉我：接下来还可以用哪些 Skill 做下一步操作。\n\n` +
    `可用 Skill（共 ${items.length} 个）：\n${lines}`
  );
}

// 调 DeepSeek 把所有 Skill 聚类成若干「专家」
async function deepseekClassify(skills) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('未配置 DeepSeek API Key（.skilldeck.local.json 或环境变量 DEEPSEEK_API_KEY）');
  const list = skills.map((s) => `${s.folder} | ${s.name} | ${s.oneLine}`).join('\n');
  const system =
    '你是一个把本地 AI Skill 按用途聚类、打包成「专家」的助手。每个「专家」是一组用途高度相关的 Skill 集合，名字要像职业/角色，例如「内容创作专家」「配图设计专家」「数据分析专家」「飞书协作专家」。';
  const user =
    `下面每行是一个 Skill，格式：folder | 名称 | 简介。\n` +
    `请把它们聚类成若干「专家」（建议 6-12 个，尽量覆盖多数 Skill；一个 Skill 归一个最合适的专家即可）。\n` +
    `严格返回 JSON：{"experts":[{"name":"中文专家名","emoji":"一个emoji","description":"一句话说明这个专家能干什么","skills":["folder","folder"]}]}。\n` +
    `skills 数组放对应 Skill 的 folder（第一列原样）。只返回 JSON，不要多余文字。\n\n${list}`;
  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_tokens: 30000,
      stream: false,
    }),
  });
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  let parsed;
  try { parsed = JSON.parse(content || '{}'); } catch (_) { throw new Error('模型返回的不是合法 JSON'); }
  const arr = Array.isArray(parsed) ? parsed : (parsed.experts || []);
  const valid = new Set(skills.map((s) => s.folder));
  return arr
    .map((e) => ({
      name: String(e.name || '未命名专家').slice(0, 30),
      emoji: String(e.emoji || '🧩').slice(0, 4),
      description: String(e.description || '').slice(0, 120),
      skills: (Array.isArray(e.skills) ? e.skills : []).filter((f) => valid.has(f)),
    }))
    .filter((e) => e.skills.length);
}

function buildCommand(agentId, name, task, dir, folder) {
  const agent = AGENTS.find((a) => a.id === agentId) || AGENTS[0];
  if (!agent) return null;
  const flag = agent.bin === 'codex' ? 'exec' : '-p';
  const body = folder ? getSkillBody(dir || DEFAULT_SKILLS_DIR, folder) : '';
  let prompt;
  if (body) {
    // 注入式：把 Skill 说明书正文塞进去，任何 agent 都能照着做，不依赖它是否注册了该 Skill
    prompt =
      `请严格按照下面这份《Skill 说明书》的方法来完成任务，只输出最终结果，不要复述说明书。\n\n` +
      `===== Skill 说明书：${name} =====\n${body}\n\n` +
      `===== 你的任务 =====\n${task || '按该 Skill 的默认流程执行。'}`;
  } else {
    prompt = `请使用「${name}」这个 Skill 来完成以下任务：\n${task || '（无补充说明，按默认流程执行）'}`;
  }
  // 预览命令做精简展示，不把整篇说明书铺出来
  const display = body
    ? `${agent.bin} ${flag} "〈注入「${name}」Skill 说明书〉+ 任务：${task || '默认流程'}"`
    : `${agent.bin} ${flag} "请使用「${name}」这个 Skill：${task || '默认流程'}"`;
  return { bin: agent.bin, args: agent.buildArgs(prompt), prompt, display, injected: !!body };
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
  });
}
function serveStatic(res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) {
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(full);
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[ext] || 'text/plain';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  if (p === '/' ) return serveStatic(res, 'index.html');
  if (p === '/app.js' || p === '/style.css') return serveStatic(res, p.slice(1));

  if (p === '/api/config') {
    const cfg = loadConfig();
    return sendJson(res, 200, {
      defaultDir: DEFAULT_SKILLS_DIR,
      agents: AGENTS.map((a) => a.id),
      hasLLM: !!cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      // 密钥永远不下发前端，只告知是否已配置
    });
  }

  // 保存模型设置（写入本机 .skilldeck.local.json，不进仓库）
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) cfg.baseUrl = body.baseUrl.trim();
    if (typeof body.model === 'string' && body.model.trim()) cfg.model = body.model.trim();
    // apiKey 留空表示保持不变，只有填了才覆盖
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) cfg.deepseekApiKey = body.apiKey.trim();
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { return sendJson(res, 500, { error: '写入配置失败：' + e.message }); }
    const now = loadConfig();
    return sendJson(res, 200, { ok: true, hasLLM: !!now.apiKey, model: now.model, baseUrl: now.baseUrl });
  }

  // ---------- 专家 ----------
  if (p === '/api/experts' && req.method === 'GET') {
    const dir = u.searchParams.get('dir');
    let experts = loadExperts();
    // 传了 dir 就只返回该目录下创建的专家（切换目录时恢复对应专家）
    if (dir) experts = experts.filter((e) => (e.dir || DEFAULT_SKILLS_DIR) === dir);
    return sendJson(res, 200, { experts });
  }
  if (p === '/api/experts' && req.method === 'POST') {
    const body = await readBody(req);
    const experts = loadExperts();
    const expert = {
      id: newExpertId(),
      name: String(body.name || '未命名专家').slice(0, 30),
      emoji: String(body.emoji || '🧩').slice(0, 4),
      description: String(body.description || '').slice(0, 200),
      skills: Array.isArray(body.skills) ? body.skills : [],
      dir: body.dir || DEFAULT_SKILLS_DIR,
      source: body.source || 'manual',
      createdAt: new Date().toISOString(),
    };
    experts.push(expert);
    saveExperts(experts);
    return sendJson(res, 200, { expert });
  }
  if (p === '/api/experts' && req.method === 'DELETE') {
    const id = u.searchParams.get('id');
    saveExperts(loadExperts().filter((e) => e.id !== id));
    return sendJson(res, 200, { ok: true });
  }
  // AI 自动分类：调 DeepSeek 生成并落库
  if (p === '/api/experts/auto' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const { skills, error } = readSkills(dir);
    if (error) return sendJson(res, 400, { error });
    try {
      const proposals = await deepseekClassify(skills || []);
      const created = proposals.map((e) => ({
        id: newExpertId(),
        ...e,
        dir,
        source: 'auto',
        createdAt: new Date().toISOString(),
      }));
      saveExperts(loadExperts().concat(created));
      return sendJson(res, 200, { experts: created, dir });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }
  // 专家口令
  if (p === '/api/expert-prompt') {
    const id = u.searchParams.get('id');
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const expert = loadExperts().find((e) => e.id === id);
    if (!expert) return sendJson(res, 404, { error: '专家不存在' });
    const prompt = buildExpertPrompt(expert, dir);
    return sendJson(res, 200, { prompt, chars: prompt.length });
  }

  if (p === '/api/skills') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const result = readSkills(dir);
    if (!result.error) recordDir(dir); // 成功读取才记入历史
    return sendJson(res, 200, result);
  }

  // 最近使用过的 Skill 目录（历史）
  if (p === '/api/dirs') {
    return sendJson(res, 200, { dirs: recentDirs(), default: DEFAULT_SKILLS_DIR });
  }

  // 弹出 macOS 原生文件夹选择框，返回绝对路径
  if (p === '/api/pick-dir') {
    const dir = pickFolder();
    if (!dir) return sendJson(res, 200, { cancelled: true });
    return sendJson(res, 200, { dir });
  }

  // 返回「粘贴到 Codex 的口令」文本（供前端预览 + 复制）
  if (p === '/api/prompt') {
    const name = u.searchParams.get('skill') || '';
    const task = u.searchParams.get('task') || '';
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const folder = u.searchParams.get('folder') || '';
    const mode = u.searchParams.get('mode') || 'path';
    const prompt = buildPrompt(name, task, dir, folder, mode);
    return sendJson(res, 200, { prompt, mode, chars: prompt.length });
  }

  // SSE 流式运行
  if (p === '/api/run') {
    const agentId = u.searchParams.get('agent') || (AGENTS[0] && AGENTS[0].id);
    const name = u.searchParams.get('skill') || '';
    const task = u.searchParams.get('task') || '';
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const folder = u.searchParams.get('folder') || '';
    const cmd = buildCommand(agentId, name, task, dir, folder);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!cmd) {
      send('error', '没有检测到可用的 agent（codex 或 qodercli），请先安装其一。');
      return res.end();
    }
    send('start', { command: cmd.display });
    // 参数数组传参，避免命令注入；stdin 设 ignore，否则 codex exec 会一直等 stdin 输入而卡住
    const child = spawn(cmd.bin, cmd.args, {
      env: { ...process.env, PATH: CHILD_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => send('chunk', d.toString()));
    child.stderr.on('data', (d) => send('chunk', d.toString()));
    child.on('close', (code) => { send('done', { code }); res.end(); });
    child.on('error', (e) => { send('error', String(e.message || e)); res.end(); });
    req.on('close', () => { try { child.kill(); } catch (_) {} });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  SkillDeck · 技控台  已启动`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  默认 Skill 目录：${DEFAULT_SKILLS_DIR}`);
  console.log(`  检测到 agent：${AGENTS.map((a) => a.id).join(', ') || '（无，请装 codex 或 qodercli）'}\n`);
});
