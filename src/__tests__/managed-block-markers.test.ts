/**
 * Keeps the "Managed block markers" reference in both usage guides in sync
 * with the marker constants the CLI actually writes. Team repos write
 * acceptance scripts that grep for these exact strings, so a marker that
 * exists in code but is missing from the docs is a real bug.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as types from '../types.js';
import { formatResults } from '../recall.js';
import { parseTranscriptForVotes } from '../transcript-parser.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every exported `TEAMAI_<NAME>_START` / `TEAMAI_<NAME>_END` string constant. */
const MARKERS = Object.entries(types)
  .filter(([name, value]) => /^TEAMAI_[A-Z_]+_(START|END)$/.test(name) && typeof value === 'string')
  .map(([name, value]) => ({ name, value: value as string }));

/** Body of the `### <heading>` section, up to the next `##`/`###` heading. */
function section(doc: string, heading: string): string {
  const headingLine = `\n### ${heading}\n`;
  const start = doc.indexOf(headingLine);
  if (start === -1) return '';
  const rest = doc.slice(start + headingLine.length);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}

const GUIDES = [
  { file: 'docs/usage-guide.md', heading: 'Managed block markers' },
  { file: 'docs/usage-guide.zh-CN.md', heading: '托管块标记' },
];

describe('managed block markers reference', () => {
  it('discovers every marker pair the CLI writes', () => {
    const names = MARKERS.map((m) => m.name);
    for (const expected of [
      'TEAMAI_RULES_START',
      'TEAMAI_CULTURE_START',
      'TEAMAI_CLAUDEMD_START',
      'TEAMAI_RECALL_RULES_START',
      'TEAMAI_ENV_START',
      'TEAMAI_RECALL_OUTPUT_START',
    ]) {
      expect(names).toContain(expected);
      expect(names).toContain(expected.replace(/_START$/, '_END'));
    }
  });

  for (const { file, heading } of GUIDES) {
    it(`${file} lists every marker in its "${heading}" section`, () => {
      const body = section(fs.readFileSync(path.join(repoRoot, file), 'utf-8').replace(/\r\n/g, '\n'), heading);
      expect(body, `missing "### ${heading}" section`).not.toBe('');
      const missing = MARKERS.filter((m) => !body.includes(`\`${m.value}\``)).map((m) => m.value);
      expect(missing).toEqual([]);
    });
  }
});

describe('teamai recall output markers', () => {
  it('delimit real recall output so the transcript parser credits the recalled doc', async () => {
    const output = formatResults([{
      entry: {
        filename: 'api-retry-fix.md', title: 'API retry fix', author: 'a', date: '2026-01-01',
        tags: [], tokens: [], votes: 0, type: 'learnings', domain: 'technical',
      },
      score: 5,
      learningsBase: '/team/learnings',
    }]);
    expect(output.startsWith('--- [teamai:recall:start] --- (1 result)')).toBe(true);
    expect(output).toContain('\n--- [teamai:recall:end] ---\n');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-markers-'));
    try {
      const transcript = path.join(dir, 't.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: output }] },
      }) + '\n');
      const { recalledDocIds } = await parseTranscriptForVotes(transcript);
      expect(recalledDocIds).toEqual(['api-retry-fix']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
