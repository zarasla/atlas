// Fails if anything secret-looking is committed anywhere in the repository: private keys, API
// tokens, JWTs (GoMining's bearer token is one), hard-coded passwords, or public IP addresses
// (a VPS address). Credentials belong in the VPS env file or your local Claude config, never here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT / bearer token', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Anthropic/OpenAI key', /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/],
  ['Discord bot token', /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/],
  ['Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ['hard-coded password', /\b(password|passwd|pwd)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i],
  ['GoMining token value', /GOMINING_TOKEN\s*[=:]\s*["']?[A-Za-z0-9._-]{16,}/],
  ['public IPv4 address', /\b(?!127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)(\d{1,3}\.){3}\d{1,3}\b/],
];
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|pdf)$/i;

test('no secrets are committed anywhere in the repository', () => {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => f && !BINARY.test(f) && !f.includes('node_modules/') && !f.endsWith('package-lock.json'));
  const findings = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => {
      for (const [name, pattern] of PATTERNS) {
        // Lockfiles are excluded above; this also skips version-number lines.
        if (name === 'public IPv4 address' && /version|v\d|\d+\.\d+\.\d+-/.test(line)) continue;
        if (pattern.test(line)) findings.push(`${file}:${i + 1} looks like a ${name}`);
      }
    });
  }
  assert.deepEqual(findings, [], `Possible secrets found:\n${findings.join('\n')}`);
});
