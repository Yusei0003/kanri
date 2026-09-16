'use strict';

const STATUS_LABELS = {
  idea: '構想',
  developing: '開発中',
  testing: '試験運用',
  production: '運用中',
  archived: '凍結',
};

const state = {
  apps: [],
  search: '',
  statusFilter: null,
  hideArchived: true,
  detailId: null,
  detailTab: 'todos',
  editingId: null,
  scanFound: [],
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
};

// ---------- 通信 ----------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `通信に失敗しました (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message, true); }
};

// ---------- 表示ヘルパ ----------
function relativeTime(iso) {
  if (!iso) return '';
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(diffMin)) return '';
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  const hours = Math.round(diffMin / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}日前`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}ヶ月前` : `${Math.round(months / 12)}年前`;
}

function matchesFilter(app) {
  if (state.hideArchived && app.status === 'archived' && state.statusFilter !== 'archived') return false;
  if (state.statusFilter && app.status !== state.statusFilter) return false;
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return [app.name, app.description, app.repoPath, ...(app.tags || [])]
    .join(' ').toLowerCase().includes(q);
}

// ---------- 描画 ----------
function renderStats() {
  const counts = {
    total: state.apps.length,
    running: state.apps.filter((a) => a.runtime?.running).length,
    production: state.apps.filter((a) => a.status === 'production').length,
    developing: state.apps.filter((a) => a.status === 'developing').length,
    todos: state.apps.reduce((n, a) => n + (a.todos || []).filter((t) => !t.done).length, 0),
  };
  const items = [
    ['登録アプリ', counts.total],
    ['起動中', counts.running],
    ['運用中', counts.production],
    ['開発中', counts.developing],
    ['未完了TODO', counts.todos],
  ];
  $('#stats').replaceChildren(...items.map(([label, value]) =>
    el('div', { className: 'stat' }, [
      el('div', { className: 'stat-value', textContent: String(value) }),
      el('div', { className: 'stat-label', textContent: label }),
    ])));
}

function renderStatusFilters() {
  const node = $('#status-filters');
  const chips = [el('button', {
    className: `chip${state.statusFilter === null ? ' is-active' : ''}`,
    textContent: 'すべて',
    onclick: () => { state.statusFilter = null; render(); },
  })];
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    const count = state.apps.filter((a) => a.status === key).length;
    chips.push(el('button', {
      className: `chip${state.statusFilter === key ? ' is-active' : ''}`,
      textContent: `${label} ${count}`,
      onclick: () => { state.statusFilter = state.statusFilter === key ? null : key; render(); },
    }));
  }
  node.replaceChildren(...chips);
}

function renderCard(app) {
  const running = Boolean(app.runtime?.running);
  const git = app.git || {};
  const todos = app.todos || [];
  const doneCount = todos.filter((t) => t.done).length;

  const meta = [];
  if (git.isRepo) {
    meta.push(el('span', {}, [el('code', { className: 'mono', textContent: git.branch || '?' })]));
    if (git.lastCommit) meta.push(el('span', { textContent: `最終コミット ${relativeTime(git.lastCommit.date)}` }));
    if (git.dirtyCount > 0) meta.push(el('span', { textContent: `未コミット ${git.dirtyCount}件` }));
  } else if (app.repoPath) {
    meta.push(el('span', { textContent: git.exists === false ? '⚠ フォルダが見つかりません' : 'gitリポジトリではありません' }));
  }
  if (app.effectiveUrl) meta.push(el('span', { textContent: app.effectiveUrl }));

  const actions = [];
  actions.push(el('button', {
    className: running ? 'btn btn-sm' : 'btn btn-sm btn-primary',
    textContent: running ? '■ 停止' : '▶ 起動',
    disabled: !running && !app.startCommand,
    title: app.startCommand || '起動コマンドが未設定です',
    onclick: guard(async () => {
      await api(`/apps/${app.id}/${running ? 'stop' : 'start'}`, { method: 'POST' });
      toast(running ? `${app.name} を停止しました` : `${app.name} を起動しました`);
      await refresh();
    }),
  }));
  if (app.effectiveUrl) {
    actions.push(el('button', {
      className: 'btn btn-sm', textContent: '開く',
      onclick: guard(async () => { await api(`/apps/${app.id}/open`, { method: 'POST' }); }),
    }));
  }
  if (app.repoPath) {
    actions.push(el('button', {
      className: 'btn btn-sm', textContent: 'フォルダ',
      onclick: guard(async () => { await api(`/apps/${app.id}/reveal`, { method: 'POST' }); }),
    }));
    actions.push(el('button', {
      className: 'btn btn-sm', textContent: 'claude をコピー',
      title: `cd "${app.repoPath}" && claude`,
      onclick: async () => {
        const command = `cd "${app.repoPath}" && claude`;
        try {
          await navigator.clipboard.writeText(command);
          toast('コマンドをコピーしました');
        } catch {
          window.prompt('コピーしてください', command);
        }
      },
    }));
  }
  if (app.github || git.githubUrl) {
    actions.push(el('a', {
      className: 'btn btn-sm', textContent: 'GitHub', target: '_blank', rel: 'noreferrer',
      href: app.github || git.githubUrl,
    }));
  }
  actions.push(el('button', {
    className: 'btn btn-sm',
    textContent: `詳細${todos.length ? ` (${doneCount}/${todos.length})` : ''}`,
    onclick: () => openDetail(app.id),
  }));
  actions.push(el('button', { className: 'btn btn-sm', textContent: '編集', onclick: () => openEdit(app) }));

  return el('article', { className: `card${running ? ' is-running' : ''}` }, [
    el('div', { className: 'card-head' }, [
      el('div', { className: 'card-name' }, [
        running ? el('span', { className: 'dot', title: `PID ${app.runtime.pid}` }) : null,
        app.name,
      ]),
      el('span', { className: `badge badge-${app.status}`, textContent: STATUS_LABELS[app.status] || app.status }),
      app.autoDetected
        ? el('span', { className: 'badge badge-auto', textContent: '自動検出', title: '監視フォルダから kanri が自動で見つけて登録しました' })
        : null,
    ]),
    app.description ? el('p', { className: 'card-desc', textContent: app.description }) : null,
    meta.length ? el('div', { className: 'card-meta' }, meta) : null,
    todos.length ? el('div', { className: 'progress' }, [
      el('span', { style: `width:${Math.round((doneCount / todos.length) * 100)}%` }),
    ]) : null,
    app.tags?.length ? el('div', { className: 'tags' },
      app.tags.map((t) => el('span', { className: 'tag', textContent: t }))) : null,
    el('div', { className: 'card-actions' }, actions),
  ]);
}

