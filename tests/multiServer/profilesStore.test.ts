import { beforeEach, describe, expect, it, vi } from 'vitest';

const configurationState: Record<string, unknown> = {};
const updateMock = vi.fn(async (key: string, value: unknown) => {
    configurationState[key] = value;
});

vi.mock('vscode', () => {
    return {
        workspace: {
            getConfiguration: vi.fn(() => ({
                get: (key: string, fallback?: unknown) =>
                    Object.prototype.hasOwnProperty.call(configurationState, key)
                        ? configurationState[key]
                        : fallback,
                update: updateMock,
            })),
        },
        ConfigurationTarget: {
            Global: 1,
        },
    };
});

import { ServerProfilesStore } from '../../src/multiServer/profilesStore';

describe('ServerProfilesStore', () => {
    beforeEach(() => {
        for (const key of Object.keys(configurationState)) {
            delete configurationState[key];
        }
        updateMock.mockClear();
    });

    it('bootstraps a default profile from legacy URL when no profiles exist', async () => {
        const store = new ServerProfilesStore();

        const { profiles, activeServerId } = await store.loadProfiles('https://riotplan.getfjell.com', true);

        expect(profiles).toHaveLength(1);
        expect(profiles[0].id).toBe('default-server');
        expect(profiles[0].url).toBe('https://riotplan.getfjell.com');
        expect(profiles[0].proxyBypass).toBe(true);
        expect(activeServerId).toBe('default-server');
        expect(updateMock).toHaveBeenCalled();
    });

    it('keeps configured profiles and resolves active server id', async () => {
        configurationState.serverProfiles = [
            {
                id: 'srv-a',
                name: 'A',
                url: 'https://a.example.com/',
                enabled: true,
            },
            {
                id: 'srv-b',
                name: 'B',
                url: 'https://b.example.com/',
                enabled: true,
            },
        ];
        configurationState.activeServerId = 'srv-b';
        const store = new ServerProfilesStore();

        const { profiles, activeServerId } = await store.loadProfiles('https://fallback.example.com', false);

        expect(profiles).toHaveLength(2);
        expect(profiles[0].url).toBe('https://a.example.com/');
        expect(activeServerId).toBe('srv-b');
        expect(updateMock).not.toHaveBeenCalledWith('activeServerId', expect.anything(), expect.anything());
    });
});
