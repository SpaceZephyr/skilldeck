// SkillDeck MCP server —— 把 SkillDeck 渲染成 Codex 原生 widget，
// 点「使用」时通过 sendFollowUpMessage 把 Skill 命令送进 Codex 会话执行。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inlineWidget, registerWidgetResource, readText } from './lib/widget-resource.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_URI = 'ui://widget/skilldeck/deck.html';
const DEFAULT_SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills');

// ---------- Skill 解析（与独立版一致，支持 YAML 块标量） ----------
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
    } else { val = val.trim(); i++; }
    out[key] = val;
  }
  return out;
}

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
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { error: `无法读取目录：${dir}（${e.code}）`, skills: [], dir }; }
  const skills = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const cand = ['SKILL.md', 'skill.md', 'Skill.md']
      .map((f) => path.join(dir, ent.name, f)).find((p) => fs.existsSync(p));
    if (!cand) continue;
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(cand, 'utf8')); } catch {}
    const name = fm.name || ent.name;
    const desc = fm.description || '（无描述）';
    const oneLine = (desc.split(/。|\.\s|；|当用户|触发/)[0] || desc).slice(0, 60);
    skills.push({ id: ent.name, name, folder: ent.name, oneLine, description: desc, category: classify(name, desc) });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { skills, dir };
}

// ---------- widget ----------
function widgetHtml() {
  return inlineWidget({
    html: readText(__dirname, 'widget', 'index.html'),
    css: readText(__dirname, 'widget', 'ui.css'),
    js: readText(__dirname, 'widget', 'ui.js'),
  });
}

const server = new McpServer({ name: 'skilldeck', version: '0.2.0' });

registerWidgetResource(server, {
  name: 'skilldeck-widget',
  uri: WIDGET_URI,
  title: 'SkillDeck',
  description: '可视化 Skill 控制台：卡片浏览本地 Skill，点使用把该 Skill 的命令发送到 Codex 输入框执行。',
  html: async () => widgetHtml(),
});

registerAppTool(
  server,
  'open_skilldeck',
  {
    title: '打开 SkillDeck 技控台',
    description:
      '打开 SkillDeck 原生 widget，卡片浏览本地 Skill（默认 ~/.claude/skills）。用户点某个 Skill 的「使用」后，widget 会把该 Skill 的命令通过 sendFollowUpMessage 发送到当前 Codex 会话去执行。',
    inputSchema: { dir: z.string().trim().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: WIDGET_URI, visibility: ['model', 'app'] },
      'ui/resourceUri': WIDGET_URI,
      'openai/outputTemplate': WIDGET_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': '打开 SkillDeck…',
      'openai/toolInvocation/invoked': 'SkillDeck 已打开',
    },
  },
  async (input = {}) => {
    const dir = (input.dir || '').trim() || DEFAULT_SKILLS_DIR;
    const { skills, error } = readSkills(dir);
    return {
      content: [{ type: 'text', text: error ? `SkillDeck: ${error}` : `SkillDeck 已打开，读取到 ${skills.length} 个 Skill。` }],
      structuredContent: { dir, skills, error: error || null },
      _meta: { 'openai/outputTemplate': WIDGET_URI, widgetData: { dir, skills, error: error || null } },
    };
  }
);

// 刷新 / 换目录用：widget 通过 callServerTool 调用
server.registerTool(
  'list_skills',
  {
    title: 'List Skills',
    description: '读取指定目录（默认 ~/.claude/skills）的 Skill 列表，供 SkillDeck widget 刷新。',
    inputSchema: { dir: z.string().trim().optional() },
    _meta: { 'openai/widgetAccessible': true },
  },
  async (input = {}) => {
    const dir = (input.dir || '').trim() || DEFAULT_SKILLS_DIR;
    const r = readSkills(dir);
    return { content: [{ type: 'text', text: `${(r.skills || []).length} skills @ ${dir}` }], structuredContent: r };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
