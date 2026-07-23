// SkillDeck 前端逻辑
const $ = (s) => document.querySelector(s);
const state = { skills: [], filtered: [], cat: '全部', q: '', agents: [], current: null, es: null };

async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  $('#dir').value = cfg.defaultDir || '';
  state.agents = cfg.agents || [];
  const sel = $('#agent');
  sel.innerHTML = state.agents.length
    ? state.agents.map((a) => `<option value="${a}">${a}</option>`).join('')
    : '<option value="">未检测到 agent</option>';
  await loadSkills();
}

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
    .map(
      (s, i) => `
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
    </div>`
    )
    .join('');
  document.querySelectorAll('.use-btn').forEach((el) =>
    el.addEventListener('click', () => openModal(state.filtered[+el.dataset.i]))
  );
}

// ---------- 弹窗 ----------
function openModal(skill) {
  state.current = skill;
  $('#m-name').textContent = skill.name;
  $('#m-cat').textContent = skill.category;
  $('#m-desc').textContent = skill.description;
  $('#m-task').value = '';
  $('#m-agent').textContent = $('#agent').value || '（无）';
  updateCmdPreview();
  $('#modal').style.display = 'grid';
}
function updateCmdPreview() {
  const agent = $('#agent').value;
  const task = $('#m-task').value.trim() || '默认流程';
  const flag = agent === 'codex' ? 'exec' : '-p';
  // 与后端一致：注入该 Skill 的说明书正文 + 任务（预览做精简展示）
  $('#m-cmd').textContent = `${agent} ${flag} "〈注入「${state.current.name}」Skill 说明书〉+ 任务：${task}"`;
  $('#m-agent').textContent = agent || '（无）';
}
$('#m-task').addEventListener('input', updateCmdPreview);
$('#agent').addEventListener('change', () => { if (state.current) updateCmdPreview(); });
$('#m-close').addEventListener('click', closeModal);
$('#m-cancel').addEventListener('click', closeModal);
function closeModal() { $('#modal').style.display = 'none'; }

// ---------- 运行 ----------
$('#m-send').addEventListener('click', () => {
  const agent = $('#agent').value;
  if (!agent) { alert('没有可用的 agent，请先安装 codex 或 qodercli。'); return; }
  const skill = state.current;
  const task = $('#m-task').value.trim();
  closeModal();
  runSkill(agent, skill, task);
});

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
  es.addEventListener('start', (e) => {
    $('#run-cmd').textContent = JSON.parse(e.data).command;
  });
  es.addEventListener('chunk', (e) => {
    const out = $('#run-out');
    out.textContent += JSON.parse(e.data);
    out.scrollTop = out.scrollHeight;
  });
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

// ---------- 交互绑定 ----------
$('#load').addEventListener('click', loadSkills);
$('#dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSkills(); });
$('#search').addEventListener('input', (e) => { state.q = e.target.value; applyFilter(); });

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

boot();
