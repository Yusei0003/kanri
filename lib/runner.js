'use strict';
// 登録した起動コマンドを子プロセスとして動かし、状態とログを保持する。
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const MAX_LOG_LINES = 400;
const isWindows = process.platform === 'win32';

const procs = new Map(); // appId -> { child, pid, startedAt, exitedAt, exitCode, logs, command }

function pushLog(entry, stream, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    entry.logs.push({ t: new Date().toISOString(), stream, line });
  }
  if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
}

function isRunning(appId) {
  const entry = procs.get(appId);
  return Boolean(entry && entry.child && entry.exitedAt == null);
}

function start(app) {
  if (isRunning(app.id)) return { ok: false, error: 'すでに起動しています' };
  if (!app.startCommand) return { ok: false, error: '起動コマンドが未設定です' };
  if (!app.repoPath || !fs.existsSync(app.repoPath)) {
    return { ok: false, error: `フォルダが見つかりません: ${app.repoPath}` };
  }

  const env = { ...process.env };
  if (app.port) env.PORT = String(app.port);

  let child;
  try {
    child = spawn(app.startCommand, {
      cwd: app.repoPath,
      shell: true,
      env,
      // POSIX では子をプロセスグループの長にして、停止時に孫までまとめて落とす。
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, error: `起動に失敗しました: ${err.message}` };
  }

  const entry = {
    child,
    pid: child.pid,
    command: app.startCommand,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    logs: [],
  };
  procs.set(app.id, entry);

  pushLog(entry, 'system', `$ ${app.startCommand}  (cwd: ${app.repoPath})`);
  child.stdout.on('data', (d) => pushLog(entry, 'stdout', d));
  child.stderr.on('data', (d) => pushLog(entry, 'stderr', d));
  child.on('error', (err) => pushLog(entry, 'system', `エラー: ${err.message}`));
  child.on('exit', (code, signal) => {
    entry.exitedAt = new Date().toISOString();
    entry.exitCode = code;
    pushLog(entry, 'system', `終了しました (code=${code}${signal ? `, signal=${signal}` : ''})`);
  });

  return { ok: true, pid: child.pid, startedAt: entry.startedAt };
}

function killTree(entry) {
  const { child, pid } = entry;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // 先頭の - でプロセスグループ全体へ
  } catch {
    try { child.kill('SIGTERM'); } catch { /* 既に消えている */ }
  }
  setTimeout(() => {
    if (entry.exitedAt != null) return;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* 既に消えている */ }
  }, 5000).unref();
}

function stop(appId) {
  const entry = procs.get(appId);
  if (!entry || entry.exitedAt != null) return { ok: false, error: '起動していません' };
  killTree(entry);
  return { ok: true };
}

function state(appId) {
  const entry = procs.get(appId);
  if (!entry) return { running: false, pid: null, startedAt: null, exitCode: null, logCount: 0 };
  return {
    running: entry.exitedAt == null,
    pid: entry.pid,
    startedAt: entry.startedAt,
    exitedAt: entry.exitedAt,
    exitCode: entry.exitCode,
    logCount: entry.logs.length,
  };
}

function logs(appId) {
  return procs.get(appId)?.logs ?? [];
}

function stopAll() {
  for (const [id, entry] of procs) {
    if (entry.exitedAt == null) killTree(entry);
    void id;
  }
}

module.exports = { start, stop, state, logs, isRunning, stopAll };
