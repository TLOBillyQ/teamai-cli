import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
    autoDetectInit: vi.fn(),
    loadLocalConfig: vi.fn(),
    saveLocalConfig: vi.fn(),
    loadTeamConfig: vi.fn(),
    saveLocalConfigForScope: vi.fn(),
    loadStateForScope: vi.fn(),
    saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
    pullRepo: vi.fn().mockResolvedValue(undefined),
    pushRepoBranch: vi.fn().mockResolvedValue(false),
    checkoutMaster: vi.fn().mockResolvedValue(undefined),
    generateBranchName: vi.fn().mockReturnValue('teamai/test'),
}));

vi.mock('../push.js', () => ({
    createPrWithFallback: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/prompt.js', () => ({
    askQuestion: vi.fn(),
    askConfirmation: vi.fn(),
}));

const logged: string[] = [];
vi.mock('../utils/logger.js', () => ({
    log: {
        info: vi.fn((m: string) => logged.push(m)),
        success: vi.fn((m: string) => logged.push(m)),
        warn: vi.fn((m: string) => logged.push(m)),
        error: vi.fn((m: string) => logged.push(m)),
        debug: vi.fn(),
        dim: vi.fn(),
    },
    spinner: vi.fn(() => ({
        start: vi.fn().mockReturnThis(),
        succeed: vi.fn().mockReturnThis(),
        fail: vi.fn().mockReturnThis(),
        warn: vi.fn().mockReturnThis(),
        info: vi.fn().mockReturnThis(),
        stop: vi.fn().mockReturnThis(),
    })),
}));

import { autoDetectInit } from '../config.js';
import { rolesAdd, rolesUpdate } from '../roles-cmd.js';
import { applyRoleResourceEdits, loadRolesManifest, saveRolesManifest, findRole } from '../roles.js';
import type { TeamRole } from '../roles.js';

const MANIFEST = `# Team roles — keep in sync with skills/ and knowledge/
version: 1
roles:
  - id: programmer
    description: Game programmer
    resources:
      knowledge: [common, genshin, design]   # rules baseline
      skills: [gsts, knowledge, design, mattpocock]
  - id: pm
    description: ''
    resources:
      knowledge: [common]
      skills: [common]
`;

let repoDir: string;

function readManifest(): string {
    return readFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), 'utf-8');
}

beforeEach(() => {
    logged.length = 0;
    repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-edit-'));
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), MANIFEST, 'utf-8');
    vi.mocked(autoDetectInit).mockResolvedValue({
        localConfig: {
            repo: { kind: 'git', localPath: repoDir },
            username: 'tester',
            scope: 'user',
        },
        teamConfig: {},
    } as never);
});

afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
});

describe('applyRoleResourceEdits', () => {
    const role: TeamRole = {
        id: 'programmer',
        description: '',
        resources: { knowledge: ['common', 'genshin'], skills: ['gsts', 'design'], agents: [] },
    };

    it('edits only the named resource type and keeps the other array untouched', () => {
        const out = applyRoleResourceEdits(role, { knowledge: { add: ['design'] } });
        expect(out.resources.knowledge).toEqual(['common', 'genshin', 'design']);
        expect(out.resources.skills).toBe(role.resources.skills);
        expect(role.resources.knowledge).toEqual(['common', 'genshin']);
    });

    it('applies add then remove, deduplicating', () => {
        const out = applyRoleResourceEdits(role, {
            skills: { add: ['design', 'common'], remove: ['gsts'] },
        });
        expect(out.resources.skills).toEqual(['design', 'common']);
    });

    it('never shares one array between knowledge and skills', () => {
        const out = applyRoleResourceEdits(role, {
            knowledge: { add: ['x'] },
            skills: { add: ['x'] },
        });
        expect(out.resources.knowledge).not.toBe(out.resources.skills);
    });
});

