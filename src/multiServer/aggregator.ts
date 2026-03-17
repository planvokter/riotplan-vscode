import { HttpMcpClient } from '../mcp-client';
import { MultiServerConnectionManager } from './connectionManager';
import { toServerScopedRef } from './types';

interface ServerPlanShape {
    [key: string]: unknown;
    id?: string;
    uuid?: string;
    planId?: string;
    path?: string;
    code?: string;
    name?: string;
}

function parsePlansResult(result: any): ServerPlanShape[] {
    const content = result?.content?.[0];
    if (content?.type !== 'text') {
        return [];
    }
    try {
        const parsed = JSON.parse(content.text);
        return Array.isArray(parsed?.plans) ? parsed.plans : [];
    } catch {
        return [];
    }
}

function parseProjectsResult(raw: unknown): any[] {
    return Array.isArray(raw) ? raw : [];
}

function resolvePlanRef(plan: ServerPlanShape): string | undefined {
    const candidates = [plan.path, plan.planId, plan.id, plan.uuid, plan.code, plan.name];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }
    return undefined;
}

export class MultiServerAggregator {
    constructor(private readonly manager: MultiServerConnectionManager) {}

    async listPlans(filter?: 'all' | 'active' | 'done' | 'hold'): Promise<any> {
        const merged: any[] = [];
        const profiles = this.manager.getProfiles().filter((profile) => profile.enabled);
        await Promise.all(profiles.map(async (profile) => {
            const client = this.manager.getClient(profile.id);
            if (!client) {
                return;
            }
            const result = await client.listPlans(filter);
            const plans = parsePlansResult(result);
            for (const plan of plans) {
                const ref = resolvePlanRef(plan);
                merged.push({
                    ...plan,
                    serverId: profile.id,
                    serverName: profile.name,
                    sourceRef: ref,
                    planId: ref ? toServerScopedRef(profile.id, ref) : undefined,
                    path: ref ? toServerScopedRef(profile.id, ref) : undefined,
                    id: ref ? toServerScopedRef(profile.id, ref) : undefined,
                });
            }
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({ plans: merged }),
                },
            ],
        };
    }

    async listContextProjects(includeInactive = true): Promise<any[]> {
        const merged: any[] = [];
        const profiles = this.manager.getProfiles().filter((profile) => profile.enabled);
        await Promise.all(profiles.map(async (profile) => {
            const client = this.manager.getClient(profile.id);
            if (!client) {
                return;
            }
            const projects = parseProjectsResult(await client.listContextProjects(includeInactive));
            for (const project of projects) {
                merged.push({
                    ...project,
                    serverId: profile.id,
                    serverName: profile.name,
                    id: project?.id ? toServerScopedRef(profile.id, String(project.id)) : undefined,
                });
            }
        }));
        return merged;
    }

    getClientForServer(serverId: string): HttpMcpClient | undefined {
        return this.manager.getClient(serverId);
    }
}
