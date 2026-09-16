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

// プロセスグループにまだ誰か残っているか。
// シェル経由で起動するため、直接の子（sh）が死んでも孫が生き残ることがある。
function groupAlive(pid) {
  if (isWindows || !pid) return false; // Windows は taskkill /T /F で強制終了済み
  try {
    process.kill(-pid, 0); // シグナル 0 は存在確認だけ
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 権限が無いだけなら生きている
  }
}

// 直接の子も、その配下の孫も居なくなったか
const isStopped = (entry) => entry.exitedAt != null && !groupAlive(entry.pid);

function killTree(entry, signal = 'SIGTERM') {
  const { child, pid } = entry;
  if (isWindows) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  if (signal === 'SIGKILL' && !groupAlive(pid)) return; // pid 再利用に撃ち込まない
  try {
    process.kill(-pid, signal); // 先頭の - でプロセスグループ全体へ
  } catch {
    try { child.kill(signal); } catch { /* 既に消えている */ }
  }
}

// SIGTERM を無視する相手のために、猶予を過ぎたら SIGKILL へ昇格する
function killTreeWithEscalation(entry, graceMs = 5000) {
  killTree(entry, 'SIGTERM');
  // ここを unref するとイベントループが空になった瞬間に昇格前へ抜けてしまう
  setTimeout(() => {
    if (!isStopped(entry)) killTree(entry, 'SIGKILL');
  }, graceMs);
}

function stop(appId) {
  const entry = procs.get(appId);
  if (!entry || entry.exitedAt != null) return { ok: false, error: '起動していません' };
  killTreeWithEscalation(entry);
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
  for (const entry of procs.values()) {
    if (!isStopped(entry)) killTree(entry, 'SIGTERM');
  }
}

// 孫まで含めて実際に消えるのを待つ。graceMs を過ぎても残っていれば SIGKILL に昇格する。
function waitForAllStopped({ timeoutMs = 8000, graceMs = 2000 } = {}) {
  const startedAt = Date.now();
  let escalated = false;
  return new Promise((resolve) => {
    const check = () => {
      const alive = [...procs.values()].filter((e) => !isStopped(e));
      if (alive.length === 0) return resolve({ stopped: true, remaining: 0 });

      const elapsed = Date.now() - startedAt;
      if (!escalated && elapsed >= graceMs) {
        escalated = true;
        for (const entry of alive) killTree(entry, 'SIGKILL');
      }
      if (elapsed >= timeoutMs) return resolve({ stopped: false, remaining: alive.length });
      setTimeout(check, 150); // unref しない（終了待ちの間はプロセスを生かす）
    };
    check();
  });
}

module.exports = { start, stop, state, logs, isRunning, stopAll, waitForAllStopped };