describe('saveRolesManifest — format preservation', () => {
    it('keeps comments and flow-style lists, and updates only the changed list', async () => {
        const manifest = await loadRolesManifest(repoDir);
        const role = findRole(manifest, 'programmer')!;
        role.resources.knowledge = [...role.resources.knowledge, 'extra'];
        await saveRolesManifest(repoDir, manifest);

        const text = readManifest();
        expect(text).toContain('# Team roles — keep in sync with skills/ and knowledge/');
        // yaml re-renders flow lists as `[ a, b ]`; the flow style and comment survive.
        expect(text).toMatch(/knowledge: \[ ?common, genshin, design, extra ?\] # rules baseline/);
        expect(text).toMatch(/skills: \[ ?gsts, knowledge, design, mattpocock ?\]/);
        expect(text).not.toMatch(/&a\d|\*a\d/);
    });

    it('appends new roles and drops removed ones without rewriting the rest', async () => {
        const manifest = await loadRolesManifest(repoDir);
        manifest.roles = [
            manifest.roles[0],
            { id: 'devops', description: 'Infra', resources: { knowledge: ['common'], skills: ['infra'], agents: [] } },
        ];
        await saveRolesManifest(repoDir, manifest);

        const text = readManifest();
        expect(text).toContain('# Team roles');
        expect(text).toMatch(/knowledge: \[ ?common, genshin, design ?\] # rules baseline/);
        expect(text).not.toContain('id: pm');
        expect(text).toContain('id: devops');
        const reloaded = await loadRolesManifest(repoDir);
        expect(reloaded.roles.map((r) => r.id)).toEqual(['programmer', 'devops']);
        expect(findRole(reloaded, 'devops')!.resources).toEqual({ knowledge: ['common'], skills: ['infra'], agents: [] });
    });

    it('repairs a manifest whose skills alias the knowledge list (written by the old bug)', async () => {
        writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), [
            'version: 1',
            'roles:',
            '  - id: programmer',
            '    description: ""',
            '    resources:',
            '      knowledge: &a1',
            '        - common',
            '        - gsts',
            '      skills: *a1',
            '',
        ].join('\n'), 'utf-8');

        const manifest = await loadRolesManifest(repoDir);
        manifest.roles[0].resources.knowledge = ['common', 'genshin'];
        await saveRolesManifest(repoDir, manifest);

        const text = readManifest();
        expect(text).not.toMatch(/&a\d|\*a\d/);
        const role = findRole(await loadRolesManifest(repoDir), 'programmer')!;
        expect(role.resources).toEqual({ knowledge: ['common', 'genshin'], skills: ['common', 'gsts'], agents: [] });
    });

    it('inlines a whole-map alias (resources: *r) without dropping extra keys', async () => {
        writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), [
            'version: 1',
            'roles:',
            '  - id: programmer',
            '    resources: &r',
            '      knowledge: [common]',
            '      skills: [gsts]',
            '      learnings: [old]',
            '  - id: pm',
            '    resources: *r',
            '',
        ].join('\n'), 'utf-8');

        const manifest = await loadRolesManifest(repoDir);
        findRole(manifest, 'pm')!.resources.skills = ['pm-tools'];
        await saveRolesManifest(repoDir, manifest);

        const text = readManifest();
        expect(text).not.toMatch(/&r|\*r/);
        expect(text).not.toContain('description');
        const reloaded = await loadRolesManifest(repoDir);
        expect(findRole(reloaded, 'programmer')!.resources).toEqual({ knowledge: ['common'], skills: ['gsts'], agents: [], learnings: ['old'] });
        expect(findRole(reloaded, 'pm')!.resources).toEqual({ knowledge: ['common'], skills: ['pm-tools'], agents: [], learnings: ['old'] });
    });

    it('writes a fresh manifest without anchors when no file exists', async () => {
        const fresh = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-fresh-'));
        const ns = ['common', 'hai'];
        await saveRolesManifest(fresh, {
            version: 1,
            roles: [{ id: 'hai', description: '', resources: { knowledge: ns, skills: ns, agents: [] } }],
        });
        const text = readFileSync(path.join(fresh, 'manifest', 'roles.yaml'), 'utf-8');
        expect(text).not.toMatch(/&a\d|\*a\d/);
        const reloaded = await loadRolesManifest(fresh);
        expect(reloaded.roles[0].resources).toEqual({ knowledge: ['common', 'hai'], skills: ['common', 'hai'], agents: [] });
        rmSync(fresh, { recursive: true, force: true });
    });
});

