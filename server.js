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
const HOME = os.homedir();

// 内置来源：本机 Codex / Claude Code 的 Skill 根目录，启动即自动扫描。
// 目录不存在或没有 Skill 时不隐藏，照常显示（前端渲染成空态），让用户知道扫过了。
const BUILTIN_SOURCES = [
  { id: 'codex', label: 'Codex', icon: '⌁', dir: process.env.CODEX_SKILLS_DIR || path.join(HOME, '.codex', 'skills') },
  { id: 'claude', label: 'Claude Code', icon: '✳', dir: process.env.CLAUDE_SKILLS_DIR || path.join(HOME, '.claude', 'skills') },
];
const BUILTIN_DIRS = new Set(BUILTIN_SOURCES.map((s) => s.dir));

// 默认目录：优先环境变量，其次第一个真实存在的内置来源，最后回落 ~/.claude/skills
const DEFAULT_SKILLS_DIR =
  process.env.SKILLS_DIR ||
  (BUILTIN_SOURCES.find((s) => fs.existsSync(s.dir)) || {}).dir ||
  path.join(HOME, '.claude', 'skills');
// 让子进程能找到装在 ~/.local/bin 的 qodercli 等
const CHILD_PATH = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`;

// ---------- 专家存储 ----------
// 不再接任何大模型 API：专家聚类交给你已经在用的 Codex / Claude Code，
// SkillDeck 只负责出口令、开一个回传口子、显示结果。
const EXPERTS_FILE = path.join(__dirname, 'experts.json');

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
// 用户手动添加的目录 = 历史目录里剔掉两个内置来源
function customDirs() {
  return recentDirs().filter((d) => d && !BUILTIN_DIRS.has(d));
}
function forgetDir(dir) {
  const s = loadState();
  s.recentDirs = (Array.isArray(s.recentDirs) ? s.recentDirs : []).filter((d) => d !== dir);
  saveState(s);
}

// 自定义目录的显示名：取最后两段，避免一堆目录都叫 skills 分不清
function shortLabel(dir) {
  const parts = dir.split(path.sep).filter(Boolean);
  return parts.slice(-2).join('/') || dir;
}

// 扫描一个来源：目录在不在、能读出几个 Skill、挂了几个专家
function describeSource(src) {
  const exists = fs.existsSync(src.dir);
  let count = 0;
  let error = '';
  if (exists) {
    const r = readSkills(src.dir);
    if (r.error) error = r.error;
    else count = (r.skills || []).length;
  }
  const experts = loadExperts().filter((e) => (e.dir || DEFAULT_SKILLS_DIR) === src.dir).length;
  return { ...src, exists, count, experts, error };
}
// 全部来源：两个内置 + 用户自定义目录
function listSources() {
  const builtin = BUILTIN_SOURCES.map((s) => describeSource({ ...s, builtin: true }));
  const custom = customDirs().map((dir) =>
    describeSource({ id: 'custom:' + dir, label: shortLabel(dir), icon: '📁', dir, builtin: false })
  );
  return [...builtin, ...custom];
}
// macOS 原生「选择文件夹」对话框，返回绝对路径
function pickFolder(prompt) {
  try {
    const title = (prompt || '选择本地 Skill 文件夹').replace(/"/g, '');
    const out = execSync(
      `osascript -e 'POSIX path of (choose folder with prompt "${title}")'`,
      { encoding: 'utf8' }
    ).trim();
    return out.replace(/\/$/, '');
  } catch (_) {
    return null; // 用户取消或非 macOS
  }
}

// ---------- 删除：一律走废纸篓，不做硬删 ----------
// 直接 rm -rf 太狠了，误删就没了。移到 ~/.Trash 既从 Skill 目录里消失，又能在访达里捞回来。
function moveToTrash(target) {
  const trash = path.join(HOME, '.Trash');
  if (!fs.existsSync(trash)) {
    // 非 macOS 没有废纸篓，退回真删除
    fs.rmSync(target, { recursive: true, force: true });
    return { trashed: false, to: '' };
  }
  let dest = path.join(trash, path.basename(target));
  // 废纸篓里重名就加时间戳后缀，别覆盖别人
  if (fs.existsSync(dest)) dest = `${dest} ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(target, dest);
  } catch (e) {
    // 跨卷 rename 会 EXDEV，退回复制再删
    fs.cpSync(target, dest, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
  return { trashed: true, to: dest };
}

// 删一个 Skill 文件夹。层层设卡，确保只可能删到「某个 Skill 目录的直接子文件夹，且里面有 SKILL.md」
function deleteSkillFolder(dir, folder) {
  if (!dir || !folder) return { error: '缺少目录或 Skill 名' };
  // 不许出现路径分隔符和 ..，杜绝穿越
  if (folder.includes('/') || folder.includes('\\') || folder.includes('..')) return { error: '非法的 Skill 名' };
  const base = path.resolve(dir);
  const target = path.resolve(base, folder);
  if (path.dirname(target) !== base) return { error: '越界，拒绝删除' };
  if (target === base || target === HOME || target === '/') return { error: '越界，拒绝删除' };
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { error: '这个 Skill 文件夹已经不在了' };
  // 必须确实是个 Skill（有 SKILL.md），避免手滑删掉普通文件夹
  if (!getSkillFile(dir, folder)) return { error: '这个文件夹里没有 SKILL.md，不像是 Skill，已拒绝删除' };

  const r = moveToTrash(target);
  // 顺手把引用了这个 Skill 的专家清干净，免得留下死链接
  let touched = 0;
  const experts = loadExperts().map((e) => {
    if ((e.dir || DEFAULT_SKILLS_DIR) !== dir) return e;
    if (!(e.skills || []).includes(folder)) return e;
    touched++;
    return { ...e, skills: e.skills.filter((f) => f !== folder) };
  });
  if (touched) saveExperts(experts);
  return { ok: true, ...r, expertsTouched: touched };
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

// ---------- 分类任务：出口令给 Codex / Claude Code 跑，再由它回传结果 ----------
// 任务只活在内存里，进程重启就没了，本来也是一次性的。
const JOBS = new Map();
function newToken() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function createJob(dir, skills) {
  const token = newToken();
  const job = { token, dir, count: skills.length, status: 'waiting', experts: [], error: '', createdAt: Date.now() };
  JOBS.set(token, job);
  // 只留最近 20 个任务，免得内存里越积越多
  if (JOBS.size > 20) {
    const oldest = [...JOBS.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) JOBS.delete(oldest.token);
  }
  return job;
}

// 给 Codex / Claude Code 的口令：Skill 清单 + 聚类要求 + 回传命令
function buildClassifyPrompt(job, skills) {
  const list = skills.map((s) => `${s.folder} | ${s.name} | ${s.oneLine}`).join('\n');
  const url = `http://localhost:${PORT}/api/experts/import?token=${job.token}`;
  return (
    `帮我把下面这批本地 AI Skill 按用途聚类，打包成若干「专家」。\n\n` +
    `每个专家是一组用途高度相关的 Skill 集合，名字要像职业或角色，例如「内容创作专家」「配图设计专家」「数据分析专家」。\n` +
    `请聚成 6-12 个专家，尽量覆盖多数 Skill，一个 Skill 归到一个最合适的专家即可。\n\n` +
    `Skill 清单（共 ${skills.length} 个，格式：folder | 名称 | 简介）：\n${list}\n\n` +
    `分好之后，执行下面这条命令把结果回传给 SkillDeck（本机服务，直接跑就行）：\n\n` +
    `curl -X POST '${url}' \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -d '{"experts":[{"name":"内容创作专家","description":"一句话说明这个专家能干什么","skills":["folder-a","folder-b"]}]}'\n\n` +
    `把 -d 后面换成你实际的聚类结果。skills 数组里放 Skill 的 folder（清单第一列，原样照抄，不要改名）。\n` +
    `回传成功会返回 {"ok":true,...}。跑完告诉我建了几个专家就行。`
  );
}

// 校验并落库 Codex / Claude Code 回传的聚类结果
function importExperts(job, payload) {
  const arr = Array.isArray(payload) ? payload : (payload && payload.experts) || [];
  if (!Array.isArray(arr) || !arr.length) return { error: 'experts 是空的或者格式不对' };
  const { skills } = readSkills(job.dir);
  const valid = new Set((skills || []).map((s) => s.folder));
  const cleaned = arr
    .map((e) => ({
      name: String((e && e.name) || '未命名专家').slice(0, 30),
      description: String((e && e.description) || '').slice(0, 200),
      // 只认真实存在的 folder，模型编出来的一律丢掉
      skills: (Array.isArray(e && e.skills) ? e.skills : []).filter((f) => valid.has(f)),
    }))
    .filter((e) => e.skills.length);
  if (!cleaned.length) return { error: 'skills 里没有一个能对上真实的 Skill folder，请照抄清单第一列' };
  const created = cleaned.map((e) => ({
    id: newExpertId(),
    ...e,
    dir: job.dir,
    source: 'auto',
    createdAt: new Date().toISOString(),
  }));
  saveExperts(loadExperts().concat(created));
  const covered = new Set(cleaned.flatMap((e) => e.skills)).size;
  return { ok: true, experts: created, covered, total: valid.size };
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

// ================= 工作台 =================
// 一个工作台 = 本地一个根目录。SkillDeck 只做三件事：显示目录、出口令、必要时移动文件。
// 不执行、不调度、不常驻。定时跑什么由你在 Agent 那边配，产出落进目录就行。

// 注册过的工作台目录（存本机 state，gitignore）
function workbenchDirs() {
  const s = loadState();
  return Array.isArray(s.workbenches) ? s.workbenches : [];
}
function addWorkbench(dir) {
  const s = loadState();
  const list = Array.isArray(s.workbenches) ? s.workbenches : [];
  s.workbenches = [...new Set([...list, dir])];
  saveState(s);
}
function removeWorkbench(dir) {
  const s = loadState();
  s.workbenches = (Array.isArray(s.workbenches) ? s.workbenches : []).filter((d) => d !== dir);
  const seen = s.wbSeen || {};
  delete seen[dir];
  s.wbSeen = seen;
  saveState(s);
}
// 「上次看到哪」的时间戳，用来给新产出打红点
function lastSeenOf(dir) {
  const s = loadState();
  return (s.wbSeen || {})[dir] || 0;
}
function markSeen(dir) {
  const s = loadState();
  s.wbSeen = { ...(s.wbSeen || {}), [dir]: Date.now() };
  saveState(s);
}

const TASKS_FILE = '_tasks.md';
const CONTEXT_DIR = '_context';

// 解析 _tasks.md：## 是任务名，下面的 key: value 是配置，其余当说明
function parseTasks(md) {
  const out = [];
  let cur = null;
  for (const raw of String(md || '').split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (cur) out.push(cur);
      cur = { name: h[1].trim(), skills: [], expert: '', context: [], input: '', output: '', desc: '' };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^\s*([A-Za-z_一-龥]+)\s*[:：]\s*(.*)$/);
    const split = (v) => v.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
    if (kv) {
      const k = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (k === 'skills' || k === 'skill' || k === '技能') { cur.skills = split(v); continue; }
      if (k === 'expert' || k === '专家') { cur.expert = v; continue; }
      if (k === 'context' || k === '上下文') { cur.context = split(v); continue; }
      if (k === 'input' || k === '输入') { cur.input = v.replace(/\/+$/, ''); continue; }
      if (k === 'output' || k === '输出') { cur.output = v.replace(/\/+$/, ''); continue; }
    }
    if (line.trim()) cur.desc += (cur.desc ? '\n' : '') + line.trim();
  }
  if (cur) out.push(cur);
  // 有「输入」的是加工型（要先选中一个文件），没有的是采集型（直接跑）
  return out.map((t, i) => ({ ...t, id: 't' + i, kind: t.input ? 'process' : 'collect' }));
}

function readTasks(wb) {
  const p = path.join(wb, TASKS_FILE);
  try { return parseTasks(fs.readFileSync(p, 'utf8')); } catch (_) { return []; }
}
// _context/ 下的全局背景文件，每次调用都带上
function contextFiles(wb) {
  const d = path.join(wb, CONTEXT_DIR);
  try {
    return fs.readdirSync(d)
      .filter((f) => !f.startsWith('.'))
      .map((f) => path.join(d, f))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  } catch (_) { return []; }
}

// 扫目录树。作品 = 含 index.md 的文件夹，树里当一个整体显示。
function scanTree(abs, lastSeen, depth) {
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) {
    return { children: [], total: 0, fresh: 0 };
  }
  const children = [];
  let total = 0, fresh = 0;
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) {
      const isWork = ['index.md', 'INDEX.md'].some((f) => fs.existsSync(path.join(p, f)));
      const sub = depth > 0 ? scanTree(p, lastSeen, depth - 1) : { children: [], total: 0, fresh: 0 };
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch (_) {}
      // 作品文件夹按「一个东西」算，它的新旧看目录本身
      const t = isWork ? 1 : sub.total;
      const f = isWork ? (mt > lastSeen ? 1 : 0) : sub.fresh;
      children.push({
        name: e.name, type: 'dir', path: p, isWork,
        children: sub.children, total: t, fresh: f, isNew: isWork && mt > lastSeen,
      });
      total += t; fresh += f;
    } else {
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch (_) {}
      const isNew = mt > lastSeen;
      children.push({ name: e.name, type: 'file', path: p, mtime: mt, isNew });
      total++; if (isNew) fresh++;
    }
  }
  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
  return { children, total, fresh };
}

