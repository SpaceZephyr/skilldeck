// SkillDeck widget 逻辑：卡片浏览 → 点使用 → 弹窗确认 → 把命令发送到 Codex 输入框
(function () {
  const $ = (s) => document.querySelector(s);
  const state = { skills: [], filtered: [], cat: '全部', q: '', current: null, dir: '' };

  // ---------- Codex host 桥 ----------
  // 真实运行在 Codex 里时，widget-resource 注入的 window.skilldeckMcp 提供：
  //   sendFollowUpMessage(prompt) —— 把消息送进 Codex 会话执行
  //   callServerTool({name, arguments}) —— 调 MCP server 工具（如 list_skills）
  function bridge() {
    return window.skilldeckMcp || null;
  }
  function hasBridge() {
    return !!(bridge() && typeof bridge().sendFollowUpMessage === 'function');
  }

  async function sendToCodex(prompt) {
    const b = bridge();
    if (b && typeof b.sendFollowUpMessage === 'function') {
      await b.sendFollowUpMessage(prompt);
      return true;
    }
    if (window.openai && typeof window.openai.sendFollowUpMessage === 'function') {
      await window.openai.sendFollowUpMessage(prompt);
      return true;
    }
    // 预览模式（普通浏览器里打开，无 Codex 桥）
    console.log('[SkillDeck 预览] 将发送到 Codex：\n' + prompt);
    toast('（预览模式）无 Codex 桥，命令已打印到控制台');
    return false;
  }

  async function loadSkills(dir) {
    // 优先用打开 widget 时 host 传入的 toolOutput.skills
    const payload = (window.openai && window.openai.toolOutput) || {};
    if (!dir && Array.isArray(payload.skills)) {
      state.dir = payload.dir || '';
      return payload.skills;
    }
    // 刷新/换目录：调 server 工具
    const b = bridge();
    if (b && typeof b.callServerTool === 'function') {
      const res = await b.callServerTool({ name: 'list_skills', arguments: dir ? { dir } : {} });
      const data = res && (res.structuredContent || res);
      state.dir = (data && data.dir) || '';
      return (data && data.skills) || [];
    }
    return Array.isArray(payload.skills) ? payload.skills : [];
  }

  // ---------- 渲染 ----------
  function renderCats() {
    const cats = ['全部', ...Array.from(new Set(state.skills.map((s) => s.category)))];
    $('#cats').innerHTML = cats
      .map((c) => `<span class="sd-cat ${c === state.cat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</span>`)
      .join('');
    document.querySelectorAll('.sd-cat').forEach((el) =>
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
      <div class="sd-card">
        <div class="sd-card-top">
          <div class="sd-card-name">${esc(s.name)}</div>
          <span class="sd-card-cat">${esc(s.category)}</span>
        </div>
        <div class="sd-card-desc">${esc(s.oneLine)}</div>
        <div class="sd-card-foot">
          <span class="sd-card-folder">${esc(s.folder)}</span>
          <button class="sd-use" data-i="${i}">使用</button>
        </div>
      </div>`
      )
      .join('');
    document.querySelectorAll('.sd-use').forEach((el) =>
      el.addEventListener('click', () => openModal(state.filtered[+el.dataset.i]))
    );
  }

  // ---------- 弹窗 ----------
  function buildCommand(skill, task) {
    return `请使用「${skill.name}」这个 Skill 来完成以下任务：\n${task || '按该 Skill 的默认流程执行。'}`;
  }
  function openModal(skill) {
    state.current = skill;
    $('#m-name').textContent = skill.name;
    $('#m-cat').textContent = skill.category;
    $('#m-desc').textContent = skill.description;
    $('#m-task').value = '';
    updateCmd();
    $('#modal').style.display = 'grid';
  }
  function updateCmd() {
    const task = $('#m-task').value.trim();
    $('#m-cmd').textContent = buildCommand(state.current, task);
  }
  function closeModal() { $('#modal').style.display = 'none'; }

  async function doSend() {
    const btn = $('#m-send');
    const cmd = buildCommand(state.current, $('#m-task').value.trim());
    btn.disabled = true;
    try {
      const sent = await sendToCodex(cmd);
      closeModal();
      if (sent) toast('已发送到 Codex，去对话里看它执行 ✓');
    } catch (e) {
      toast('发送失败：' + (e && e.message ? e.message : e));
    } finally {
      btn.disabled = false;
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = 'none'), 2600);
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- 绑定 ----------
  $('#search').addEventListener('input', (e) => { state.q = e.target.value; applyFilter(); });
  $('#m-task').addEventListener('input', updateCmd);
  $('#m-close').addEventListener('click', closeModal);
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-send').addEventListener('click', doSend);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

  // ---------- 启动 ----------
  (async function boot() {
    try {
      state.skills = await loadSkills();
    } catch (e) {
      state.skills = [];
    }
    if (!state.skills.length) {
      $('#empty').style.display = 'block';
      $('#empty').textContent = hasBridge()
        ? '没读到 Skill。确认目录里有带 SKILL.md 的技能。'
        : '（预览模式）当前不在 Codex 里，没有 Skill 数据。在 Codex 中打开 SkillDeck 即可看到卡片。';
    } else {
      $('#empty').style.display = 'none';
    }
    renderCats();
    applyFilter();
    // 监听 host 后续注入的 globals（toolOutput 就绪）
    window.addEventListener('openai:set_globals', async () => {
      if (!state.skills.length) {
        state.skills = await loadSkills();
        renderCats();
        applyFilter();
        if (state.skills.length) $('#empty').style.display = 'none';
      }
    });
  })();
})();