function render() {
  renderStats();
  renderStatusFilters();
  const visible = state.apps.filter(matchesFilter);
  $('#app-list').replaceChildren(...visible.map(renderCard));
  $('#empty').hidden = state.apps.length > 0;
  if ($('#empty').hidden && visible.length === 0) {
    $('#app-list').replaceChildren(el('p', { className: 'empty', textContent: '条件に合うアプリがありません。' }));
  }
  renderDetail();
}

// ---------- 詳細パネル ----------
function openDetail(id) {
  state.detailId = id;
  renderDetail();
}

function renderDetail() {
  const panel = $('#detail');
  const app = state.apps.find((a) => a.id === state.detailId);
  panel.hidden = !app;
  document.body.classList.toggle('has-detail', Boolean(app));
  if (!app) return;
  $('#detail-name').textContent = app.name;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === state.detailTab);
  }
  for (const p of document.querySelectorAll('.tab-panel')) {
    p.hidden = p.dataset.panel !== state.detailTab;
  }

  // TODO
  const todos = app.todos || [];
  $('#todo-list').replaceChildren(...todos.map((todo) => el('li', { className: todo.done ? 'is-done' : '' }, [
    el('input', {
      type: 'checkbox', checked: todo.done,
      onchange: guard(async (e) => {
        const next = todos.map((t) => (t.id === todo.id ? { ...t, done: e.target.checked } : t));
        await saveApp(app.id, { todos: next });
      }),
    }),
    el('span', { textContent: todo.text }),
    el('button', {
      className: 'btn btn-sm', textContent: '✕', title: '削除',
      onclick: guard(async () => { await saveApp(app.id, { todos: todos.filter((t) => t.id !== todo.id) }); }),
    }),
  ])));

  // メモ（入力中は上書きしない）
  const notes = $('#notes-input');
  if (document.activeElement !== notes) notes.value = app.notes || '';

  if (state.detailTab === 'logs') renderLogs(app);
}

async function renderLogs(app) {
  const { logs, runtime } = await api(`/apps/${app.id}/logs`);
  const view = $('#log-view');
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
  view.replaceChildren(...logs.map((l) =>
    el('div', { className: l.stream, textContent: `${l.line}` })));
  if (!logs.length) view.textContent = 'まだログはありません。';
  $('#log-status').textContent = runtime.running
    ? `起動中 (PID ${runtime.pid} / ${relativeTime(runtime.startedAt)}から)`
    : runtime.startedAt ? `停止済み (終了コード ${runtime.exitCode})` : '未起動';
  if (atBottom) view.scrollTop = view.scrollHeight;
}

