// SkillDeck 前端逻辑
const $ = (s) => document.querySelector(s);
const state = {
  skills: [], filtered: [], cat: '全部', q: '',
  agents: [], current: null, prompt: '', es: null,
  experts: [], currentExpert: null, picked: new Set(), view: 'skills',
  sources: [], source: null,
};
// 当前来源目录。所有取目录的地方都走这里，没选中来源时为空字符串。
const curDir = () => (state.source && state.source.dir) || '';

// ---------- 主题（深色/浅色）----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  const btn = $('#theme-toggle');
  if (btn) btn.innerHTML = icon(light ? 'sun' : 'moon') + `<span id="theme-label">${light ? '浅色' : '深色'}</span>`;
}
function initTheme() {
  const saved = localStorage.getItem('skilldeck-theme') || 'dark';
  applyTheme(saved);
  const btn = $('#theme-toggle');
  if (btn) btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('skilldeck-theme', next);
    applyTheme(next);
  });
}

// 一次性把静态位置的图标画上
function paintStaticIcons() {
  $('#brand-logo').innerHTML = icon('layers', 18);
  $('#pick').innerHTML = icon('plus') + '添加本地目录';
  $('#reload').innerHTML = icon('refresh');
  $('#exp-auto').innerHTML = icon('spark') + '让 Codex / Claude Code 自动分类';
  $('#exp-manual').innerHTML = icon('plus') + '手动创建专家';
  const seg = document.querySelectorAll('.seg-item');
  seg[0].insertAdjacentHTML('afterbegin', icon('deck', 15));
  seg[1].insertAdjacentHTML('afterbegin', icon('expert', 15));
  $('#cf-ico').innerHTML = icon('warn', 20);
}

async function boot() {
  paintStaticIcons();
  initTheme();
  const cfg = await fetch('/api/config').then((r) => r.json());
  state.agents = cfg.agents || [];
  const sel = $('#agent');
  sel.innerHTML = state.agents.length
    ? state.agents.map((a) => `<option value="${a}">${a}</option>`).join('')
    : '<option value="">未检测到 agent</option>';
  wireNav();
  await loadSources();
}

