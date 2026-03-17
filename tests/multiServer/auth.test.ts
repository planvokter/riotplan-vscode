import { describe, expect, it } from 'vitest';
import { requestMatchesProfileOrigin, sanitizeToken, tokenStorageKey } from '../../src/multiServer/auth';
import { ServerProfile } from '../../src/multiServer/types';

const profile: ServerProfile = {
    id: 'srv-1',
    name: 'Server',
    url: 'https://riotplan.example.com',
    enabled: true,
    proxyBypass: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('multiServer auth', () => {
    it('builds server-scoped token storage keys', () => {
        expect(tokenStorageKey('abc')).toBe('riotplan.apiKey.server.abc');
    });

    it('sanitizes empty tokens to undefined', () => {
        expect(sanitizeToken('   ')).toBeUndefined();
        expect(sanitizeToken(' token ')).toBe('token');
    });

    it('matches request and profile origins', () => {
        expect(requestMatchesProfileOrigin(profile, 'https://riotplan.example.com/mcp')).toBe(true);
        expect(requestMatchesProfileOrigin(profile, 'https://other.example.com/mcp')).toBe(false);
    });
});
