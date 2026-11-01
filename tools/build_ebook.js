#!/usr/bin/env node
/* docs/ANALISIS.md -> docs/ANALISIS.html (satu berkas, TOC, print CSS) -> PDF lewat chromium.
   Konverter-nya sengaja cuma mendukung subset Markdown yang dipakai dokumen ini:
   heading #..####, pagar kode ```, tabel pipe, list (- / 1.), blockquote >, hr ---,
   dan inline **bold** *italic* `code` [tautan](url). Bukan Markdown parser umum.
   Pakai: node tools/build_ebook.js [--pdf]     (default: html saja; --pdf juga merender PDF) */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'ANALISIS.md');
const OUT_HTML = path.join(ROOT, 'docs', 'ANALISIS.html');
const OUT_PDF = path.join(ROOT, 'docs', 'ANALISIS.pdf');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slugSeen = {};
function slug(t) {
  const base = t.toLowerCase().replace(/[`*]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  slugSeen[base] = (slugSeen[base] || 0) + 1;
  return slugSeen[base] > 1 ? base + '-' + slugSeen[base] : base;
}
function inline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const body = [];
const toc = [];
// Baris depan (judul, subjudul, edisi) sudah tampil di sampul — mulai parsing setelah `---` pertama.
let i = lines.findIndex(l => /^---+\s*$/.test(l)) + 1;
while (i < lines.length) {
  const ln = lines[i];

  if (/^```/.test(ln)) {                                   // fenced code
    const buf = []; i++;
    while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
    i++;
    body.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
    continue;
  }
  const h = /^(#{1,4})\s+(.*)$/.exec(ln);
  if (h) {
    const lvl = h[1].length, txt = h[2].trim(), id = slug(txt);
    if (lvl >= 2) toc.push({ lvl, txt, id });
    body.push('<h' + lvl + ' id="' + id + '">' + inline(txt) + '</h' + lvl + '>');
    i++; continue;
  }
  if (/^---+\s*$/.test(ln)) { body.push('<hr>'); i++; continue; }
  if (/^>\s?/.test(ln)) {                                   // blockquote (satu blok rata)
    const buf = [];
    while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
    body.push('<blockquote>' + buf.map(p => '<p>' + inline(p) + '</p>').join('') + '</blockquote>');
    continue;
  }
  if (/^\|/.test(ln)) {                                     // table
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    const cells = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const head = cells(rows[0]);
    const bodyRows = rows.slice(/^\s*\|[-: |]+\|\s*$/.test(rows[1]) ? 2 : 1).map(cells);
    body.push('<table><thead><tr>' + head.map(c => '<th>' + inline(c) + '</th>').join('') +
      '</tr></thead><tbody>' +
      bodyRows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>');
    continue;
  }
  const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(ln);
  if (li) {
    const ordered = /^\d+\./.test(li[2]);
    const tag = ordered ? 'ol' : 'ul';
    const items = [];
    while (i < lines.length) {
      const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
      if (!m) break;
      items.push('<li>' + inline(m[3]) + '</li>'); i++;
    }
    body.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
    continue;
  }
  if (!ln.trim()) { i++; continue; }
  const buf = [ln];                                          // paragraph (baris lanjut digabung)
  i++;
  while (i < lines.length && lines[i].trim() && !/^(#|```|>|\||\s*[-*]\s|\s*\d+\.\s|---)/.test(lines[i])) buf.push(lines[i++]);
  body.push('<p>' + inline(buf.join(' ')) + '</p>');
}

const nav = toc.map(t => '<a class="toc-l' + t.lvl + '" href="#' + t.id + '">' + inline(t.txt) + '</a>').join('');
const title = (lines.find(l => /^#\s/.test(l)) || '#').replace(/^#\s*/, '');

const html = '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + esc(title) + '</title><style>' +
  `@page{size:A4;margin:16mm 14mm}
:root{--ink:#16181d;--mut:#5b6472;--line:#dfe3ea;--acc:#2b4a7a;--bg:#fbfbfd}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
header.cover{padding:56px 40px 34px;background:linear-gradient(160deg,#1d2a3f,#2b4a7a);color:#fff}
header.cover h1{margin:0 0 10px;font-size:34px;line-height:1.2;letter-spacing:-.3px;color:#fff}
header.cover p{margin:0 0 6px;color:#cdd8e8;max-width:70ch}
header.cover strong{color:#fff}
header.cover code{background:rgba(255,255,255,.14);color:#e8edf5}
main{display:block;max-width:860px;margin:0 auto;padding:28px 30px 80px}
nav.toc{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:0 0 30px}
nav.toc b{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin-bottom:6px}
nav.toc a{display:block;color:var(--acc);text-decoration:none;font-size:14px;padding:2px 0}
nav.toc a.toc-3{padding-left:18px;opacity:.85}
nav.toc a.toc-4{padding-left:34px;opacity:.75}
h2{margin:44px 0 12px;font-size:25px;line-height:1.25;border-bottom:2px solid var(--acc);padding-bottom:6px}
h3{margin:30px 0 8px;font-size:19px}
h4{margin:22px 0 6px;font-size:16px;color:var(--mut)}
p{margin:0 0 13px}
ul,ol{margin:0 0 15px;padding-left:22px}
li{margin-bottom:6px}
strong{color:#0f1116}
code{font-family:ui-monospace,"DejaVu Sans Mono",Menlo,monospace;font-size:88%;background:#eef1f6;border-radius:4px;padding:1px 4px}
pre{background:#14181f;color:#e8edf5;padding:14px 16px;border-radius:8px;overflow-x:auto;margin:0 0 16px}
pre code{background:none;color:inherit;padding:0;font-size:13.5px;line-height:1.55;white-space:pre}
table{border-collapse:collapse;width:100%;margin:0 0 18px;font-size:14.5px;background:#fff}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#eef1f6;font-weight:700;font-size:13.5px}
tbody tr:nth-child(even){background:#f6f8fb}
blockquote{margin:0 0 16px;padding:10px 16px;border-left:4px solid var(--acc);background:#eef2f8;border-radius:0 8px 8px 0}
blockquote p{margin:0}
hr{border:0;border-top:1px solid var(--line);margin:34px 0}
a{color:var(--acc)}
footer{max-width:860px;margin:0 auto;padding:0 30px 50px;color:var(--mut);font-size:13px}
@media print{
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  :root{--bg:#fff}
  body{font-size:11.2pt;line-height:1.5}
  header.cover{background:#1d2a3f !important;padding:34px 22px 26px;margin:0 0 22px;page-break-after:always}
  header.cover h1{color:#fff;font-size:27pt}
  header.cover p{color:#cdd8e8}
  main{max-width:none;margin:0;padding:0}
  nav.toc{page-break-after:always;background:#fff}
  nav.toc a{color:var(--acc)}
  h2{page-break-after:avoid;break-after:avoid;margin-top:26px}
  h3,h4{page-break-after:avoid}
  pre,table,blockquote{page-break-inside:avoid;break-inside:avoid}
  a{color:var(--ink);text-decoration:none}
  footer{padding:0}
}` +
  '</style></head><body>' +
  '<header class="cover"><h1>' + esc(title) + '</h1>' +
  '<p>' + inline(lines[2] || '') + '</p>' +
  '<p>' + inline((lines[4] || '')) + '</p></header>' +
  '<main><nav class="toc"><b>Daftar isi</b>' + nav + '</nav>' + body.join('\n') + '</main>' +
  '<footer>Dibangun dari <code>docs/ANALISIS.md</code> oleh <code>tools/build_ebook.js</code>.</footer>' +
  '</body></html>\n';

fs.writeFileSync(OUT_HTML, html);
console.log('html : ' + OUT_HTML + ' (' + (fs.statSync(OUT_HTML).size / 1024).toFixed(1) + ' KB, ' + toc.length + ' entri TOC)');

if (process.argv.includes('--pdf')) {
  const BIN = ['chromium', 'google-chrome', 'chromium-browser'].find(b => {
    try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch (e) { return false; }
  });
  if (!BIN) { console.error('PDF: chromium/google-chrome tidak ditemukan — render manual:\n  chromium --headless --print-to-pdf=' + OUT_PDF + ' ' + OUT_HTML); process.exitCode = 1; }
  else {
    execFileSync(BIN, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer',
      '--print-to-pdf=' + OUT_PDF, 'file://' + OUT_HTML], { stdio: ['ignore', 'ignore', 'ignore'] });
    console.log('pdf  : ' + OUT_PDF + ' (' + (fs.statSync(OUT_PDF).size / 1024).toFixed(1) + ' KB)');
  }
}
