# SkillDeck · 可视化 Skill 控制台（技控台）

把本地一堆 Skill（默认 `~/.claude/skills`，可能上百个）变成一面**卡片墙**：搜索、按分类筛选，挑一张点「使用」，**复制口令**粘到 Codex 就能跑。还能把相关 Skill 打包成**专家**（如「内容创作专家」「配图设计专家」），让 Codex 在整段对话里按你的关键词自动挑用。支持**深色 / 浅色**皮肤。

> 「deck」一语双关：一副技能卡组 + 控制台（control deck）。

---

## 首次使用（独立 web 版，推荐先跑这个）

**零依赖**，只需要 Node ≥ 18。

### 1. 启动

```bash
cd skilldeck
node server.js
# 打开 http://localhost:4177
```

### 2. 导入你的 Skill

顶栏输入框默认填的是 `~/.claude/skills`。改成你自己的 Skill 目录后点「导入 / 刷新」。
SkillDeck 会递归读取每个子文件夹里的 `SKILL.md`，解析名称/描述并**自动分类**成卡片。

### 3. 配置大模型（只有用「AI 自动分类专家」才需要）

点左下角 **⚙️ 模型设置**，填三个字段并保存：

| 字段 | 示例 |
|------|------|
| API URL | `https://api.deepseek.com` |
| 模型名称 | `deepseek-v4-pro` |
| API Key | `sk-...`（你自己的密钥） |

> 密钥只写到本机 `.skilldeck.local.json`，**已加入 `.gitignore`，不会提交到仓库，也不会下发到网页**。详见下方「密钥安全」。

### 4. 用一个 Skill

点任意卡片的「使用」→ 填写具体任务（可留空）→ 选口令类型 → 点「**复制口令**」→ 粘贴到 Codex 对话框发送。

- **路径口令**（默认，推荐）：`请调用 Skill：X ＋ 补充说明 ＋ SKILL.md 调用地址`。口令短，Codex 按地址自己读说明书，不依赖它有没有装这个 Skill。
- **完整口令**：把整篇 `SKILL.md` 注入口令里。换机器 / Codex 读不到那个路径时用。
- **本地运行**：不复制，直接让 SkillDeck 后端调用本机 `codex` / `qodercli` 跑，结果在右侧抽屉回显。

### 5. 打包成专家

进左侧「🧠 专家」：

- **✨ AI 自动分类**：点一下，大模型读全部 Skill，按用途聚成若干专家并保存（重推理模型约 1–2 分钟，按钮有进度提示）。
- **＋ 手动创建**：填名字 / emoji / 描述 → 勾选要归入的 Skill → 保存。

专家的「使用」也是复制口令，但内容是——让 Codex 在**本轮对话**里随时按你的关键词自动挑用这组 Skill，并在每完成一步后主动提示接下来还能用哪些 Skill。

### 6. 换皮肤

左下角 **🌙 深色 / ☀️ 浅色** 一键切换，选择会记住。

---

## 密钥安全

密钥有三种来源，优先级 **环境变量 > 本地配置文件**：

1. **界面配置**（最省事）：⚙️ 模型设置里填，写入 `.skilldeck.local.json`。
2. **手动建配置文件**：复制模板再填 key：
   ```bash
   cp .skilldeck.local.example.json .skilldeck.local.json
   # 编辑 .skilldeck.local.json，把 deepseekApiKey 换成你自己的
   ```
3. **环境变量**：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL`。

保障：
- `.skilldeck.local.json`、`experts.json` 都在 `.gitignore` 里，**永不进仓库**。
- `/api/config` 只返回「是否已配置 + 模型名 + URL」，**从不下发密钥**；设置弹窗里 Key 输入框始终为空，留空即保持原值。
- 仓库里只提交不含真实密钥的 `.skilldeck.local.example.json` 模板。

---

## Codex 原生 widget（另一种形态）

除了独立 web 版，SkillDeck 也能作为 **Codex 插件**，把卡片墙渲染成 Codex 里的原生 widget，点「使用」通过 `sendFollowUpMessage` 把命令直接发进当前 Codex 会话（这套改编自 [Cowart](https://github.com/zhongerxin/Cowart)）。

```bash
npm install            # 这套形态要装 MCP 依赖
codex plugin marketplace add ~
codex plugin add skilldeck@personal
```

装好后在 Codex 里说「打开 SkillDeck」即可。不需要 codex 也能验证 server：

```bash
node scripts/probe.mjs   # 输出工具列表、读到的 Skill 数、widget 桥接是否注入
```

---

## 文件结构

```
skilldeck/
├── server.js                     独立 web 版后端（零依赖）：Skill 解析 / 口令 / 专家 / DeepSeek 分类
├── public/                       独立 web 版前端
│   ├── index.html                侧边栏 + Skill/专家视图 + 各弹窗
│   ├── app.js                    视图切换、口令复制、专家增删、主题、设置
│   └── style.css                 深/浅两套主题（CSS 变量）
├── .skilldeck.local.example.json 模型配置模板（提交；不含真实密钥）
├── .skilldeck.local.json         真实模型配置（本地；被 gitignore）
├── experts.json                  专家数据（本地；被 gitignore）
├── mcp/                          Codex 原生 widget 形态（server.mjs / widget / 桥接）
└── scripts/probe.mjs             不需 codex 的验证探针
```

## 自动分类规则

按 `name + description` 关键词分成：写作 / 标题·爆款 / 图片·设计 / PPT·幻灯片 / 视频·音频 / 产品·PM / 飞书·协作 / 编程·开发 / 信息获取 / 数据·表格 / 其它。规则在 `server.js` 的 `CATEGORY_RULES`。
