'use strict';
// アプリ台帳の永続化。data/apps.json 1ファイルだけを読み書きする。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'apps.json');

const STATUSES = ['idea', 'developing', 'testing', 'production', 'archived'];

const DEFAULT_DATA = {
  apps: [],
  settings: { scanRoots: [], openBrowserOnStart: true },
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      apps: Array.isArray(parsed.apps) ? parsed.apps : [],
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 壊れた台帳を黙って上書きしないよう、退避してから初期化する。
      const backup = `${FILE}.broken-${Date.now()}`;
      try {
        fs.renameSync(FILE, backup);
        console.error(`[kanri] apps.json を読めなかったため ${backup} に退避しました: ${err.message}`);
      } catch { /* 退避できなくても起動は続ける */ }
    }
    cache = structuredClone(DEFAULT_DATA);
  }
  return cache;
}

function save() {
  const data = load();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE); // 書き込み途中で落ちても台帳が壊れないように
  return data;
}

const newId = () => crypto.randomUUID();

function normalizeApp(input, base = {}) {
  const now = new Date().toISOString();
  const status = STATUSES.includes(input.status) ? input.status : base.status || 'developing';
  return {
    id: base.id || newId(),
    name: String(input.name ?? base.name ?? '').trim() || '(名称未設定)',
    description: String(input.description ?? base.description ?? ''),
    repoPath: String(input.repoPath ?? base.repoPath ?? '').trim(),
    startCommand: String(input.startCommand ?? base.startCommand ?? '').trim(),
    port: input.port === '' || input.port == null ? (base.port ?? null) : Number(input.port) || null,
    url: String(input.url ?? base.url ?? '').trim(),
    github: String(input.github ?? base.github ?? '').trim(),
    status,
    tags: normalizeTags(input.tags ?? base.tags),
    notes: String(input.notes ?? base.notes ?? ''),
    todos: Array.isArray(input.todos) ? input.todos : base.todos || [],
    createdAt: base.createdAt || now,
    updatedAt: now,
    lastStartedAt: base.lastStartedAt || null,
  };
}

function normalizeTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags || '').split(/[,、\s]+/);
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

module.exports = {
  STATUSES,
  load,
  save,
  newId,
  normalizeApp,
  listApps: () => load().apps,
  getApp: (id) => load().apps.find((a) => a.id === id) || null,
  getSettings: () => load().settings,

  addApp(input) {
    const app = normalizeApp(input);
    load().apps.push(app);
    save();
    return app;
  },

  updateApp(id, patch) {
    const data = load();
    const idx = data.apps.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    data.apps[idx] = normalizeApp({ ...data.apps[idx], ...patch }, data.apps[idx]);
    save();
    return data.apps[idx];
  },

  removeApp(id) {
    const data = load();
    const before = data.apps.length;
    data.apps = data.apps.filter((a) => a.id !== id);
    if (data.apps.length === before) return false;
    save();
    return true;
  },

  updateSettings(patch) {
    const data = load();
    data.settings = { ...data.settings, ...patch };
    if (patch.scanRoots) {
      data.settings.scanRoots = [...new Set(patch.scanRoots.map((p) => String(p).trim()).filter(Boolean))];
    }
    save();
    return data.settings;
  },
};