// 路径必须落在工作台目录里面，防穿越
function insideWorkbench(wb, target) {
  const base = path.resolve(wb);
  const t = path.resolve(target);
  return t === base || t.startsWith(base + path.sep);
}

// 一个作品的展示名：文件去掉扩展名，文件夹就是文件夹名
function workName(p) {
  const base = path.basename(p);
  return base.replace(/\.(md|markdown|txt)$/i, '');
}

// 构造任务口令：背景文件 + Skill 地址 + 处理谁 + 写到哪
function buildTaskPrompt(wb, task, targetPath, skillDir) {
  const dir = skillDir || DEFAULT_SKILLS_DIR;
  const lines = [];
  lines.push(`工作台：${path.basename(wb)}`);
  lines.push(`这一步：${task.name}`);
  if (task.desc) lines.push(`要做的事：${task.desc.replace(/\n/g, ' ')}`);
  lines.push('');

  // 背景文件：全局 _context/ + 任务自己声明的
  const ctx = [...contextFiles(wb), ...(task.context || []).map((c) => path.resolve(wb, c))];
  if (ctx.length) {
    lines.push('先读这些背景文件：');
    ctx.forEach((c) => lines.push(`  ${c}`));
    lines.push('');
  }

  // Skill：任务点名的 + 专家带的，去重
  const folders = [...(task.skills || [])];
  if (task.expert) {
    const exp = loadExperts().find((e) => e.name === task.expert);
    if (exp) (exp.skills || []).forEach((f) => folders.push(f));
  }
  const uniq = [...new Set(folders)];
  if (uniq.length) {
    lines.push(uniq.length > 1 ? '用这些 Skill（按需挑用）：' : '用这个 Skill：');
    uniq.forEach((f) => {
      const file = getSkillFile(dir, f);
      lines.push(`  ${f}${file ? '\n    地址：' + file : '（在 ' + dir + ' 里没找到）'}`);
    });
    lines.push('');
  }

  if (targetPath) {
    lines.push(`处理：${targetPath}`);
    const name = workName(targetPath);
    if (task.output) {
      const outAbs = path.resolve(wb, task.output);
      // 输入输出同一个目录 = 就地加工（比如给正文配图），不新建作品
      const sameDir = path.resolve(path.dirname(targetPath)) === outAbs
        || (task.input && path.resolve(wb, task.input) === outAbs);
      if (sameDir) {
        const workDir = fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()
          ? targetPath : path.dirname(targetPath);
        lines.push(`产物写进同一个作品文件夹：${workDir}`);
      } else {
        lines.push(`写到：${path.join(outAbs, name, 'index.md')}`);
        lines.push(`（这个作品文件夹不存在就新建，附带产物一并放进去）`);
      }
    }
  } else if (task.output) {
    lines.push(`产出写到：${path.resolve(wb, task.output)}`);
    lines.push(`一条一个文件夹，正文放 index.md。`);
  }
  lines.push('');
  lines.push('写完不用移动位置，我在 SkillDeck 里看过再决定推进到哪一步。');
  return lines.join('\n');
}

