import { describe, expect, it, vi } from 'vitest';
import { MultiServerAggregator } from '../../src/multiServer/aggregator';

function makeManager() {
    const serverAClient = {
        listPlans: vi.fn(async () => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        plans: [
                            { id: 'plan-a-1', name: 'Plan A1' },
                        ],
                    }),
                },
            ],
        })),
        listContextProjects: vi.fn(async () => [{ id: 'proj-a-1', name: 'Project A1' }]),
    };

    const serverBClient = {
        listPlans: vi.fn(async () => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        plans: [
                            { path: 'plans/plan-b-1', name: 'Plan B1' },
                        ],
                    }),
                },
            ],
        })),
        listContextProjects: vi.fn(async () => [{ id: 'proj-b-1', name: 'Project B1' }]),
    };

    const profiles = [
        { id: 'srv-a', name: 'Server A', enabled: true },
        { id: 'srv-b', name: 'Server B', enabled: true },
    ];

    const manager = {
        getProfiles: vi.fn(() => profiles),
        getClient: vi.fn((serverId: string) => (serverId === 'srv-a' ? serverAClient : serverBClient)),
    };

    return { manager, serverAClient, serverBClient };
}

describe('MultiServerAggregator', () => {
    it('merges plans with server-scoped refs and attribution', async () => {
        const { manager, serverAClient, serverBClient } = makeManager();
        const aggregator = new MultiServerAggregator(manager as any);

        const result = await aggregator.listPlans('all');
        const parsed = JSON.parse(result.content[0].text);
        const plans = parsed.plans;

        expect(plans).toHaveLength(2);
        expect(plans[0].serverId).toBe('srv-a');
        expect(plans[0].serverName).toBe('Server A');
        expect(plans[0].planId).toContain('srv-a::');

        expect(plans[1].serverId).toBe('srv-b');
        expect(plans[1].serverName).toBe('Server B');
        expect(plans[1].planId).toContain('srv-b::');

        expect(serverAClient.listPlans).toHaveBeenCalledWith('all');
        expect(serverBClient.listPlans).toHaveBeenCalledWith('all');
    });

    it('merges projects with server-scoped ids', async () => {
        const { manager, serverAClient, serverBClient } = makeManager();
        const aggregator = new MultiServerAggregator(manager as any);

        const projects = await aggregator.listContextProjects(true);

        expect(projects).toHaveLength(2);
        expect(projects[0].id).toContain('srv-a::');
        expect(projects[0].serverName).toBe('Server A');
        expect(projects[1].id).toContain('srv-b::');
        expect(projects[1].serverName).toBe('Server B');

        expect(serverAClient.listContextProjects).toHaveBeenCalledWith(true);
        expect(serverBClient.listContextProjects).toHaveBeenCalledWith(true);
    });
});
