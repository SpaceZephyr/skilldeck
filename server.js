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

// 读取某个 Skill 的 SKILL.md 正文（去掉 frontmatter），用于注入到命令
function getSkillBody(dir, folder) {
  const p = ['SKILL.md', 'skill.md', 'Skill.md']
    .map((f) => path.join(dir, folder, f))
    .find((x) => fs.existsSync(x));
  if (!p) return '';
  const md = fs.readFileSync(p, 'utf8');
  return md.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  if (p === '/' ) return serveStatic(res, 'index.html');
  if (p === '/app.js' || p === '/style.css') return serveStatic(res, p.slice(1));

  if (p === '/api/config') {
    return sendJson(res, 200, {
      defaultDir: DEFAULT_SKILLS_DIR,
      agents: AGENTS.map((a) => a.id),
    });
  }

  if (p === '/api/skills') {
    const dir = u.searchParams.get('dir') || DEFAULT_SKILLS_DIR;
    const result = readSkills(dir);
    return sendJson(res, 200, result);
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
    // 参数数组传参，避免命令注入
    const child = spawn(cmd.bin, cmd.args, { env: { ...process.env, PATH: CHILD_PATH } });
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
