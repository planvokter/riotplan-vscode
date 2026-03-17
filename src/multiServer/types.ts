export type ServerConnectionState = 'connected' | 'connecting' | 'degraded' | 'disconnected';

export interface ServerProfile {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
    proxyBypass: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface ServerRuntimeStatus {
    serverId: string;
    state: ServerConnectionState;
    serverUrl: string;
    sessionId?: string | null;
    lastError?: string;
}

export interface ResolvedServerRef {
    serverId: string;
    value: string;
}

const SERVER_REF_SEPARATOR = '::';

export function toServerScopedRef(serverId: string, value: string): string {
    return `${serverId}${SERVER_REF_SEPARATOR}${value}`;
}

export function fromServerScopedRef(ref: string): ResolvedServerRef | undefined {
    const trimmed = ref.trim();
    if (!trimmed) {
        return undefined;
    }
    const separatorIdx = trimmed.indexOf(SERVER_REF_SEPARATOR);
    if (separatorIdx <= 0 || separatorIdx >= trimmed.length - SERVER_REF_SEPARATOR.length) {
        return undefined;
    }
    const serverId = trimmed.slice(0, separatorIdx).trim();
    const value = trimmed.slice(separatorIdx + SERVER_REF_SEPARATOR.length).trim();
    if (!serverId || !value) {
        return undefined;
    }
    return { serverId, value };
}
