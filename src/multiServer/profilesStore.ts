import * as vscode from 'vscode';
import { ServerProfile } from './types';

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3002';
const DEFAULT_SERVER_NAME = 'Server';
const DEFAULT_SERVER_ID = 'default-server';

function nowIso(): string {
    return new Date().toISOString();
}

function normalizeServerProfile(input: Partial<ServerProfile>): ServerProfile | undefined {
    const id = String(input.id || '').trim();
    const name = String(input.name || '').trim();
    const url = String(input.url || '').trim();
    if (!id || !name || !url) {
        return undefined;
    }
    return {
        id,
        name,
        url,
        enabled: input.enabled !== false,
        proxyBypass: input.proxyBypass === true,
        createdAt: String(input.createdAt || nowIso()),
        updatedAt: String(input.updatedAt || nowIso()),
    };
}

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

export class ServerProfilesStore {
    private readonly configuration = vscode.workspace.getConfiguration('riotplan');

    async loadProfiles(legacyServerUrl: string, legacyProxyBypass: boolean): Promise<{ profiles: ServerProfile[]; activeServerId: string }> {
        const configured = this.configuration.get<unknown[]>('serverProfiles', []);
        const normalized = configured
            .map((entry) => normalizeServerProfile((entry || {}) as Partial<ServerProfile>))
            .filter((entry): entry is ServerProfile => Boolean(entry));

        if (normalized.length > 0) {
            const configuredActive = this.getActiveServerId();
            const resolvedActive = configuredActive && normalized.some((profile) => profile.id === configuredActive)
                ? configuredActive
                : normalized[0].id;
            if (resolvedActive !== configuredActive) {
                await this.setActiveServerId(resolvedActive);
            }
            return { profiles: normalized, activeServerId: resolvedActive };
        }

        const created = this.createDefaultProfile(legacyServerUrl, legacyProxyBypass);
        await this.saveProfiles([created]);
        await this.setActiveServerId(created.id);
        return { profiles: [created], activeServerId: created.id };
    }

    async saveProfiles(profiles: ServerProfile[]): Promise<void> {
        await this.configuration.update('serverProfiles', profiles, vscode.ConfigurationTarget.Global);
    }

    getActiveServerId(): string | undefined {
        const value = this.configuration.get<string>('activeServerId', '').trim();
        return value || undefined;
    }

    async setActiveServerId(serverId: string): Promise<void> {
        await this.configuration.update('activeServerId', serverId, vscode.ConfigurationTarget.Global);
    }

    createDefaultProfile(legacyServerUrl: string, legacyProxyBypass: boolean): ServerProfile {
        const timestamp = nowIso();
        return {
            id: DEFAULT_SERVER_ID,
            name: DEFAULT_SERVER_NAME,
            url: normalizeUrl(legacyServerUrl || DEFAULT_SERVER_URL),
            enabled: true,
            proxyBypass: legacyProxyBypass,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
    }
}
