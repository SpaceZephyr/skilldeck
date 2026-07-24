// SkillDeck 前端逻辑
const $ = (s) => document.querySelector(s);
const state = {
  skills: [], filtered: [], cat: '全部', q: '',
  agents: [], current: null, prompt: '', es: null,
  experts: [], currentExpert: null, picked: new Set(), view: 'skills',
};

// ---------- 主题（深色/浅色）----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  const ico = $('#theme-ico'), label = $('#theme-label');
  if (ico) ico.textContent = light ? '☀️' : '🌙';
  if (label) label.textContent = light ? '浅色' : '深色';
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

async function boot() {
  initTheme();
  const cfg = await fetch('/api/config').then((r) => r.json());
  $('#dir').value = cfg.defaultDir || '';
  state.agents = cfg.agents || [];
  const sel = $('#agent');
  sel.innerHTML = state.agents.length
    ? state.agents.map((a) => `<option value="${a}">${a}</option>`).join('')
    : '<option value="">未检测到 agent</option>';
  setLLMBadge(cfg.hasLLM, cfg.model);
  wireNav();
  await loadSkills();
  await loadExperts();
}

// ---------- 视图切换 ----------
function wireNav() {
  document.querySelectorAll('.nav-item').forEach((el) =>
    el.addEventListener('click', () => switchView(el.dataset.view))
  );
}
function switchView(v) {
  state.view = v;
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === v));
  $('#view-skills').hidden = v !== 'skills';
  $('#view-experts').hidden = v !== 'experts';
}

