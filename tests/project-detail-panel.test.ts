import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { getPlanNavigationRef, projectMatchesPlan } from '../src/project-detail-panel';

describe('projectMatchesPlan', () => {
    it('matches by exact project id', () => {
        const matches = projectMatchesPlan(
            { id: 'project-123', name: 'Proveverk' },
            'project-123',
            {
                id: 'plan-1',
                project: { id: 'project-123' },
            }
        );

        expect(matches).toBe(true);
    });

    it('matches when entity uses UUID id but binding uses repo key', () => {
        const matches = projectMatchesPlan(
            {
                id: '77f97895-e4bb-4ff8-ae3d-d0f8f89b4ec8',
                name: 'Proveverk',
                repo: {
                    provider: 'github',
                    owner: 'kjerneverk',
                    name: 'proveverk',
                },
            },
            '77f97895-e4bb-4ff8-ae3d-d0f8f89b4ec8',
            {
                id: 'plan-2',
                project: { id: 'kjerneverk/proveverk' },
            }
        );

        expect(matches).toBe(true);
    });

    it('matches by project name as a compatibility fallback', () => {
        const matches = projectMatchesPlan(
            { id: 'uuid-1', name: 'Proveverk' },
            'uuid-1',
            {
                id: 'plan-3',
                project: { id: 'legacy-proveverk', name: 'Proveverk' },
            }
        );

        expect(matches).toBe(true);
    });

    it('does not match unrelated projects', () => {
        const matches = projectMatchesPlan(
            { id: 'project-a', name: 'Proveverk' },
            'project-a',
            {
                id: 'plan-4',
                project: { id: 'project-b', name: 'Other' },
            }
        );

        expect(matches).toBe(false);
    });

    it('matches when plan binding uses SSH repository URL', () => {
        const matches = projectMatchesPlan(
            {
                id: 'project-ssh',
                repo: {
                    provider: 'github',
                    owner: 'kjerneverk',
                    name: 'riotplan',
                },
            },
            'project-ssh',
            {
                id: 'plan-ssh',
                project: {
                    repo: {
                        url: 'git@github.com:planvokter/riotplan.git',
                    },
                },
            }
        );

        expect(matches).toBe(true);
    });

    it('matches when plan binding uses HTTPS repository URL', () => {
        const matches = projectMatchesPlan(
            {
                id: 'project-https',
                repo: {
                    provider: 'github',
                    owner: 'kjerneverk',
                    name: 'riotplan-vscode',
                },
            },
            'project-https',
            {
                id: 'plan-https',
                project: {
                    repo: {
                        url: 'https://github.com/planvokter/riotplan-vscode.git',
                    },
                },
            }
        );

        expect(matches).toBe(true);
    });

    it('returns false when neither project nor plan provides match keys', () => {
        const matches = projectMatchesPlan(
            {},
            '',
            {
                id: 'plan-empty',
                project: {},
            }
        );

        expect(matches).toBe(false);
    });

    it('returns false when project has keys but plan project block is missing', () => {
        const matches = projectMatchesPlan(
            { id: 'project-with-keys' },
            'project-with-keys',
            {
                id: 'plan-without-project',
            }
        );

        expect(matches).toBe(false);
    });
});

describe('getPlanNavigationRef', () => {
    it('prefers path over UUID for opening plans', () => {
        const ref = getPlanNavigationRef({
            id: 'plan-id',
            uuid: '2d5ec415-154f-4db4-8b5f-4c4a0d9d4022',
            path: 'active/my-plan',
        });

        expect(ref).toBe('active/my-plan');
    });

    it('falls back to uuid when no path/id/code exists', () => {
        const ref = getPlanNavigationRef({
            uuid: '2d5ec415-154f-4db4-8b5f-4c4a0d9d4022',
        });

        expect(ref).toBe('2d5ec415-154f-4db4-8b5f-4c4a0d9d4022');
    });

    it('returns empty string when no usable reference exists', () => {
        const ref = getPlanNavigationRef({});
        expect(ref).toBe('');
    });

    it('falls back to id, then code when path is missing', () => {
        const refFromId = getPlanNavigationRef({ id: 'plan-id-only' });
        const refFromCode = getPlanNavigationRef({ code: 'plan-code-only' });

        expect(refFromId).toBe('plan-id-only');
        expect(refFromCode).toBe('plan-code-only');
    });
});
