'use strict';
// 手元の git コマンドからリポジトリ情報を読む。GitHub API もトークンも使わない。
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL_MS = 30_000;
const cache = new Map(); // repoPath -> { at, info }

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

function isRepo(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

// git@github.com:owner/repo.git / https://github.com/owner/repo.git → ブラウザで開けるURL
function toBrowserUrl(remote) {
  if (!remote) return '';
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
}

async function readInfo(repoPath) {
  if (!repoPath || !isRepo(repoPath)) return { exists: fs.existsSync(repoPath || ''), isRepo: false };

  const [branch, log, status, remote] = await Promise.all([
    git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoPath, ['log', '-1', '--format=%h%x1f%cI%x1f%s']),
    git(repoPath, ['status', '--porcelain']),
    git(repoPath, ['remote', 'get-url', 'origin']),
  ]);

  const [hash, date, subject] = (log || '').split('\x1f');
  return {
    exists: true,
    isRepo: true,
    branch: branch || '',
    lastCommit: hash ? { hash, date: date || '', subject: subject || '' } : null,
    dirtyCount: status ? status.split('\n').filter(Boolean).length : 0,
    remote: remote || '',
    githubUrl: toBrowserUrl(remote),
  };
}

async function info(repoPath, { force = false } = {}) {
  const hit = cache.get(repoPath);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  const fresh = await readInfo(repoPath);
  cache.set(repoPath, { at: Date.now(), info: fresh });
  return fresh;
}

module.exports = { info, isRepo, toBrowserUrl, invalidate: (p) => cache.delete(p) };
