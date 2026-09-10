import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
  })),
}));

import { logInitOutcome, logMemberRegistrationOutcome } from '../init.js';
import { log } from '../utils/logger.js';

function loggedLines(fn: { mock: { calls: unknown[][] } }): string[] {
  return fn.mock.calls.map((c) => String(c[0]));
}

describe('logInitOutcome', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('reports plain success when registration landed', () => {
    logInitOutcome(null);

    expect(loggedLines(vi.mocked(log.success)).some((l) => l.includes('teamai initialized successfully'))).toBe(true);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    expect(process.exitCode).toBeFalsy();
  });

  it('does not claim success when the member registration never reached the remote', () => {
    logInitOutcome('Author identity unknown');

    const successes = loggedLines(vi.mocked(log.success));
    expect(successes.some((l) => l.includes('initialized successfully'))).toBe(false);

    const warnings = loggedLines(vi.mocked(log.warn));
    expect(warnings.some((l) => l.includes('Author identity unknown'))).toBe(true);
    expect(warnings.some((l) => l.includes('member registration'))).toBe(true);

    const hints = [...warnings, ...loggedLines(vi.mocked(log.info))];
    expect(hints.some((l) => l.includes('teamai members register'))).toBe(true);

    // Detectable from a script: the config exists but init did not fully succeed.
    expect(process.exitCode).toBe(1);
  });
});

describe('logMemberRegistrationOutcome', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('prints the caller-supplied success line when registration landed', () => {
    logMemberRegistrationOutcome(null, 'teamai initialized (single-repo mode)!');

    expect(loggedLines(vi.mocked(log.success))).toContain('teamai initialized (single-repo mode)!');
    expect(process.exitCode).toBeFalsy();
  });

  it('withholds the single-repo success line and exits non-zero on a failed push', () => {
    logMemberRegistrationOutcome('Author identity unknown', 'teamai initialized (single-repo mode)!');

    expect(vi.mocked(log.success)).not.toHaveBeenCalled();
    const hints = [...loggedLines(vi.mocked(log.warn)), ...loggedLines(vi.mocked(log.info))];
    expect(hints.some((l) => l.includes('teamai members register'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