// ---------- 删除二次确认 ----------
// 所有删除都必须过这里，没有任何一条路径能绕开确认直接删。
let confirmAction = null;
function askConfirm({ title, body, target, note, okText, onOk }) {
  confirmAction = onOk;
  $('#cf-title').textContent = title;
  $('#cf-body').textContent = body;
  $('#cf-target').textContent = target || '';
  $('#cf-target').style.display = target ? 'block' : 'none';
  $('#cf-note').textContent = note || '';
  $('#cf-note').style.display = note ? 'block' : 'none';
  $('#cf-ok').textContent = okText || '确认删除';
  $('#confirm-modal').style.display = 'grid';
}
function closeConfirm() {
  $('#confirm-modal').style.display = 'none';
  confirmAction = null;
}
$('#cf-cancel').addEventListener('click', closeConfirm);
$('#cf-ok').addEventListener('click', async () => {
  const fn = confirmAction;
  if (!fn) return closeConfirm();
  const btn = $('#cf-ok');
  btn.disabled = true;
  try { await fn(); } finally { btn.disabled = false; closeConfirm(); }
});
$('#confirm-modal').addEventListener('click', (e) => { if (e.target.id === 'confirm-modal') closeConfirm(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#confirm-modal').style.display === 'grid') closeConfirm(); });

// ---------- 一级：Skill 来源 ----------
// 启动时后端已自动扫过 ~/.codex/skills 和 ~/.claude/skills，这里只负责渲染和挑一个激活。
async function loadSources(keepId) {
  let data = { sources: [] };
  try { data = await fetch('/api/sources').then((r) => r.json()); } catch (_) {}
  state.sources = data.sources || [];
  const wanted = keepId || (state.source && state.source.id) || localStorage.getItem('skilldeck-source');
  const pick =
    state.sources.find((s) => s.id === wanted && s.exists) ||   // 上次用的
    state.sources.find((s) => s.exists && s.count > 0) ||        // 第一个真有 Skill 的
    state.sources.find((s) => s.exists) ||                       // 目录在但空的
    state.sources[0] || null;                                    // 全都没有
  renderSources();
  await selectSource(pick, true);
}
function renderSources() {
  $('#src-list').innerHTML = state.sources
    .map((s, i) => {
      const active = state.source && s.id === state.source.id;
      const badge = !s.exists ? '未安装' : String(s.count); // 注意转字符串，否则 0 会被 esc 吞掉
      // 注意：这里必须用 div 而不是 button，否则内层的删除 button 会被浏览器提升出去，布局直接散架
      const del = s.builtin ? '' : `<span class="src-del" data-del="${i}" title="从列表移除">${icon('close', 13)}</span>`;
      return `<div class="src-item ${active ? 'active' : ''} ${s.exists ? '' : 'missing'}" role="button" tabindex="0" data-i="${i}" title="${esc(s.dir)}">
        <span class="src-ico">${sourceIcon(s, 15)}</span>
        <span class="src-text">${esc(s.label)}</span>
        <span class="src-n">${esc(badge)}</span>${del}
      </div>`;
    })
    .join('');
  $('#src-list').querySelectorAll('.src-item').forEach((el) =>
    el.addEventListener('click', () => selectSource(state.sources[+el.dataset.i]))
  );
  $('#src-list').querySelectorAll('.src-del').forEach((el) =>
    el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const s = state.sources[+el.dataset.del];
      if (!s) return;
      await fetch('/api/sources?dir=' + encodeURIComponent(s.dir), { method: 'DELETE' });
      toast('已从列表移除（本地文件没动）');
      if (state.source && state.source.id === s.id) state.source = null;
      await loadSources();
    })
  );
}
// 切换来源：技能和专家一起换
async function selectSource(src, silent) {
  state.source = src || null;
  if (src) localStorage.setItem('skilldeck-source', src.id);
  $('#src-icon').innerHTML = src ? sourceIcon(src, 17) : '';
  $('#src-name').textContent = src ? src.label : '没有可用的 Skill 来源';
  $('#src-path').textContent = src ? src.dir : '点左侧「添加本地目录」手动选一个';
  state.cat = '全部';
  state.q = '';
  const box = $('#search'); if (box) box.value = '';
  renderSources();
  await loadSkills();
  await loadExperts();
  if (!silent && src) toast(`已切到 ${src.label}`);
}

// ---------- 二级：技能 / 专家 ----------
function wireNav() {
  document.querySelectorAll('.seg-item').forEach((el) =>
    el.addEventListener('click', () => switchView(el.dataset.view))
  );
}
function switchView(v) {
  state.view = v;
  document.querySelectorAll('.seg-item').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  $('#view-skills').hidden = v !== 'skills';
  $('#view-experts').hidden = v !== 'experts';
}

// ---------- Skill 列表 ----------
// 空态统一走这里：说清楚扫了哪个目录、为什么是空的，并给一个手动选目录的出口
function showEmpty(title, detail) {
  $('#grid').innerHTML = '';
  $('#count').textContent = '';
  $('#seg-skills-n').textContent = '';
  $('#cats').innerHTML = '';
  $('#view-skills').querySelector('.toolbar').hidden = true; // 一个 Skill 都没有时，搜索框和分类条没意义
  const el = $('#empty');
  el.style.display = 'block';
  el.innerHTML =
    `<div class="empty-title">${esc(title)}</div>` +
    (detail ? `<div class="empty-path">${esc(detail)}</div>` : '') +
    `<button class="btn" id="empty-pick">` + icon('folder') + `手动选择目录</button>`;
  $('#empty-pick').addEventListener('click', pickDir);
}

async function loadSkills() {
  const dir = curDir();
  if (!dir) {
    state.skills = [];
    renderCats();
    return showEmpty('没有扫描到本地 Skill 目录', '默认会找 ~/.codex/skills 和 ~/.claude/skills，都没有的话手动选一个。');
  }
  $('#count').textContent = '读取中…';
  const data = await fetch('/api/skills?dir=' + encodeURIComponent(dir)).then((r) => r.json());
  if (data.error) {
    state.skills = [];
    renderCats();
    return showEmpty('这个目录读不了', data.error);
  }
  state.skills = data.skills || [];
  if (!state.skills.length) {
    renderCats();
    return showEmpty(`${state.source ? state.source.label : '这个来源'} 里还没有 Skill`, `扫描目录：${dir}（没找到任何带 SKILL.md 的子文件夹）`);
  }
  $('#empty').style.display = 'none';
  $('#view-skills').querySelector('.toolbar').hidden = false;
  $('#seg-skills-n').textContent = state.skills.length;
  renderCats();
  applyFilter();
}
function skillByFolder(folder) {
  return state.skills.find((s) => s.folder === folder);
}

function renderCats() {
  const cats = ['全部', ...Array.from(new Set(state.skills.map((s) => s.category)))];
  $('#cats').innerHTML = cats
    .map((c) => `<span class="cat ${c === state.cat ? 'active' : ''}" data-cat="${c}">${c}</span>`)
    .join('');
  document.querySelectorAll('.cat').forEach((el) =>
    el.addEventListener('click', () => { state.cat = el.dataset.cat; renderCats(); applyFilter(); })
  );
}
function applyFilter() {
  const q = state.q.toLowerCase();
  state.filtered = state.skills.filter((s) => {
    const okCat = state.cat === '全部' || s.category === state.cat;
    const okQ = !q || (s.name + s.description).toLowerCase().includes(q);
    return okCat && okQ;
  });
  renderGrid();
}
function renderGrid() {
  $('#count').textContent = `共 ${state.filtered.length} 个 Skill`;
  $('#grid').innerHTML = state.filtered
    .map((s, i) => `
    <div class="card">
      <div class="card-top">
        <div class="card-name">${esc(s.name)}</div>
        <span class="card-cat">${esc(s.category)}</span>
      </div>
      <div class="card-desc">${esc(s.oneLine)}</div>
      <div class="card-foot">
        <span class="card-folder">${esc(s.folder)}</span>
        <div class="card-acts">
          <button class="del-btn" data-del="${i}" title="删除这个 Skill">${icon('trash', 15)}</button>
          <button class="use-btn" data-i="${i}">使用</button>
        </div>
      </div>
    </div>`)
    .join('');
  document.querySelectorAll('#grid .use-btn').forEach((el) =>
    el.addEventListener('click', () => openModal(state.filtered[+el.dataset.i]))
  );
  document.querySelectorAll('#grid .del-btn').forEach((el) =>
    el.addEventListener('click', () => askDeleteSkill(state.filtered[+el.dataset.del]))
  );
}

// 删 Skill：连带把本地文件夹移进废纸篓，所以确认框里要把路径和后果讲清楚
function askDeleteSkill(skill) {
  if (!skill) return;
  const used = state.experts.filter((e) => (e.skills || []).includes(skill.folder));
  askConfirm({
    title: `删除 Skill「${skill.name}」`,
    body: '这个 Skill 的本地文件夹会被移到系统废纸篓，卡片墙上也会消失。误删了可以去废纸篓找回。',
    target: skill.path,
    note: used.length ? `注意：有 ${used.length} 个专家引用了它（${used.map((e) => e.name).join('、')}），会一并把它从这些专家里摘掉。` : '',
    okText: '移到废纸篓',
    onOk: async () => {
      const r = await fetch(`/api/skills?dir=${encodeURIComponent(curDir())}&folder=${encodeURIComponent(skill.folder)}`, { method: 'DELETE' })
        .then((x) => x.json()).catch((e) => ({ error: String(e.message || e) }));
      if (r.error) return toast('删除失败：' + r.error);
      toast(r.trashed ? `已移到废纸篓：${skill.name}` : `已删除：${skill.name}`);
      await loadSources();  // 重扫，侧栏计数跟着更新
    },
  });
}

// ---------- Skill 使用弹窗 ----------
function currentMode() {
  const el = document.querySelector('input[name="m-mode"]:checked');
  return el ? el.value : 'path';
}
function openModal(skill) {
  state.current = skill;
  state.prompt = '';
  $('#m-name').textContent = skill.name;
  $('#m-cat').textContent = skill.category;
  $('#m-desc').textContent = skill.description;
  $('#m-task').value = '';
  updatePrompt();
  $('#modal').style.display = 'grid';
}
async function updatePrompt() {
  const skill = state.current;
  if (!skill) return;
  const task = $('#m-task').value.trim();
  const url = `/api/prompt?skill=${encodeURIComponent(skill.name)}&folder=${encodeURIComponent(skill.folder)}&dir=${encodeURIComponent(curDir())}&task=${encodeURIComponent(task)}&mode=${currentMode()}`;
  $('#m-cmd').textContent = '生成口令中…';
  try {
    const data = await fetch(url).then((r) => r.json());
    state.prompt = data.prompt || '';
    $('#m-cmd').textContent = state.prompt;
    $('#m-chars').textContent = data.chars ? `· ${data.chars} 字` : '';
  } catch (e) {
    $('#m-cmd').textContent = '（生成口令失败）';
    state.prompt = '';
  }
}
let promptTimer = null;
$('#m-task').addEventListener('input', () => { clearTimeout(promptTimer); promptTimer = setTimeout(updatePrompt, 200); });
document.querySelectorAll('input[name="m-mode"]').forEach((el) =>
  el.addEventListener('change', () => { if (state.current) updatePrompt(); })
);
$('#m-close').addEventListener('click', closeModal);
$('#m-cancel').addEventListener('click', closeModal);
function closeModal() { $('#modal').style.display = 'none'; }

// ---------- 复制 ----------
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
$('#m-copy').addEventListener('click', async () => {
  if (!state.prompt) { toast('口令还没生成好，稍等一下'); return; }
  const ok = await copyText(state.prompt);
  if (ok) { toast('已复制，去 Codex 对话框粘贴发送即可'); closeModal(); }
  else { toast('复制失败，请手动全选下方口令复制'); }
});

// ---------- 本地运行 ----------
$('#m-run').addEventListener('click', () => {
  const agent = $('#agent').value;
  if (!agent) { toast('没有可用的本地 agent，请先装 codex 或 qodercli'); return; }
  const skill = state.current;
  const task = $('#m-task').value.trim();
  closeModal();
  runSkill(agent, skill, task);
});

// ---------- 专家 ----------
async function loadExperts() {
  const dir = curDir();
  if (!dir) { state.experts = []; return renderExperts(); }
  const data = await fetch('/api/experts?dir=' + encodeURIComponent(dir)).then((r) => r.json()).catch(() => ({ experts: [] }));
  state.experts = data.experts || [];
  renderExperts();
}
function renderExperts() {
  $('#exp-count').textContent = state.experts.length ? `共 ${state.experts.length} 个专家` : '';
  $('#seg-experts-n').textContent = state.experts.length || '';
  $('#exp-empty').style.display = state.experts.length ? 'none' : 'block';
  $('#exp-empty').textContent = state.skills.length
    ? `${state.source ? state.source.label : '这个来源'} 下还没有专家。点上面「AI 自动分类」让大模型按用途把这些 Skill 打包成专家，或手动挑 Skill 创建。`
    : '这个来源还没扫到 Skill，先在左侧换个来源或添加目录，再回来创建专家。';
  $('#exp-grid').innerHTML = state.experts
    .map((e, i) => {
      const names = (e.skills || []).map((f) => { const s = skillByFolder(f); return s ? s.name : f; });
      const preview = names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
      return `
      <div class="card exp-card">
        <div class="card-top">
          <div class="card-name"><span class="exp-mark">${esc((e.name || '?').slice(0, 1))}</span>${esc(e.name)}</div>
          <span class="card-cat">${(e.skills || []).length} 个</span>
        </div>
        <div class="card-desc">${esc(e.description || '')}</div>
        <div class="exp-skills-preview">${esc(preview)}</div>
        <div class="card-foot">
          <span class="card-folder">${e.source === 'auto' ? 'AI 生成' : '手动'}</span>
          <div class="card-acts">
            <button class="del-btn" data-del="${i}" title="删除这个专家">${icon('trash', 15)}</button>
            <button class="use-btn" data-i="${i}">使用</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
  document.querySelectorAll('#exp-grid .use-btn').forEach((el) =>
    el.addEventListener('click', () => openExpertModal(state.experts[+el.dataset.i]))
  );
  document.querySelectorAll('#exp-grid .del-btn').forEach((el) =>
    el.addEventListener('click', () => askDeleteExpert(state.experts[+el.dataset.del]))
  );
}

// 删专家：只动 experts.json 里的这条记录，组里的 Skill 文件一个都不碰
function askDeleteExpert(expert) {
  if (!expert) return;
  askConfirm({
    title: `删除专家「${expert.name}」`,
    body: `只删掉这个专家分组，组里的 ${(expert.skills || []).length} 个 Skill 本身不受影响，本地文件一个都不会动。`,
    target: '',
    note: '',
    okText: '删除专家',
    onOk: async () => {
      await fetch(`/api/experts?id=${encodeURIComponent(expert.id)}`, { method: 'DELETE' });
      toast(`已删除专家：${expert.name}`);
      $('#exp-modal').style.display = 'none';
      await loadSources();
    },
  });
}
async function openExpertModal(expert) {
  state.currentExpert = expert;
  $('#em-name').textContent = expert.name;
  $('#em-count').textContent = `${(expert.skills || []).length} 个 Skill · ${expert.source === 'auto' ? 'AI 生成' : '手动'}`;
  $('#em-desc').textContent = expert.description || '';
  $('#em-skills').innerHTML = (expert.skills || [])
    .map((f) => { const s = skillByFolder(f); return `<span class="em-chip">${esc(s ? s.name : f)}</span>`; })
    .join('');
  $('#em-cmd').textContent = '生成口令中…';
  $('#exp-modal').style.display = 'grid';
  try {
    const data = await fetch(`/api/expert-prompt?id=${encodeURIComponent(expert.id)}&dir=${encodeURIComponent(curDir())}`).then((r) => r.json());
    state.prompt = data.prompt || '';
    $('#em-cmd').textContent = state.prompt;
    $('#em-chars').textContent = data.chars ? `· ${data.chars} 字` : '';
  } catch (e) {
    $('#em-cmd').textContent = '（生成口令失败）';
    state.prompt = '';
  }
}
$('#em-close').addEventListener('click', () => ($('#exp-modal').style.display = 'none'));
$('#em-cancel').addEventListener('click', () => ($('#exp-modal').style.display = 'none'));
$('#em-copy').addEventListener('click', async () => {
  if (!state.prompt) { toast('口令还没生成好，稍等一下'); return; }
  const ok = await copyText(state.prompt);
  if (ok) { toast('已复制，粘贴到 Codex，本轮对话就能按关键词自动调用这些 Skill'); $('#exp-modal').style.display = 'none'; }
  else { toast('复制失败，请手动全选下方口令复制'); }
});
$('#em-delete').addEventListener('click', () => askDeleteExpert(state.currentExpert));

// ---------- 自动分类：出口令给 Codex / Claude Code，等它回传 ----------
// 不接大模型 API，聚类这件事交给你已经在用的 agent 去做。
const job = { token: '', prompt: '', timer: null };

$('#exp-auto').addEventListener('click', openJobModal);
async function openJobModal() {
  if (!state.skills.length) return toast('这个来源里还没有 Skill，先切一个有内容的来源');
  job.token = '';
  job.prompt = '';
  $('#jb-cmd').textContent = '生成口令中…';
  $('#jb-chars').textContent = '';
  $('#jb-result').style.display = 'none';
  $('#jb-paste').value = '';
  setJobStatus('idle', '还没开始，先复制口令');
  markStep(1);
  $('#job-modal').style.display = 'grid';
  try {
    const d = await fetch('/api/experts/job?dir=' + encodeURIComponent(curDir()), { method: 'POST' }).then((r) => r.json());
    if (d.error) { $('#jb-cmd').textContent = '（生成失败）'; return toast('生成失败：' + d.error); }
    job.token = d.token;
    job.prompt = d.prompt;
    $('#jb-cmd').textContent = d.prompt;
    $('#jb-sub').textContent = `当前来源：${state.source ? state.source.label : ''} · ${d.count} 个 Skill`;
    $('#jb-chars').textContent = `· ${d.prompt.length} 字`;
    startPolling();
  } catch (e) {
    $('#jb-cmd').textContent = '（生成失败）';
    toast('生成失败：' + (e && e.message ? e.message : e));
  }
}
function setJobStatus(kind, text) {
  $('#jb-status').className = 'jb-status ' + kind;
  $('#jb-status-text').textContent = text;
}
function markStep(n) {
  [1, 2, 3].forEach((i) => $('#jb-step' + i).classList.toggle('on', i <= n));
}
// 每 2 秒问一次后端，agent 回传了没有
function startPolling() {
  stopPolling();
  job.timer = setInterval(async () => {
    if (!job.token) return;
    try {
      const d = await fetch('/api/experts/job?token=' + encodeURIComponent(job.token)).then((r) => r.json());
      if (d.status === 'done') { stopPolling(); onJobDone(d); }
      else if (d.status === 'error') { stopPolling(); setJobStatus('err', '回传的内容有问题：' + d.error); }
    } catch (_) {}
  }, 2000);
}
function stopPolling() { if (job.timer) clearInterval(job.timer); job.timer = null; }

async function onJobDone(d) {
  markStep(3);
  setJobStatus('ok', `搞定，建了 ${d.experts.length} 个专家`);
  const names = d.experts.map((e) => `<span class="em-chip">${esc(e.name)} · ${(e.skills || []).length}</span>`).join('');
  $('#jb-result').style.display = 'block';
  $('#jb-result').innerHTML =
    `<div class="jb-result-head">覆盖了 ${d.covered} / ${d.total} 个 Skill</div><div class="em-skills">${names}</div>`;
  await loadExperts();
  switchView('experts');
}

$('#jb-copy').addEventListener('click', async () => {
  if (!job.prompt) return toast('口令还没生成好，稍等一下');
  const ok = await copyText(job.prompt);
  if (!ok) return toast('复制失败，请手动全选上方口令复制');
  markStep(2);
  setJobStatus('wait', '已复制。粘到 Codex / Claude Code 发送，这里会自动等结果…');
  toast('已复制，粘到 Codex 或 Claude Code 发送');
});
// 兜底：agent 不方便跑 curl 时，把它输出的 JSON 手动贴回来
$('#jb-paste-go').addEventListener('click', async () => {
  const raw = $('#jb-paste').value.trim();
  if (!raw) return toast('先把 JSON 贴进来');
  if (!job.token) return toast('口令还没生成好');
  let body;
  try { body = JSON.parse(raw); } catch (e) { return toast('这段不是合法 JSON：' + e.message); }
  const d = await fetch('/api/experts/import?token=' + encodeURIComponent(job.token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch((e) => ({ error: String(e.message || e) }));
  if (d.error) return toast('导入失败：' + d.error);
  stopPolling();
  const st = await fetch('/api/experts/job?token=' + encodeURIComponent(job.token)).then((r) => r.json());
  onJobDone(st);
});
function closeJobModal() { stopPolling(); $('#job-modal').style.display = 'none'; }
$('#jb-close').addEventListener('click', closeJobModal);
$('#jb-cancel').addEventListener('click', closeJobModal);

// 手动创建专家
$('#exp-manual').addEventListener('click', openCreateModal);
function openCreateModal() {
  state.picked = new Set();
  $('#cm-name').value = '';
  $('#cm-desc').value = '';
  $('#cm-filter').value = '';
  renderCreateList('');
  $('#create-modal').style.display = 'grid';
}
function renderCreateList(q) {
  q = (q || '').toLowerCase();
  const list = state.skills.filter((s) => !q || (s.name + s.description).toLowerCase().includes(q));
  $('#cm-list').innerHTML = list
    .map((s) => `
    <label class="cm-item">
      <input type="checkbox" data-folder="${esc(s.folder)}" ${state.picked.has(s.folder) ? 'checked' : ''}>
      <span class="cm-item-name">${esc(s.name)}</span>
      <span class="cm-item-cat">${esc(s.category)}</span>
    </label>`)
    .join('');
  $('#cm-list').querySelectorAll('input[type=checkbox]').forEach((el) =>
    el.addEventListener('change', () => {
      if (el.checked) state.picked.add(el.dataset.folder);
      else state.picked.delete(el.dataset.folder);
      $('#cm-picked').textContent = state.picked.size ? `· 已选 ${state.picked.size} 个` : '';
    })
  );
}
$('#cm-filter').addEventListener('input', (e) => renderCreateList(e.target.value));
$('#cm-close').addEventListener('click', () => ($('#create-modal').style.display = 'none'));
$('#cm-cancel').addEventListener('click', () => ($('#create-modal').style.display = 'none'));
$('#cm-save').addEventListener('click', async () => {
  const name = $('#cm-name').value.trim();
  if (!name) { toast('给专家起个名字'); return; }
  if (!state.picked.size) { toast('至少勾一个 Skill'); return; }
  const body = {
    name,
    description: $('#cm-desc').value.trim(),
    skills: Array.from(state.picked),
    dir: curDir(),
    source: 'manual',
  };
  await fetch('/api/experts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('#create-modal').style.display = 'none';
  toast('专家已创建');
  await loadExperts();
  switchView('experts');
});

// ---------- 本地运行抽屉 ----------
function runSkill(agent, skill, task) {
  if (state.es) state.es.close();
  $('#run').style.display = 'flex';
  $('#run-skill').textContent = skill.name;
  $('#run-status').textContent = '运行中…';
  $('#run-status').className = 'run-status';
  $('#run-out').textContent = '';
  $('#run-cmd').textContent = '';
  const url = `/api/run?agent=${encodeURIComponent(agent)}&skill=${encodeURIComponent(skill.name)}&folder=${encodeURIComponent(skill.folder)}&dir=${encodeURIComponent(curDir())}&task=${encodeURIComponent(task)}`;
  const es = new EventSource(url);
  state.es = es;
  es.addEventListener('start', (e) => { $('#run-cmd').textContent = JSON.parse(e.data).command; });
  es.addEventListener('chunk', (e) => { const out = $('#run-out'); out.textContent += JSON.parse(e.data); out.scrollTop = out.scrollHeight; });
  es.addEventListener('done', (e) => {
    const code = JSON.parse(e.data).code;
    $('#run-status').textContent = code === 0 ? '完成' : `结束（退出码 ${code}）`;
    $('#run-status').className = 'run-status done';
    es.close();
  });
  es.addEventListener('error', (e) => {
    let msg = '连接中断或出错';
    try { msg = JSON.parse(e.data); } catch (_) {}
    $('#run-out').textContent += `\n[错误] ${msg}\n`;
    $('#run-status').textContent = '出错';
    $('#run-status').className = 'run-status err';
    es.close();
  });
}

$('#run-close').addEventListener('click', () => {
  if (state.es) state.es.close();
  $('#run').style.display = 'none';
});

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = 'none'), 2800);
}

// ---------- 绑定 ----------
// 自动扫描扫不到、或者想加别的目录时，走 macOS 原生选择框
async function pickDir() {
  const btn = $('#pick');
  btn.disabled = true;
  try {
    const data = await fetch('/api/pick-dir').then((r) => r.json());
    if (data.cancelled) return;
    if (!data.dir) return;
    // 先让后端认识这个目录（读一次就会记进历史），再刷新来源列表并切过去
    await fetch('/api/skills?dir=' + encodeURIComponent(data.dir)).then((r) => r.json());
    await loadSources('custom:' + data.dir);
    toast('已添加：' + data.dir);
  } catch (e) {
    toast('打开选择框失败：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
  }
}
$('#pick').addEventListener('click', pickDir);
// 重新扫描当前来源
$('#reload').addEventListener('click', async () => {
  await loadSources();
  toast('已重新扫描');
});
$('#search').addEventListener('input', (e) => { state.q = e.target.value; applyFilter(); });

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

boot();
