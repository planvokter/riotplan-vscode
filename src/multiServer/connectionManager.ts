import { HttpMcpClient } from '../mcp-client';
import { ServerProfile, ServerRuntimeStatus } from './types';

export class MultiServerConnectionManager {
    private readonly clients = new Map<string, HttpMcpClient>();
    private readonly statuses = new Map<string, ServerRuntimeStatus>();
    private profiles: ServerProfile[] = [];
    private activeServerId?: string;

    configureProfiles(profiles: ServerProfile[], activeServerId?: string): void {
        this.profiles = profiles;
        this.activeServerId = activeServerId;
        for (const profile of profiles) {
            this.statuses.set(profile.id, {
                serverId: profile.id,
                state: 'disconnected',
                serverUrl: profile.url,
            });
        }
    }

    getProfiles(): ServerProfile[] {
        return [...this.profiles];
    }

    getActiveServerId(): string | undefined {
        return this.activeServerId;
    }

    setActiveServerId(serverId: string): void {
        this.activeServerId = serverId;
    }

    getActiveClient(): HttpMcpClient | undefined {
        if (this.activeServerId) {
            return this.clients.get(this.activeServerId);
        }
        const fallback = this.getEnabledProfiles()[0];
        if (!fallback) {
            return undefined;
        }
        return this.clients.get(fallback.id);
    }

    getClient(serverId: string): HttpMcpClient | undefined {
        return this.clients.get(serverId);
    }

    setClientApiKey(serverId: string, apiKey?: string): void {
        const client = this.clients.get(serverId);
        if (!client) {
            return;
        }
        client.setApiKey(apiKey);
    }

    getStatuses(): ServerRuntimeStatus[] {
        return [...this.statuses.values()];
    }

    async connectAll(): Promise<Map<string, ServerRuntimeStatus>> {
        const result = new Map<string, ServerRuntimeStatus>();
        const enabledProfiles = this.getEnabledProfiles();
        await Promise.all(enabledProfiles.map(async (profile) => {
            const status = await this.connect(profile.id);
            result.set(profile.id, status);
        }));
        return result;
    }

    async connect(serverId: string): Promise<ServerRuntimeStatus> {
        const profile = this.getProfile(serverId);
        if (!profile) {
            const status: ServerRuntimeStatus = {
                serverId,
                state: 'disconnected',
                serverUrl: '',
                lastError: 'Unknown server profile',
            };
            this.statuses.set(serverId, status);
            return status;
        }

        this.statuses.set(serverId, {
            serverId,
            state: 'connecting',
            serverUrl: profile.url,
        });

        const client = new HttpMcpClient(profile.url, undefined, profile.proxyBypass);
        try {
            const verification = await client.verifyRiotPlanServer();
            const status: ServerRuntimeStatus = {
                serverId,
                state: verification.ok ? 'connected' : 'disconnected',
                serverUrl: profile.url,
                lastError: verification.ok ? undefined : verification.reason || 'Connection check failed',
            };
            this.clients.set(serverId, client);
            this.statuses.set(serverId, status);
            return status;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const status: ServerRuntimeStatus = {
                serverId,
                state: 'disconnected',
                serverUrl: profile.url,
                lastError: message || 'Connection check failed',
            };
            // Keep client available for future retries and token updates.
            this.clients.set(serverId, client);
            this.statuses.set(serverId, status);
            return status;
        }
    }

    async disconnect(serverId: string): Promise<void> {
        const client = this.clients.get(serverId);
        if (client) {
            client.dispose();
            this.clients.delete(serverId);
        }
        const profile = this.getProfile(serverId);
        this.statuses.set(serverId, {
            serverId,
            state: 'disconnected',
            serverUrl: profile?.url || '',
        });
    }

    async dispose(): Promise<void> {
        for (const client of this.clients.values()) {
            client.dispose();
        }
        this.clients.clear();
    }

    private getProfile(serverId: string): ServerProfile | undefined {
        return this.profiles.find((profile) => profile.id === serverId);
    }

    private getEnabledProfiles(): ServerProfile[] {
        return this.profiles.filter((profile) => profile.enabled);
    }
}