async function saveApp(id, patch) {
  const { app } = await api(`/apps/${id}`, { method: 'PATCH', body: patch });
  state.apps = state.apps.map((a) => (a.id === id ? app : a));
  render();
}

// ---------- 登録・編集ダイアログ ----------
function openEdit(app = null) {
  state.editingId = app?.id || null;
  $('#edit-title').textContent = app ? 'アプリを編集' : 'アプリを登録';
  const form = $('#edit-form');
  form.name.value = app?.name || '';
  form.description.value = app?.description || '';
  form.repoPath.value = app?.repoPath || '';
  form.startCommand.value = app?.startCommand || '';
  form.port.value = app?.port ?? '';
  form.status.value = app?.status || 'developing';
  form.url.value = app?.url || '';
  form.github.value = app?.github || '';
  $('#f-tags').value = (app?.tags || []).join(', ');
  $('#btn-delete').hidden = !app;
  $('#edit-dialog').showModal();
}

// ---------- 監視フォルダ（自動検出の設定） ----------
function renderSettingsRoots(roots) {
  $('#settings-roots').replaceChildren(...roots.map((root) => el('li', {}, [
    el('span', { className: 'mono', textContent: root }),
    el('button', {
      className: 'btn btn-sm', textContent: '削除',
      onclick: guard(async () => {
        const { settings } = await api('/settings', { method: 'PATCH', body: { scanRoots: roots.filter((r) => r !== root) } });
        renderSettingsRoots(settings.scanRoots);
      }),
    }),
  ])));
}

// ---------- スキャン ----------
function renderScanResults() {
  const node = $('#scan-results');
  if (!state.scanFound.length) {
    node.replaceChildren(el('p', { className: 'hint', textContent: 'リポジトリは見つかりませんでした。' }));
    $('#btn-import').disabled = true;
    return;
  }
  node.replaceChildren(...state.scanFound.map((item, i) => el('label', {
    className: `scan-item${item.registered ? ' is-registered' : ''}`,
  }, [
    el('input', {
      type: 'checkbox', checked: !item.registered, disabled: item.registered,
      onchange: (e) => { state.scanFound[i].selected = e.target.checked; },
    }),
    el('div', {}, [
      el('div', {}, [item.name, item.registered ? ' （登録済み）' : '']),
      el('small', { className: 'mono', textContent: item.repoPath }),
      item.description ? el('div', {}, [el('small', { textContent: item.description })]) : null,
      item.startCommand ? el('div', {}, [el('small', { className: 'mono', textContent: `起動: ${item.startCommand}` })]) : null,
    ]),
  ])));
  $('#btn-import').disabled = false;
}

// ---------- 起動・イベント ----------
let knownAppIds = null; // 自動検出で新しく増えたアプリを見分けるための前回スナップショット

async function refresh() {
  const { apps } = await api('/apps');
  if (knownAppIds) {
    const detected = apps.filter((a) => a.autoDetected && !knownAppIds.has(a.id));
    if (detected.length) {
      toast(`📂 監視フォルダから自動検出: ${detected.map((a) => a.name).join('、')}`);
    }
  }
  knownAppIds = new Set(apps.map((a) => a.id));
  state.apps = apps;
  render();
}