describe('roles update — knowledge and skills are edited independently', () => {
    it('--description alone leaves resources untouched', async () => {
        await rolesUpdate('programmer', { description: 'New desc' } as never);
        const reloaded = await loadRolesManifest(repoDir);
        const role = findRole(reloaded, 'programmer')!;
        expect(role.description).toBe('New desc');
        expect(role.resources.knowledge).toEqual(['common', 'genshin', 'design']);
        expect(role.resources.skills).toEqual(['gsts', 'knowledge', 'design', 'mattpocock']);
    });

    it('--add-namespaces adds to both sides without overwriting either', async () => {
        await rolesUpdate('programmer', { addNamespaces: 'common' } as never);
        const role = findRole(await loadRolesManifest(repoDir), 'programmer')!;
        expect(role.resources.knowledge).toEqual(['common', 'genshin', 'design']);
        expect(role.resources.skills).toEqual(['gsts', 'knowledge', 'design', 'mattpocock', 'common']);
        expect(readManifest()).not.toMatch(/&a\d|\*a\d/);
    });

    it('--add-knowledge / --remove-skills touch only their own side', async () => {
        await rolesUpdate('programmer', { addKnowledge: 'lore', removeSkills: 'mattpocock' } as never);
        const role = findRole(await loadRolesManifest(repoDir), 'programmer')!;
        expect(role.resources.knowledge).toEqual(['common', 'genshin', 'design', 'lore']);
        expect(role.resources.skills).toEqual(['gsts', 'knowledge', 'design']);
    });

    it('refuses to empty one side', async () => {
        await rolesUpdate('pm', { removeKnowledge: 'common' } as never);
        expect(logged.some((m) => /knowledge/.test(m) && /at least one/i.test(m))).toBe(true);
        const role = findRole(await loadRolesManifest(repoDir), 'pm')!;
        expect(role.resources.knowledge).toEqual(['common']);
    });

    it('--dry-run prints before/after for each changed side and writes nothing', async () => {
        await rolesUpdate('programmer', { addKnowledge: 'lore', dryRun: true } as never);
        expect(readManifest()).toBe(MANIFEST);
        const out = logged.join('\n');
        expect(out).toContain('knowledge: common, genshin, design -> common, genshin, design, lore');
        expect(out).not.toContain('skills:');
    });

    it('--remove-namespaces reports only the side that actually changes', async () => {
        await rolesUpdate('programmer', { removeNamespaces: 'genshin', dryRun: true } as never);
        const out = logged.join('\n');
        expect(out).toContain('knowledge: common, genshin, design -> common, design');
        expect(out).not.toContain('skills:');
    });

    it('reports nothing to change when the requested state already holds', async () => {
        await rolesUpdate('programmer', { addKnowledge: 'common' } as never);
        expect(logged.join('\n')).toMatch(/already matches/);
        expect(readManifest()).toBe(MANIFEST);
    });

    it('rejects a call with nothing to update, mentioning the new flags', async () => {
        await rolesUpdate('programmer', {} as never);
        expect(logged.join('\n')).toMatch(/--add-knowledge/);
        expect(readManifest()).toBe(MANIFEST);
    });
});

describe('roles add — knowledge and skills can differ', () => {
    it('--knowledge and --skills set each side separately', async () => {
        await rolesAdd('artist', { knowledge: 'common,art', skills: 'art-tools' } as never);
        const role = findRole(await loadRolesManifest(repoDir), 'artist')!;
        expect(role.resources).toEqual({ knowledge: ['common', 'art'], skills: ['art-tools'], agents: [] });
        expect(readManifest()).toContain('# Team roles');
    });

    it('--namespaces fills whichever side is not given explicitly, deduplicated', async () => {
        await rolesAdd('qa', { namespaces: 'common,qa,common', skills: 'qa, qa' } as never);
        const role = findRole(await loadRolesManifest(repoDir), 'qa')!;
        expect(role.resources).toEqual({ knowledge: ['common', 'qa'], skills: ['qa'], agents: ['common', 'qa'] });
    });

    it('errors when neither side can be filled', async () => {
        await rolesAdd('qa', { knowledge: 'common' } as never);
        expect(logged.join('\n')).toMatch(/--skills/);
        expect(findRole(await loadRolesManifest(repoDir), 'qa')).toBeUndefined();
    });
});
