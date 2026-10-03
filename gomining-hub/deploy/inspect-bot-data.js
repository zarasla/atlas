#!/usr/bin/env node
// Read-only: describes the JSON files a bot keeps, so the clan page can be built on them.
// Usage on the VPS:  node deploy/inspect-bot-data.js /opt/mw-bot/mw-bot
//
// Prints file names, sizes, modification times and the *shape* of each JSON file: field names, value
// types, numbers and booleans. Text values are never printed (only their length), so tokens, cookies,
// keys and names can't leak. Files whose names suggest secrets are skipped entirely. Nothing is written.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node inspect-bot-data.js <bot folder>');
  process.exit(1);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'chrome-profile', 'user-data', 'profile']);
const SECRET_NAME = /(token|cookie|secret|session|auth|credential|password|passwd|key|\.env|config\.json$|storage)/i;
const MAX_FILES = 80;
const MAX_BYTES = 20 * 1024 * 1024;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path, out);
    } else if (entry.name.endsWith('.json') && entry.name !== 'package.json' && entry.name !== 'package-lock.json') {
      out.push(path);
    }
  }
  return out;
}

// Shape of a value: numbers and booleans as-is, text only as its length, arrays as length plus the
// shape of their first two items, objects field by field (capped so huge maps stay readable).
function shape(value, depth = 0) {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return `<text ${value.length}>`;
  if (depth > 5) return '<…>';
  if (Array.isArray(value)) {
    return { '<array>': value.length, items: value.slice(0, 2).map((item) => shape(item, depth + 1)) };
  }
  const keys = Object.keys(value);
  const out = {};
  // Objects keyed by ids (e.g. per-member maps) are summarised by their first entries.
  const idLike = keys.length > 12 && keys.every((k) => /^[\w-]{1,64}$/.test(k)) && keys.filter((k) => /\d/.test(k)).length > keys.length / 2;
  if (idLike) {
    out['<map of>'] = keys.length;
    for (const k of keys.slice(0, 2)) out[`<id ${k.length} chars>`] = shape(value[k], depth + 1);
    return out;
  }
  for (const k of keys.slice(0, 40)) out[SECRET_NAME.test(k) ? `${k} (hidden)` : k] = SECRET_NAME.test(k) ? '<hidden>' : shape(value[k], depth + 1);
  if (keys.length > 40) out['<more fields>'] = keys.length - 40;
  return out;
}

const files = walk(root);
console.log(`Bot data in ${root}: ${files.length} JSON file(s)${files.length >= MAX_FILES ? ' (first ' + MAX_FILES + ')' : ''}\n`);
for (const path of files) {
  const name = relative(root, path);
  const info = statSync(path);
  const header = `== ${name}  (${(info.size / 1024).toFixed(1)} KB, updated ${info.mtime.toISOString().slice(0, 16).replace('T', ' ')} UTC)`;
  if (SECRET_NAME.test(name)) { console.log(`${header}\n   skipped: name suggests secrets\n`); continue; }
  if (info.size > MAX_BYTES) { console.log(`${header}\n   skipped: too large\n`); continue; }
  try {
    console.log(header);
    console.log(JSON.stringify(shape(JSON.parse(readFileSync(path, 'utf8'))), null, 1).split('\n').slice(0, 60).join('\n'));
    console.log();
  } catch (error) {
    console.log(`   not valid JSON (${error.message.slice(0, 60)})\n`);
  }
}
