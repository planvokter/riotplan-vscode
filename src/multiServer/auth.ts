import { ServerProfile } from './types';

const TOKEN_KEY_PREFIX = 'riotplan.apiKey.server.';

export function tokenStorageKey(serverId: string): string {
    return `${TOKEN_KEY_PREFIX}${serverId}`;
}

export function sanitizeToken(token: string | undefined): string | undefined {
    const trimmed = String(token || '').trim();
    return trimmed || undefined;
}

export function requestMatchesProfileOrigin(profile: ServerProfile, requestUrl: string): boolean {
    try {
        const profileOrigin = new URL(profile.url).origin;
        const requestOrigin = new URL(requestUrl).origin;
        return profileOrigin === requestOrigin;
    } catch {
        return false;
    }
}