// ---------- Skill 列表 ----------
async function loadSkills() {
  const dir = $('#dir').value.trim();
  $('#count').textContent = '读取中…';
  const data = await fetch('/api/skills?dir=' + encodeURIComponent(dir)).then((r) => r.json());
  if (data.error) {
    state.skills = [];
    $('#empty').style.display = 'block';
    $('#empty').textContent = data.error;
    $('#grid').innerHTML = '';
    $('#count').textContent = '';
    renderCats();
    return;
  }
  state.skills = data.skills || [];
  $('#empty').style.display = state.skills.length ? 'none' : 'block';
  if (!state.skills.length) $('#empty').textContent = '这个目录里没找到带 SKILL.md 的技能。';
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
        <button class="use-btn" data-i="${i}">使用</button>
      </div>
    </div>`)
    .join('');
  document.querySelectorAll('.use-btn').forEach((el) =>
    el.addEventListener('click', () => openModal(state.filtered[+el.dataset.i]))
  );
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
  const url = `/api/prompt?skill=${encodeURIComponent(skill.name)}&folder=${encodeURIComponent(skill.folder)}&dir=${encodeURIComponent($('#dir').value.trim())}&task=${encodeURIComponent(task)}&mode=${currentMode()}`;
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
  if (ok) { toast('已复制 ✓ 去 Codex 对话框粘贴发送即可'); closeModal(); }
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
  const data = await fetch('/api/experts').then((r) => r.json()).catch(() => ({ experts: [] }));
  state.experts = data.experts || [];
  renderExperts();
}
function renderExperts() {
  $('#exp-count').textContent = state.experts.length ? `共 ${state.experts.length} 个专家` : '';
  $('#exp-empty').style.display = state.experts.length ? 'none' : 'block';
  $('#exp-grid').innerHTML = state.experts
    .map((e, i) => {
      const names = (e.skills || []).map((f) => { const s = skillByFolder(f); return s ? s.name : f; });
      const preview = names.slice(0, 4).join('、') + (names.length > 4 ? ` 等 ${names.length} 个` : '');
      return `
      <div class="card exp-card">
        <div class="card-top">
          <div class="card-name">${esc(e.emoji || '🧩')} ${esc(e.name)}</div>
          <span class="card-cat">${(e.skills || []).length} 个</span>
        </div>
        <div class="card-desc">${esc(e.description || '')}</div>
        <div class="exp-skills-preview">${esc(preview)}</div>
        <div class="card-foot">
          <span class="card-folder">${e.source === 'auto' ? 'AI 生成' : '手动'}</span>
          <button class="use-btn" data-i="${i}">使用</button>
        </div>
      </div>`;
    })
    .join('');
  document.querySelectorAll('#exp-grid .use-btn').forEach((el) =>
    el.addEventListener('click', () => openExpertModal(state.experts[+el.dataset.i]))
  );
}
async function openExpertModal(expert) {
  state.currentExpert = expert;
  $('#em-name').textContent = `${expert.emoji || '🧩'} ${expert.name}`;
  $('#em-count').textContent = `${(expert.skills || []).length} 个 Skill · ${expert.source === 'auto' ? 'AI 生成' : '手动'}`;
  $('#em-desc').textContent = expert.description || '';
  $('#em-skills').innerHTML = (expert.skills || [])
    .map((f) => { const s = skillByFolder(f); return `<span class="em-chip">${esc(s ? s.name : f)}</span>`; })
    .join('');
  $('#em-cmd').textContent = '生成口令中…';
  $('#exp-modal').style.display = 'grid';
  try {
    const data = await fetch(`/api/expert-prompt?id=${encodeURIComponent(expert.id)}&dir=${encodeURIComponent($('#dir').value.trim())}`).then((r) => r.json());
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
  if (ok) { toast('已复制 ✓ 粘贴到 Codex，本轮对话就能按关键词自动调用这些 Skill'); $('#exp-modal').style.display = 'none'; }
  else { toast('复制失败，请手动全选下方口令复制'); }
});
$('#em-delete').addEventListener('click', async () => {
  const e = state.currentExpert;
  if (!e) return;
  await fetch(`/api/experts?id=${encodeURIComponent(e.id)}`, { method: 'DELETE' });
  $('#exp-modal').style.display = 'none';
  toast('已删除专家');
  loadExperts();
});

// AI 自动分类
$('#exp-auto').addEventListener('click', async () => {
  const btn = $('#exp-auto');
  const dir = $('#dir').value.trim();
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '⏳ 大模型分类中，约 1-2 分钟…';
  try {
    const res = await fetch('/api/experts/auto?dir=' + encodeURIComponent(dir), { method: 'POST' });
    const data = await res.json();
    if (data.error) { toast('生成失败：' + data.error); }
    else { toast(`已生成 ${data.experts.length} 个专家 ✓`); await loadExperts(); switchView('experts'); }
  } catch (e) {
    toast('生成失败：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});

// 手动创建专家
$('#exp-manual').addEventListener('click', openCreateModal);
function openCreateModal() {
  state.picked = new Set();
  $('#cm-emoji').value = '';
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
    emoji: $('#cm-emoji').value.trim() || '🧩',
    description: $('#cm-desc').value.trim(),
    skills: Array.from(state.picked),
    dir: $('#dir').value.trim(),
    source: 'manual',
  };
  await fetch('/api/experts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  $('#create-modal').style.display = 'none';
  toast('专家已创建 ✓');
  await loadExperts();
  switchView('experts');
});

// ---------- 模型设置 ----------
function setLLMBadge(hasLLM, model) {
  const badge = $('#llm-badge');
  badge.textContent = hasLLM ? `● ${model || 'LLM'}` : '○ 未配置大模型';
  badge.className = 'llm-badge ' + (hasLLM ? 'on' : 'off');
}
async function openSettings() {
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  $('#set-url').value = cfg.baseUrl || '';
  $('#set-model').value = cfg.model || '';
  $('#set-key').value = '';
  $('#set-hint').textContent = cfg.hasLLM
    ? 'API Key 已配置。留空表示保持不变，填写则覆盖。'
    : '尚未配置 API Key，请填写后保存。';
  $('#set-modal').style.display = 'grid';
}
$('#set-open').addEventListener('click', openSettings);
$('#set-close').addEventListener('click', () => ($('#set-modal').style.display = 'none'));
$('#set-cancel').addEventListener('click', () => ($('#set-modal').style.display = 'none'));
$('#set-save').addEventListener('click', async () => {
  const body = {
    baseUrl: $('#set-url').value.trim(),
    model: $('#set-model').value.trim(),
    apiKey: $('#set-key').value.trim(),
  };
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.error) { toast('保存失败：' + r.error); return; }
    setLLMBadge(r.hasLLM, r.model);
    $('#set-modal').style.display = 'none';
    toast('设置已保存 ✓');
  } catch (e) {
    toast('保存失败：' + (e && e.message ? e.message : e));
  }
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
  const url = `/api/run?agent=${encodeURIComponent(agent)}&skill=${encodeURIComponent(skill.name)}&folder=${encodeURIComponent(skill.folder)}&dir=${encodeURIComponent($('#dir').value.trim())}&task=${encodeURIComponent(task)}`;
  const es = new EventSource(url);
  state.es = es;
  es.addEventListener('start', (e) => { $('#run-cmd').textContent = JSON.parse(e.data).command; });
  es.addEventListener('chunk', (e) => { const out = $('#run-out'); out.textContent += JSON.parse(e.data); out.scrollTop = out.scrollHeight; });
  es.addEventListener('done', (e) => {
    const code = JSON.parse(e.data).code;
    $('#run-status').textContent = code === 0 ? '✓ 完成' : `结束（退出码 ${code}）`;
    $('#run-status').className = 'run-status done';
    es.close();
  });
  es.addEventListener('error', (e) => {
    let msg = '连接中断或出错';
    try { msg = JSON.parse(e.data); } catch (_) {}
    $('#run-out').textContent += `\n[错误] ${msg}\n`;
    $('#run-status').textContent = '✗ 出错';
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
$('#load').addEventListener('click', async () => { await loadSkills(); renderExperts(); });
$('#dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') { loadSkills().then(renderExperts); } });
$('#search').addEventListener('input', (e) => { state.q = e.target.value; applyFilter(); });

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

boot();
