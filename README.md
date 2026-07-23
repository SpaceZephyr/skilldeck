# SkillDeck · 可视化 Skill 控制台（技控台）

把本地的一堆 Skill（默认 `~/.claude/skills`，可能上百个）变成一面**卡片墙**：每张卡显示 Skill 名称、一句话介绍、分类。挑一张点「使用」，确认后把该 Skill 的命令**送进 Codex 的输入框**，由 Codex 直接执行。

对标 [Cowart](https://github.com/zhongerxin/Cowart) / cowrite 的「Codex 原生 widget」做法。

---

## 两种形态

SkillDeck 有两套跑法，用途不同：

### A. Codex 原生 widget 插件（推荐，`mcp/`）—— 命令送进 Codex 执行

这是主形态，跟 Cowart 一样：SkillDeck 作为 **Codex 插件**，把卡片墙渲染成 Codex 里的**原生 widget**。点「使用」→ 弹窗确认 → 通过 `sendFollowUpMessage` 把命令**发送到当前 Codex 会话**，Codex 收到后自己执行（结果出现在你和 Codex 的对话里，而不是另开一个面板）。

**装成 Codex 插件：**

```bash
# 1. 装依赖
cd skilldeck && npm install

# 2. clone 到 Codex 插件位置（或直接用当前目录）
#    确保 .codex-plugin/plugin.json 存在

# 3. 注册 personal marketplace 并安装
codex plugin marketplace add ~
codex plugin add skilldeck@personal
```

装好后开一个新的 Codex 对话，对它说「打开 SkillDeck」，就会弹出卡片墙 widget。

> ⚠️ 这套形态**必须在 Codex（或兼容 MCP Apps widget 的宿主）里运行**才能真正「发送到输入框」。本机没装 codex 时无法端到端演示；MCP server 本身、widget 渲染、桥接注入都已通过 `node scripts/probe.mjs` 验证正确。

**验证 server 正确性（不需要 codex）：**

```bash
node scripts/probe.mjs
# 输出：工具 open_skilldeck/list_skills、读到 N 个 Skill、widget HTML 含桥接
```

### B. 独立 web 版（`server.js`）—— SkillDeck 自己跑 agent

不想装插件、只想在浏览器里用时的备用形态：SkillDeck 起一个本地网页，点「使用」后**由 SkillDeck 后端自己调 `codex exec` / `qodercli -p`** 跑，结果在右侧面板流式回显。跟形态 A 的区别是「谁来执行」——这里是 SkillDeck 执行并显示，不是送进你的 Codex 会话。

```bash
node server.js   # 打开 http://localhost:4177
```

零依赖，Node ≥ 18。这套里默认走**注入式**：把 Skill 的 SKILL.md 正文塞进命令，任何 agent 都能照着做（详见下）。

---

## 用户操作路径（形态 A）

| 步骤 | 说明 |
|------|------|
| ① 打开 | 在 Codex 里说「打开 SkillDeck」→ 弹出 widget 卡片墙 |
| ② 浏览 | 卡片墙，可搜索、按分类筛选 |
| ③ 使用 | 点卡片「使用」→ 弹窗：填具体任务 + **预览将发送的命令** |
| ④ 发送 | 点「确认发送到 Codex」→ 命令进入 Codex 会话，Codex 执行 |

## 关键机制：sendFollowUpMessage

「送到 Codex 输入框」靠的是 MCP Apps（ext-apps）的 widget↔host 桥：widget 里调
`window.skilldeckMcp.sendFollowUpMessage(prompt)` → host 的 `app.sendMessage({role:'user', content})`，
把这条消息作为一次用户输入送进 Codex 会话。这是 Cowart 的同款做法。

> 桥接层 `mcp/lib/widget-resource.mjs` 改编自 Cowart（MIT, © 2026 Twox），做了 SkillDeck 化重命名。

## 文件结构

```
skilldeck/
├── .codex-plugin/plugin.json   Codex 插件清单
├── .mcp.json                    MCP server 配置
├── mcp/
│   ├── server.mjs               MCP server：读 Skill / 分类 / 注册 widget+工具
│   ├── lib/widget-resource.mjs  widget 桥接（改编自 Cowart, MIT）
│   └── widget/                  widget UI（卡片墙 + 确认弹窗 + sendFollowUpMessage）
│       ├── index.html
│       ├── ui.css
│       └── ui.js
├── scripts/probe.mjs            不需 codex 的验证探针
├── server.js                    形态 B：独立 web 版（自跑 agent）
└── public/                      形态 B 的前端
```

## 自动分类

按 `name + description` 关键词分成：写作 / 标题·爆款 / 图片·设计 / PPT·幻灯片 / 视频·音频 / 产品·PM / 飞书·协作 / 编程·开发 / 信息获取 / 数据·表格 / 其它。规则在 `mcp/server.mjs` 的 `CATEGORY_RULES`。

## 命名

**SkillDeck**——「deck」一语双关：一副技能卡组 + 控制台（control deck）。中文「技控台」。

## 待办

- 形态 A 的注入式选项（把 SKILL.md 正文一起送，兼容未注册该 Skill 的宿主）
- 收藏常用 Skill、发送历史
- widget 内直接换 Skill 目录（已有 list_skills 工具支持刷新）