// 新建工作台骨架
const WB_TEMPLATES = {
  xhs: {
    label: '小红书创作',
    dirs: ['选题', '灵感', '大纲', '创作', '完成'],
    tasks: `# 小红书创作工作台

> 每个 ## 是一个任务。有「输入」的要先在左边选中一个作品才能跑，没有的直接跑。
> _context/ 里的文件每次调用都会带上，任务也可以用「上下文」再追加。

## 采集今日热点
skills: xhs-hotnotes, topic-collector
输出: 选题
从今天的热点里挑出适合本账号的小红书选题，一条一个文件夹。

## 找灵感和参考
skills: baokuan-article-analysis
输入: 选题
输出: 灵感
围绕这个选题找同类爆款，拆解它们的钩子和结构。

## 写大纲
skills: xiaohongshu-content-tools
输入: 灵感
输出: 大纲
定结构：开头钩子、3-5 个要点、结尾互动。

## 写正文
skills: xiaohongshu-content-tools
输入: 大纲
输出: 创作
按大纲写小红书正文，口语化，多换行。

## 起标题
skills: baokuan-title-generator
输入: 创作
输出: 创作
给这篇正文起 10 个候选标题，写进作品文件夹的 标题.md。

## 设计配图
skills: image-studio
输入: 创作
输出: 创作
按正文内容做封面和配图，图片存进这个作品文件夹。
`,
  },
  wechat: {
    label: '公众号创作',
    dirs: ['选题', '素材', '大纲', '创作', '完成'],
    tasks: `# 公众号创作工作台

## 采集选题
skills: topic-collector
输出: 选题
扫最近的热点和素材，产出选题，一条一个文件夹。

## 找论据和金句
skills: web-scraper
输入: 选题
输出: 素材
围绕选题找案例、数据和可引用的原话。

## 写大纲
skills: blog-post-writer
输入: 素材
输出: 大纲
先列大纲讨论，不要一次性输出几千字。

## 写正文
skills: blog-post-writer
输入: 大纲
输出: 创作
按写作风格写正文。

## 起标题
skills: baokuan-title-generator
输入: 创作
输出: 创作
给这篇起 10 个候选标题，写进 标题.md。

## 审稿
skills: article-review
输入: 创作
输出: 创作
按审稿标准逐项检查，问题和修改建议写进 审稿.md。
`,
  },
  blank: {
    label: '空白工作台',
    dirs: ['输入', '产出'],
    tasks: `# 工作台

> 每个 ## 是一个任务。有「输入」的要先在左边选中一个作品才能跑，没有的直接跑。
> 可用字段：skills / expert / 上下文 / 输入 / 输出

## 示例任务
skills:
输入: 输入
输出: 产出
在这里写这一步要做什么。
`,
  },
};

