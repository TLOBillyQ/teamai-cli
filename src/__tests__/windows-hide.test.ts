import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Issue #43: on Windows every hook invocation flashed a console window because
 * the spawned children (npm version check, git, the background dispatcher, …)
 * inherited Node's default `windowsHide: false`. This is a source-level guard:
 * every child_process call in `src/` must pass `windowsHide: true`, so a new
 * call site cannot silently reintroduce the flashing black window.
 */

const SRC = path.resolve(__dirname, '..');

/** Child-process spawners whose options object must carry windowsHide. */
const SPAWNERS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'execFileAsync',
];

const CALL_RE = new RegExp(String.raw`(?<![.\w$])(${SPAWNERS.join('|')})\s*\(`, 'g');

/** Longest call text we inspect — long enough for every real call site. */
const MAX_CALL_CHARS = 1200;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Text of the call's argument list, from the opening paren to its match. */
function callText(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length && i - openParen < MAX_CALL_CHARS; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen, openParen + MAX_CALL_CHARS);
}

describe('windowsHide on child processes (issue #43)', () => {
  it('every child_process call in src/ hides the Windows console window', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const match of source.matchAll(CALL_RE)) {
        const openParen = match.index! + match[0].length - 1;
        const text = callText(source, openParen);
        if (text.includes('windowsHide')) continue;
        // A shared options constant (e.g. GIT_EXEC_OPTIONS in code-collector.ts)
        // carries windowsHide at its declaration, out of the scanned call text.
        if (/\b[A-Z][A-Z0-9_]*EXEC_OPTIONS\b/.test(text)) continue;
        const lines = source.slice(0, match.index!).split('\n');
        const line = lines.length;
        // Prose mentions of spawn(...) in doc comments are not call sites.
        const prefix = lines[lines.length - 1].trimStart();
        if (prefix.startsWith('*') || prefix.startsWith('//')) continue;
        offenders.push(`${path.relative(SRC, file)}:${line} ${match[1]}(`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
