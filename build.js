#!/usr/bin/env node
/**
 * build.js — assembles the entire game into ONE self-contained HTML file.
 *   node build.js            -> dist/Chris-Jensens-LOTRO.html (+ copies to repo root)
 *   node build.js --check    -> also syntax-checks every JS module with node's parser
 *
 * Concatenation order = alphabetical order of src/js/*.js (files are prefixed 00_, 01_, ...).
 * Each module is wrapped in its own <script> tag so a syntax error in one module is reported
 * with the right file name in the browser and does not take down the others.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_NAME = 'Chris-Jensens-LOTRO.html';

function read(p) { return fs.readFileSync(p, 'utf8'); }
function listJs() {
  return fs.readdirSync(path.join(SRC, 'js')).filter(f => f.endsWith('.js')).sort();
}
function esc(s) { return s.replace(/<\/script/gi, '<\\/script'); }

function checkSyntax(file, code) {
  try { new Function(code); return null; }
  catch (e) { return `${file}: ${e.message}`; }
}

function build(opts = {}) {
  const jsFiles = listJs();
  const css = fs.readdirSync(path.join(SRC, 'css')).filter(f => f.endsWith('.css')).sort()
    .map(f => `/* ---- ${f} ---- */\n` + read(path.join(SRC, 'css', f))).join('\n');
  const body = read(path.join(SRC, 'html', 'ui.html'));
  const three = read(path.join(ROOT, 'vendor', 'three.min.js'));

  const errors = [];
  const scripts = jsFiles.map(f => {
    const code = read(path.join(SRC, 'js', f));
    if (opts.check) { const err = checkSyntax(f, code); if (err) errors.push(err); }
    return `<script data-module="${f}">\n${esc(code)}\n</script>`;
  });
  if (errors.length) {
    console.error('SYNTAX ERRORS:\n' + errors.join('\n'));
    process.exit(1);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Chris Jensen's Lord of the Rings Online</title>
<meta name="description" content="A single-file, third-person Middle-earth MMO-style RPG. Built with Three.js.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💍</text></svg>">
<style>
${css}
</style>
</head>
<body>
${body}
<script data-module="three.min.js r160">
${esc(three)}
</script>
${scripts.join('\n')}
</body>
</html>
`;
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, OUT_NAME);
  fs.writeFileSync(out, html);
  fs.writeFileSync(path.join(ROOT, OUT_NAME), html);
  const kb = (html.length / 1024).toFixed(0);
  console.log(`built ${OUT_NAME}: ${kb} KB, ${jsFiles.length} modules: ${jsFiles.join(', ')}`);
  return out;
}

if (require.main === module) {
  build({ check: process.argv.includes('--check') || true });
}
module.exports = { build, listJs };
