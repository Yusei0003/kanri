'use strict';
// 指定フォルダ配下の git リポジトリを探し、起動コマンドを推測する。
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', '__pycache__', 'vendor', '.next']);
const MAX_DEPTH = 3;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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
    ['index.html', ''], // 静的サイトは起動不要なので空のまま
  ]) {
    if (fs.existsSync(path.join(dir, file))) return cmd;
  }
  return '';
}

function detectKind(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(dir, 'requirements.txt')) || fs.existsSync(path.join(dir, 'pyproject.toml'))) return 'python';
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'static';
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
      name: path.basename(root),
      repoPath: root,
      startCommand: guessStartCommand(root),
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

module.exports = { scan: (root) => scan(path.resolve(root)), guessStartCommand };
