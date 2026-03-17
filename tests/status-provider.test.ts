import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class EventEmitter<T> {
        event = (_listener: T) => ({ dispose: () => {} });
        fire = () => {};
    }
    class TreeItem {
        label: string;
        collapsibleState: number;
        description?: string;
        iconPath?: unknown;
        contextValue?: string;
        command?: unknown;
        tooltip?: string;
        constructor(label: string, collapsibleState: number) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    }
    class ThemeIcon {
        id: string;
        color?: unknown;
        constructor(id: string, color?: unknown) {
            this.id = id;
            this.color = color;
        }
    }
    class ThemeColor {
        id: string;
        constructor(id: string) { this.id = id; }
    }
    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        ThemeColor,
        TreeItemCollapsibleState: {
            None: 0,
            Collapsed: 1,
            Expanded: 2,
        },
    };
});

import { StatusTreeProvider } from '../src/status-provider';

describe('StatusTreeProvider', () => {
    it('renders per-server statuses with active badge and token info', () => {
        const provider = new StatusTreeProvider({} as any, 'http://localhost:3002');
        provider.setServerStatuses([
            { serverId: 's1', serverName: 'Local', serverUrl: 'http://127.0.0.1:3002', state: 'connected', hasApiKey: true, isActive: true },
            { serverId: 's2', serverName: 'Remote', serverUrl: 'https://riotplan.getfjell.com', state: 'disconnected', hasApiKey: false, isActive: false, lastError: 'timeout' },
        ]);

        const items = provider.getChildren();

        expect(items[0].label).toBe('Local: Connected');
        expect(items[0].description).toContain('Active');
        expect(items[0].description).toContain('token set');
        expect(items[1].label).toBe('Remote: Disconnected');
        expect(items[1].description).not.toContain('Active');
        expect(items[1].description).toContain('no token');
        expect(items[1].tooltip).toContain('timeout');
        expect(items[items.length - 1].label).toBe('Reconnect');
    });

    it('resets to checking state when client and server URL are updated', () => {
        const provider = new StatusTreeProvider({} as any, 'http://localhost:3002');
        provider.setConnectionState('disconnected', 'abcdef123456');

        provider.updateClient({} as any, 'http://127.0.0.1:4000');
        const items = provider.getChildren();

        expect(items[0].label).toBe('Checking...');
        expect(items[1].description).toBe('http://127.0.0.1:4000');
    });

    it('renders disconnected state without session row when session is missing', () => {
        const provider = new StatusTreeProvider({} as any, 'http://localhost:3002');
        provider.setConnectionState('disconnected');

        const items = provider.getChildren();

        expect(items[0].label).toBe('Disconnected');
        expect(items.some((item) => item.label === 'Session')).toBe(false);
    });

    it('supports refresh and getTreeItem passthrough', () => {
        const provider = new StatusTreeProvider({} as any, 'http://localhost:3002');
        const fireSpy = vi.spyOn((provider as any)._onDidChangeTreeData, 'fire');

        provider.refresh();
        const element = { label: 'Any', collapsibleState: 0 } as any;
        const treeItem = provider.getTreeItem(element);

        expect(fireSpy).toHaveBeenCalled();
        expect(treeItem).toBe(element);
    });
});