function wireEvents() {
  const statusSelect = $('#f-status');
  statusSelect.replaceChildren(...Object.entries(STATUS_LABELS)
    .map(([value, label]) => el('option', { value, textContent: label })));

  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('#hide-archived').addEventListener('change', (e) => { state.hideArchived = e.target.checked; render(); });
  $('#btn-new').addEventListener('click', () => openEdit(null));
  $('#btn-quit').addEventListener('click', guard(async () => {
    const running = state.apps.filter((a) => a.runtime?.running).map((a) => a.name);
    const warning = running.length ? `\n起動中のアプリも停止します: ${running.join('、')}` : '';
    if (!window.confirm(`kanri を終了します。よろしいですか？${warning}`)) return;
    await api('/shutdown', { method: 'POST' });
    stopPolling();
    document.body.innerHTML = '<p class="empty">kanri を終了しました。このタブは閉じてかまいません。</p>';
  }));
  $('#btn-cancel').addEventListener('click', () => $('#edit-dialog').close());

  $('#edit-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {
      name: form.name.value, description: form.description.value, repoPath: form.repoPath.value,
      startCommand: form.startCommand.value, port: form.port.value, status: form.status.value,
      url: form.url.value, github: form.github.value, tags: $('#f-tags').value,
    };
    if (state.editingId) await api(`/apps/${state.editingId}`, { method: 'PATCH', body });
    else await api('/apps', { method: 'POST', body });
    $('#edit-dialog').close();
    toast('保存しました');
    await refresh();
  }));

  $('#btn-delete').addEventListener('click', guard(async () => {
    const app = state.apps.find((a) => a.id === state.editingId);
    if (!app || !window.confirm(`「${app.name}」を台帳から削除します。よろしいですか？\n（フォルダやコードは削除されません）`)) return;
    await api(`/apps/${app.id}`, { method: 'DELETE' });
    $('#edit-dialog').close();
    if (state.detailId === app.id) state.detailId = null;
    toast('削除しました');
    await refresh();
  }));

  $('#btn-settings').addEventListener('click', guard(async () => {
    const { settings } = await api('/settings');
    renderSettingsRoots(settings.scanRoots || []);
    $('#settings-dialog').showModal();
    $('#settings-new-root').focus();
  }));
  $('#btn-settings-close').addEventListener('click', () => $('#settings-dialog').close());
  $('#btn-add-root').addEventListener('click', guard(async () => {
    const input = $('#settings-new-root');
    const root = input.value.trim();
    if (!root) return;
    const { settings: current } = await api('/settings');
    const { settings } = await api('/settings', { method: 'PATCH', body: { scanRoots: [...current.scanRoots, root] } });
    input.value = '';
    renderSettingsRoots(settings.scanRoots);
  }));
  $('#settings-new-root').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#btn-add-root').click(); }
  });

  $('#btn-probe').addEventListener('click', guard(async () => {
    const form = $('#edit-form');
    const repoPath = form.repoPath.value.trim();
    if (!repoPath) return toast('先にフォルダのパスを入力してください', true);
    const info = await api('/probe', { method: 'POST', body: { repoPath } });
    // すでに入力済みの項目は上書きしない
    if (!form.name.value.trim()) form.name.value = info.name || '';
    if (!form.description.value.trim()) form.description.value = info.description || '';
    if (!form.startCommand.value.trim()) form.startCommand.value = info.startCommand || '';
    if (!form.github.value.trim()) form.github.value = info.github || '';
    toast('フォルダの内容から自動入力しました');
  }));

  $('#btn-scan').addEventListener('click', () => {
    state.scanFound = [];
    $('#scan-results').replaceChildren();
    $('#btn-import').disabled = true;
    $('#scan-dialog').showModal();
    $('#scan-root').focus();
  });
  $('#btn-scan-close').addEventListener('click', () => $('#scan-dialog').close());
  $('#btn-run-scan').addEventListener('click', guard(async () => {
    const root = $('#scan-root').value.trim();
    if (!root) return;
    const { found } = await api('/scan', { method: 'POST', body: { root } });
    state.scanFound = found.map((f) => ({ ...f, selected: !f.registered }));
    renderScanResults();
  }));
  $('#scan-root').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#btn-run-scan').click(); }
  });
  $('#btn-import').addEventListener('click', guard(async () => {
    const items = state.scanFound.filter((f) => f.selected && !f.registered);
    if (!items.length) return toast('登録するものが選ばれていません', true);
    const { added } = await api('/import', { method: 'POST', body: { items } });
    $('#scan-dialog').close();
    toast(`${added.length}件を登録しました`);
    await refresh();
  }));

  $('#detail-close').addEventListener('click', () => { state.detailId = null; renderDetail(); });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => { state.detailTab = tab.dataset.tab; renderDetail(); });
  }

  $('#todo-form').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const input = $('#todo-input');
    const text = input.value.trim();
    const app = state.apps.find((a) => a.id === state.detailId);
    if (!text || !app) return;
    const todos = [...(app.todos || []), { id: crypto.randomUUID(), text, done: false }];
    input.value = '';
    await saveApp(app.id, { todos });
  }));

  let notesTimer;
  $('#notes-input').addEventListener('input', (e) => {
    const value = e.target.value;
    const id = state.detailId;
    $('#notes-status').textContent = '保存中…';
    clearTimeout(notesTimer);
    notesTimer = setTimeout(guard(async () => {
      await saveApp(id, { notes: value });
      $('#notes-status').textContent = `保存しました（${new Date().toLocaleTimeString('ja-JP')}）`;
    }), 700);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.detailId && !document.querySelector('dialog[open]')) {
      state.detailId = null;
      renderDetail();
    }
  });
}

// 起動状態とログをゆるく追いかける
let pollTimer = setInterval(() => {
  if (document.hidden) return;
  if (state.detailId && state.detailTab === 'logs' && $('#log-follow').checked) {
    const app = state.apps.find((a) => a.id === state.detailId);
    if (app) renderLogs(app).catch(() => {});
  }
  refresh().catch(() => {});
}, 5000);

function stopPolling() {
  clearInterval(pollTimer);
}

wireEvents();
refresh().catch((err) => toast(err.message, true));
