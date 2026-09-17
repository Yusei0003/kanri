'use strict';
// 指定フォルダ配下の git リポジトリを探し、起動コマンドを推測する。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', '__pycache__', 'vendor', '.next']);
const MAX_DEPTH = 3;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const README_NAMES = ['README.md', 'Readme.md', 'readme.md'];

// package.json の name や README の見出しから名前を推測する。無ければフォルダ名。
function guessName(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg?.name) return pkg.name;
  for (const readme of README_NAMES) {
    const text = readText(path.join(dir, readme));
    const heading = text?.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].trim();
  }
  return path.basename(dir);
}

// README の見出し直後の説明文を短く拾う。登録フォームの手入力を減らすための下書き。
function guessDescription(dir) {
  for (const readme of README_NAMES) {
    const text = readText(path.join(dir, readme));
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    const headingIdx = lines.findIndex((l) => /^#\s+/.test(l));
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('```')) continue;
      return line.length > 140 ? `${line.slice(0, 140)}…` : line;
    }
  }
  return '';
}

// package.json / requirements.txt などから「たぶんこれで動く」コマンドを当てる。
function guessStartCommand(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg) {
    const scripts = pkg.scripts || {};
    for (const name of ['dev', 'start', 'serve', 'preview']) {
      if (scripts[name]) return `npm run ${name}`;
    }
    if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) return `node ${pkg.main}`;
  }
  for (const [file, cmd] of [
    ['manage.py', 'python manage.py runserver'],
    ['app.py', 'python app.py'],
    ['main.py', 'python main.py'],
    ['streamlit_app.py', 'streamlit run streamlit_app.py'],
    ['docker-compose.yml', 'docker compose up'],
  ]) {
    if (fs.existsSync(path.join(dir, file))) return cmd;
  }
  return '';
}

// サーバー起動が要らない「ブラウザで直接開くだけ」の静的サイトのエントリファイルを探す。
// index.html が定番だが、kenshin.html のように単一の .html だけが置かれている
// 構成（Claude Code で作った簡易アプリによくある）にも対応する。
function findStaticEntry(dir) {
  for (const name of ['index.html', 'index.htm']) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const htmlFiles = entries
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => e.name);
  // 2つ以上あるとどれが入口か分からないので、1つだけの場合に限る
  return htmlFiles.length === 1 ? htmlFiles[0] : null;
}

// 起動コマンドが不要なアプリなら、開くべき file:// URL を返す。
// 日本語や【】などを含むパスでも正しくエンコードされる。
function guessUrl(dir) {
  if (guessStartCommand(dir)) return ''; // サーバー起動が要るなら対象外
  const entry = findStaticEntry(dir);
  return entry ? pathToFileURL(path.join(dir, entry)).href : '';
}

function detectKind(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(dir, 'requirements.txt')) || fs.existsSync(path.join(dir, 'pyproject.toml'))) return 'python';
  if (findStaticEntry(dir)) return 'static';
  return 'other';
}

function hasClaudeMarkers(dir) {
  return ['CLAUDE.md', '.claude'].some((f) => fs.existsSync(path.join(dir, f)));
}

function scan(root, depth = 0, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  if (entries.some((e) => e.name === '.git')) {
    found.push({
      name: guessName(root),
      description: guessDescription(root),
      repoPath: root,
      startCommand: guessStartCommand(root),
      url: guessUrl(root),
      kind: detectKind(root),
      claudeProject: hasClaudeMarkers(root),
    });
    return found; // リポジトリの中はそれ以上掘らない（サブモジュールは対象外）
  }

  if (depth >= MAX_DEPTH) return found;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    scan(path.join(root, entry.name), depth + 1, found);
  }
  return found;
}

module.exports = {
  scan: (root) => scan(path.resolve(root)),
  guessStartCommand,
  guessUrl,
  guessName,
  guessDescription,
  detectKind,
};
