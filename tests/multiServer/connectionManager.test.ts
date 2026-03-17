import { describe, expect, it, vi } from 'vitest';
import { MultiServerConnectionManager } from '../../src/multiServer/connectionManager';
import { ServerProfile } from '../../src/multiServer/types';

const verifyRiotPlanServerMock = vi.fn();
const disposeMock = vi.fn();

vi.mock('../../src/mcp-client', () => {
    return {
        HttpMcpClient: class MockHttpMcpClient {
            public readonly baseUrl: string;

            constructor(baseUrl: string) {
                this.baseUrl = baseUrl;
            }

            async verifyRiotPlanServer() {
                return verifyRiotPlanServerMock();
            }

            dispose() {
                disposeMock();
            }
        },
    };
});

function makeProfiles(): ServerProfile[] {
    return [
        {
            id: 's1',
            name: 'Server One',
            url: 'http://127.0.0.1:3002',
            enabled: true,
            proxyBypass: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
            id: 's2',
            name: 'Server Two',
            url: 'http://127.0.0.1:3003',
            enabled: true,
            proxyBypass: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        },
    ];
}

describe('MultiServerConnectionManager', () => {
    it('connects enabled profiles and tracks statuses', async () => {
        verifyRiotPlanServerMock
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false, reason: 'server_unreachable' });

        const manager = new MultiServerConnectionManager();
        manager.configureProfiles(makeProfiles(), 's1');

        const result = await manager.connectAll();

        expect(result.size).toBe(2);
        expect(manager.getClient('s1')).toBeTruthy();
        expect(manager.getClient('s2')).toBeTruthy();

        const statuses = manager.getStatuses();
        expect(statuses.find((status) => status.serverId === 's1')?.state).toBe('connected');
        expect(statuses.find((status) => status.serverId === 's2')?.state).toBe('disconnected');
    });

    it('disconnects and disposes clients', async () => {
        verifyRiotPlanServerMock.mockResolvedValue({ ok: true });
        const manager = new MultiServerConnectionManager();
        manager.configureProfiles(makeProfiles(), 's1');
        await manager.connect('s1');

        await manager.disconnect('s1');

        expect(manager.getClient('s1')).toBeUndefined();
        expect(disposeMock).toHaveBeenCalled();
    });

    it('does not throw when verify call fails', async () => {
        verifyRiotPlanServerMock.mockRejectedValue(new Error('network_down'));
        const manager = new MultiServerConnectionManager();
        manager.configureProfiles(makeProfiles(), 's1');

        await expect(manager.connectAll()).resolves.toBeInstanceOf(Map);
        expect(manager.getClient('s1')).toBeTruthy();
        const status = manager.getStatuses().find((entry) => entry.serverId === 's1');
        expect(status?.state).toBe('disconnected');
        expect(status?.lastError).toContain('network_down');
    });
});
