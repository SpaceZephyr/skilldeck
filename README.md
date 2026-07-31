# SkillDeck · 可视化 Skill 控制台（技控台）

把本地一堆 Skill（自动扫描 Codex 和 Claude Code 两处，可能上百个）变成一面**卡片墙**：搜索、按分类筛选，挑一张点「使用」，**复制口令**粘到 Codex 就能跑。还能把相关 Skill 打包成**专家**（如「内容创作专家」「配图设计专家」），让 Codex 在整段对话里按你的关键词自动挑用。支持**深色 / 浅色**皮肤。

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

### 2. Skill 从哪来（自动扫描，不用手填路径）

启动时 SkillDeck 会自动扫描本机两个默认位置，扫到什么左侧栏就列什么：

| 来源 | 目录 |
|------|------|
| **Codex** | `~/.codex/skills` |
| **Claude Code** | `~/.claude/skills` |

每个来源右边的数字是扫到的 Skill 数量。目录不存在就标 **未安装** 并置灰，目录在但一个 `SKILL.md` 都没有就显示 `0`，点进去是空态页，页面上直接给一个「手动选择目录」的按钮。

想加别的目录，点左下角 **添加本地目录**（macOS 原生选择框），选完自动加进列表并切过去。自定义目录 hover 时右边有个 `×` 可以从列表移除（只是从列表里去掉，本地文件不动）。两个内置来源不能删。

界面层级是两级：

```
Codex / Claude Code / 自定义目录     ← 一级，左侧栏切换
   └── 技能 / 专家                   ← 二级，顶栏分段切换
```

切来源时**技能和专家一起换**，专家是按目录隔离的，Codex 下建的专家不会串到 Claude Code 里。顶栏右上角的刷新按钮可以重新扫描（新装了 Skill 之后点一下）。

SkillDeck 会读每个子文件夹里的 `SKILL.md`，解析名称/描述并**自动分类**成卡片。

### 3. 用一个 Skill

点任意卡片的「使用」→ 填写具体任务（可留空）→ 选口令类型 → 点「**复制口令**」→ 粘贴到 Codex 对话框发送。

- **路径口令**（默认，推荐）：`请调用 Skill：X ＋ 补充说明 ＋ SKILL.md 调用地址`。口令短，Codex 按地址自己读说明书，不依赖它有没有装这个 Skill。
- **完整口令**：把整篇 `SKILL.md` 注入口令里。换机器 / Codex 读不到那个路径时用。
- **本地运行**：不复制，直接让 SkillDeck 后端调用本机 `codex` / `qodercli` 跑，结果在右侧抽屉回显。

### 4. 打包成专家

切到顶栏「专家」：

- **让 Codex / Claude Code 自动分类**：**SkillDeck 不接任何大模型 API，不需要配 key。** 点一下会生成一段口令（里面装着完整 Skill 清单 + 聚类要求 + 一条回传命令），复制粘到 Codex 或 Claude Code 发送，它分好类后自己 `curl` 把结果回传，弹窗会实时轮询并显示「建了几个专家、覆盖了多少个 Skill」。agent 不方便跑 curl 的话，展开「把它输出的 JSON 贴这里」手动导入也行。
- **手动创建**：填名字和描述 → 勾选要归入的 Skill → 保存。

回传的结果会做校验：`skills` 里对不上真实 folder 的一律丢掉，模型编出来的假 Skill 进不了库。口令带一次性 token，过期或无效会明确报错。

专家的「使用」也是复制口令，但内容是——让 Codex 在**本轮对话**里随时按你的关键词自动挑用这组 Skill，并在每完成一步后主动提示接下来还能用哪些 Skill。

### 5. 删除 Skill / 专家

两种卡片右下角都有一个垃圾桶按钮，**点了一定会先弹二次确认**，没有任何路径能绕过。

| 删什么 | 实际发生什么 |
|--------|-------------|
| **Skill** | 本地文件夹**移到系统废纸篓**（不是 `rm -rf`），误删可在访达里找回。同时把它从所有引用它的专家里摘掉，确认框会提前告诉你有几个专家受影响 |
| **专家** | 只删 `experts.json` 里的这条分组记录，组里的 Skill 文件一个都不动 |

删 Skill 的确认框里会显示完整路径，删之前看清楚再点。后端有多层防护：Skill 名里出现 `/`、`\`、`..` 一律拒绝；解析后的路径必须正好是当前 Skill 目录的直接子目录；文件夹里必须真的有 `SKILL.md`，否则拒绝删除。

### 6. 换皮肤

左下角 **深色 / 浅色** 一键切换，选择会记住。

### 界面说明

界面里没有任何 emoji，图标全是内联 SVG（跟着文字颜色走，深浅色皮肤都自适应）。Codex 和 Claude Code 用各自的官方 logo，自定义目录用文件夹图标。专家卡片用名字首字做标记。

---

## 零密钥

**SkillDeck 不需要任何 API Key。** 早期版本会直连 DeepSeek 做专家聚类，现在这条路已经整个拿掉了：聚类交给你本来就在用的 Codex / Claude Code，SkillDeck 只负责出口令、开一个本机回传口子、显示结果。

所以：

- 代码里没有任何模型 API 调用，也没有「模型设置」界面
- `/api/config` 只返回默认目录和检测到的本地 agent
- 不再读写 `.skilldeck.local.json`（老用户的这个文件可以直接删掉）
- `experts.json` 仍在 `.gitignore` 里，专家数据不进仓库

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
├── server.js                     独立 web 版后端（零依赖）：来源扫描 / Skill 解析 / 口令 / 专家 / 分类任务回传
├── public/                       独立 web 版前端
│   ├── index.html                侧边栏来源列表 + 顶栏分段 + 各弹窗（含删除确认）
│   ├── app.js                    来源切换、视图切换、口令复制、删除确认、专家增删、分类任务、主题
│   ├── icons.js                  图标系统：Claude / OpenAI 官方 logo + 线性图标，全内联 SVG
│   └── style.css                 深/浅两套主题（CSS 变量）
├── experts.json                  专家数据（本地；被 gitignore）
├── mcp/                          Codex 原生 widget 形态（server.mjs / widget / 桥接）
└── scripts/probe.mjs             不需 codex 的验证探针
```

## Skill 卡片的自动分类规则

按 `name + description` 关键词分成：写作 / 标题·爆款 / 图片·设计 / PPT·幻灯片 / 视频·音频 / 产品·PM / 飞书·协作 / 编程·开发 / 信息获取 / 数据·表格 / 其它。规则在 `server.js` 的 `CATEGORY_RULES`。