function initWorkbench(dir, templateId) {
  const tpl = WB_TEMPLATES[templateId] || WB_TEMPLATES.blank;
  const made = [];
  const ctx = path.join(dir, CONTEXT_DIR);
  if (!fs.existsSync(ctx)) { fs.mkdirSync(ctx, { recursive: true }); made.push(CONTEXT_DIR + '/'); }
  tpl.dirs.forEach((d, i) => {
    const p = path.join(dir, `${String(i).padStart(2, '0')} ${d}`);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); made.push(path.basename(p) + '/'); }
  });
  const tasksPath = path.join(dir, TASKS_FILE);
  if (!fs.existsSync(tasksPath)) {
    // 模板里的输入/输出写的是裸名字，落盘时补上序号前缀
    let body = tpl.tasks;
    tpl.dirs.forEach((d, i) => {
      const numbered = `${String(i).padStart(2, '0')} ${d}`;
      // 注意不能用 \b：中文后面不构成 \w 边界，正则永远匹配不上。用行尾锚点。
      body = body.replace(new RegExp(`^(输入|输出): ${d}\\s*$`, 'gm'), `$1: ${numbered}`);
    });
    fs.writeFileSync(tasksPath, body);
    made.push(TASKS_FILE);
  }
  return made;
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
  if (['/app.js', '/icons.js', '/md.js', '/style.css'].includes(p)) return serveStatic(res, p.slice(1));

  if (p === '/api/config') {
    return sendJson(res, 200, {
      defaultDir: DEFAULT_SKILLS_DIR,
      agents: AGENTS.map((a) => a.id),
    });
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
  // 开一个分类任务，返回给 Codex / Claude Code 用的口令
  if (p === '/api/experts/job' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const { skills, error } = readSkills(dir);
    if (error) return sendJson(res, 400, { error });
    if (!skills || !skills.length) return sendJson(res, 400, { error: '这个来源里没有 Skill，没法分类' });
    const job = createJob(dir, skills);
    return sendJson(res, 200, { token: job.token, count: skills.length, prompt: buildClassifyPrompt(job, skills) });
  }
  // 轮询任务状态：前端拿这个显示「等待中 / 已完成」
  if (p === '/api/experts/job' && req.method === 'GET') {
    const job = JOBS.get(u.searchParams.get('token') || '');
    if (!job) return sendJson(res, 404, { error: '任务不存在或已过期' });
    return sendJson(res, 200, {
      status: job.status, error: job.error,
      experts: job.experts, covered: job.covered, total: job.total,
    });
  }
  // 回传口子：Codex / Claude Code 把聚类结果 POST 回来
  if (p === '/api/experts/import' && req.method === 'POST') {
    const job = JOBS.get(u.searchParams.get('token') || '');
    if (!job) return sendJson(res, 404, { error: '任务不存在或已过期，请回 SkillDeck 重新生成口令' });
    const body = await readBody(req);
    const r = importExperts(job, body);
    if (r.error) {
      job.status = 'error';
      job.error = r.error;
      return sendJson(res, 400, { error: r.error });
    }
    job.status = 'done';
    job.experts = r.experts;
    job.covered = r.covered;
    job.total = r.total;
    return sendJson(res, 200, { ok: true, created: r.experts.length, covered: r.covered, total: r.total });
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

  if (p === '/api/skills' && req.method === 'DELETE') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const folder = u.searchParams.get('folder') || '';
    const r = deleteSkillFolder(dir, folder);
    return sendJson(res, r.error ? 400 : 200, r);
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

  // 来源列表：自动扫描本机 Codex / Claude Code 的 Skill 目录 + 用户自定义目录
  if (p === '/api/sources' && req.method === 'GET') {
    return sendJson(res, 200, { sources: listSources(), default: DEFAULT_SKILLS_DIR });
  }
  // 移除一个自定义目录（内置来源不允许删）
  if (p === '/api/sources' && req.method === 'DELETE') {
    const dir = u.searchParams.get('dir') || '';
    if (BUILTIN_DIRS.has(dir)) return sendJson(res, 400, { error: '内置来源不能移除' });
    forgetDir(dir);
    return sendJson(res, 200, { ok: true, sources: listSources() });
  }

  // ---------- 工作台 ----------
  if (p === '/api/workbenches' && req.method === 'GET') {
    const list = workbenchDirs().map((dir) => {
      const exists = fs.existsSync(dir);
      const seen = lastSeenOf(dir);
      const t = exists ? scanTree(dir, seen, 3) : { total: 0, fresh: 0 };
      return { dir, label: path.basename(dir) || dir, exists, total: t.total, fresh: t.fresh,
               hasTasks: exists && fs.existsSync(path.join(dir, TASKS_FILE)) };
    });
    return sendJson(res, 200, { workbenches: list });
  }
  if (p === '/api/workbenches' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || '';
    if (!dir || !fs.existsSync(dir)) return sendJson(res, 400, { error: '目录不存在' });
    addWorkbench(dir);
    return sendJson(res, 200, { ok: true, dir });
  }
  if (p === '/api/workbenches' && req.method === 'DELETE') {
    removeWorkbench(u.searchParams.get('dir') || '');
    return sendJson(res, 200, { ok: true });
  }
  // 建骨架：_context/ + 阶段目录 + _tasks.md
  if (p === '/api/workbench/init' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || '';
    if (!dir || !fs.existsSync(dir)) return sendJson(res, 400, { error: '目录不存在' });
    try {
      const made = initWorkbench(dir, u.searchParams.get('template') || 'blank');
      addWorkbench(dir);
      return sendJson(res, 200, { ok: true, made });
    } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
  }
  // 目录树 + 任务，一次拉齐
  if (p === '/api/workbench') {
    const dir = u.searchParams.get('dir') || '';
    if (!dir || !fs.existsSync(dir)) return sendJson(res, 400, { error: '工作台目录不在了：' + dir });
    const seen = lastSeenOf(dir);
    const t = scanTree(dir, seen, 4);
    return sendJson(res, 200, {
      dir, label: path.basename(dir), tree: t.children, total: t.total, fresh: t.fresh,
      tasks: readTasks(dir), context: contextFiles(dir),
      hasTasks: fs.existsSync(path.join(dir, TASKS_FILE)),
      templates: Object.entries(WB_TEMPLATES).map(([id, v]) => ({ id, label: v.label })),
    });
  }
  // 读一个文件的正文（作品文件夹读它的 index.md）
  if (p === '/api/workbench/file') {
    const dir = u.searchParams.get('dir') || '';
    let target = u.searchParams.get('path') || '';
    if (!insideWorkbench(dir, target)) return sendJson(res, 400, { error: '越界，拒绝读取' });
    try {
      let real = target;
      let siblings = [];
      if (fs.statSync(target).isDirectory()) {
        real = ['index.md', 'INDEX.md'].map((f) => path.join(target, f)).find((x) => fs.existsSync(x)) || '';
        siblings = fs.readdirSync(target).filter((f) => !f.startsWith('.'));
      }
      if (!real) return sendJson(res, 200, { text: '', siblings, isDir: true, empty: true });
      const st = fs.statSync(real);
      if (st.size > 2 * 1024 * 1024) return sendJson(res, 200, { text: '（文件太大，去 Obsidian 里看）', siblings });
      if (!/\.(md|markdown|txt|json|ya?ml|csv)$/i.test(real)) {
        return sendJson(res, 200, { text: '', binary: true, file: real, siblings });
      }
      return sendJson(res, 200, { text: fs.readFileSync(real, 'utf8'), file: real, siblings, mtime: st.mtimeMs });
    } catch (e) { return sendJson(res, 400, { error: String(e.message || e) }); }
  }
  // 出任务口令
  if (p === '/api/workbench/prompt') {
    const dir = u.searchParams.get('dir') || '';
    const taskId = u.searchParams.get('task') || '';
    const target = u.searchParams.get('target') || '';
    const skillDir = u.searchParams.get('skillDir') || DEFAULT_SKILLS_DIR;
    const task = readTasks(dir).find((t) => t.id === taskId);
    if (!task) return sendJson(res, 404, { error: '任务不存在，看看 _tasks.md 改过没' });
    if (target && !insideWorkbench(dir, target)) return sendJson(res, 400, { error: '越界' });
    const prompt = buildTaskPrompt(dir, task, target, skillDir);
    return sendJson(res, 200, { prompt, chars: prompt.length, task: task.name });
  }
  // 把作品移到另一个目录（推进 / 退回 / 拖拽都走这里）
  if (p === '/api/workbench/move' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || '';
    const from = u.searchParams.get('from') || '';
    const toDir = u.searchParams.get('to') || '';
    if (!insideWorkbench(dir, from) || !insideWorkbench(dir, toDir)) return sendJson(res, 400, { error: '越界，拒绝移动' });
    if (!fs.existsSync(from)) return sendJson(res, 400, { error: '源文件已经不在了' });
    if (!fs.existsSync(toDir)) { try { fs.mkdirSync(toDir, { recursive: true }); } catch (_) {} }
    if (path.resolve(path.dirname(from)) === path.resolve(toDir)) return sendJson(res, 200, { ok: true, noop: true });
    let dest = path.join(toDir, path.basename(from));
    if (fs.existsSync(dest)) return sendJson(res, 400, { error: '目标目录里已经有同名的了：' + path.basename(from) });
    try { fs.renameSync(from, dest); } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
    return sendJson(res, 200, { ok: true, to: dest });
  }
  // 标记「都看过了」，清红点
  if (p === '/api/workbench/seen' && req.method === 'POST') {
    markSeen(u.searchParams.get('dir') || '');
    return sendJson(res, 200, { ok: true });
  }
  // 在 Obsidian / 访达里打开
  if (p === '/api/workbench/open' && req.method === 'POST') {
    const dir = u.searchParams.get('dir') || '';
    const target = u.searchParams.get('path') || '';
    const app = u.searchParams.get('app') || 'finder';
    if (!insideWorkbench(dir, target)) return sendJson(res, 400, { error: '越界' });
    try {
      if (app === 'obsidian') {
        spawn('open', [`obsidian://open?path=${encodeURIComponent(target)}`], { stdio: 'ignore', detached: true }).unref();
      } else {
        spawn('open', ['-R', target], { stdio: 'ignore', detached: true }).unref();
      }
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 500, { error: String(e.message || e) }); }
  }

  // 弹出 macOS 原生文件夹选择框，返回绝对路径
  if (p === '/api/pick-dir') {
    const dir = pickFolder(u.searchParams.get('prompt'));
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
  for (const s of listSources()) {
    const tag = s.builtin ? s.label : `自定义 ${s.label}`;
    console.log(`  ${s.exists ? '✓' : '✗'} ${tag}：${s.dir}${s.exists ? `（${s.count} 个 Skill）` : '（目录不存在）'}`);
  }
  console.log(`  检测到 agent：${AGENTS.map((a) => a.id).join(', ') || '（无，请装 codex 或 qodercli）'}\n`);
});
