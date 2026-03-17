/**
 * Connection Status Tree Provider
 *
 * Shows RiotPlan server connection status in the sidebar.
 * Mirrors Protokoll's multi-server view: each configured server appears
 * as its own tree item with name, state, URL, active badge, and token status.
 */

import * as vscode from 'vscode';
import { HttpMcpClient } from './mcp-client';

type ConnectionState = 'connected' | 'disconnected' | 'checking';
type PerServerState = 'connected' | 'connecting' | 'degraded' | 'disconnected';

interface PerServerStatus {
    serverId: string;
    serverName: string;
    serverUrl: string;
    state: PerServerState;
    lastError?: string;
    hasApiKey?: boolean;
    isActive?: boolean;
}

class StatusItem extends vscode.TreeItem {
    constructor(
        label: string,
        description?: string,
        iconId?: string,
        contextValue?: string,
        command?: vscode.Command
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        if (description) {
            this.description = description;
        }
        if (iconId) {
            this.iconPath = new vscode.ThemeIcon(iconId);
        }
        if (contextValue) {
            this.contextValue = contextValue;
        }
        if (command) {
            this.command = command;
        }
    }
}

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private connectionState: ConnectionState = 'checking';
    private serverUrl: string;
    private sessionId?: string;
    private serverStatuses: PerServerStatus[] = [];

    constructor(private mcpClient: HttpMcpClient, serverUrl: string) {
        this.serverUrl = serverUrl;
    }

    updateClient(client: HttpMcpClient, serverUrl: string): void {
        this.mcpClient = client;
        this.serverUrl = serverUrl;
        this.connectionState = 'checking';
        this._onDidChangeTreeData.fire();
    }

    setConnectionState(state: ConnectionState, sessionId?: string): void {
        this.connectionState = state;
        this.sessionId = sessionId;
        this._onDidChangeTreeData.fire();
    }

    setServerStatuses(statuses: PerServerStatus[]): void {
        this.serverStatuses = statuses;
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: StatusItem): vscode.TreeItem {
        return element;
    }

    getChildren(): StatusItem[] {
        const items: StatusItem[] = [];
        const reconnectCommand: vscode.Command = {
            command: 'riotplan.reconnect',
            title: 'Reconnect RiotPlan',
        };

        if (this.serverStatuses.length > 0) {
            for (const status of this.serverStatuses) {
                const stateLabel =
                    status.state === 'connected' ? 'Connected'
                        : status.state === 'connecting' ? 'Connecting'
                            : status.state === 'degraded' ? 'Degraded'
                                : 'Disconnected';

                const statusIcon =
                    status.state === 'connected' ? 'circle-filled'
                        : status.state === 'connecting' ? 'loading~spin'
                            : status.state === 'degraded' ? 'warning'
                                : 'circle-filled';

                const statusColor =
                    status.state === 'connected'
                        ? new vscode.ThemeColor('charts.green')
                        : new vscode.ThemeColor('charts.red');

                const tokenSuffix = status.hasApiKey ? 'token set' : 'no token';
                const label = `${status.serverName}: ${stateLabel}`;

                const activePrefix = status.isActive ? 'Active - ' : '';
                const description = `${activePrefix}${status.serverUrl} - ${tokenSuffix}`;

                const tooltip = [
                    status.serverName,
                    status.serverUrl,
                    `Status: ${stateLabel}`,
                    `API Token: ${status.hasApiKey ? 'Configured' : 'Not configured'}`,
                    status.isActive ? 'Active server' : undefined,
                    status.lastError ? `Error: ${status.lastError}` : undefined,
                ].filter(Boolean).join('\n');

                const item = new StatusItem(
                    label,
                    description,
                    statusIcon,
                    `connection-${status.serverId}`,
                    {
                        command: 'riotplan.showServerConnectionDetails',
                        title: 'Show Server Connection Details',
                        arguments: [status.serverId],
                    }
                );
                item.iconPath = new vscode.ThemeIcon(statusIcon, statusColor);
                item.tooltip = tooltip;
                items.push(item);
            }
        } else {
            const configureCommand: vscode.Command = {
                command: 'riotplan.configureServerUrl',
                title: 'Configure RiotPlan Server URL',
            };

            if (this.connectionState === 'connected') {
                items.push(
                    new StatusItem('Connected', undefined, 'circle-filled', 'status-connected', configureCommand)
                );
            } else if (this.connectionState === 'disconnected') {
                items.push(
                    new StatusItem('Disconnected', undefined, 'circle-slash', 'status-disconnected', configureCommand)
                );
            } else {
                items.push(
                    new StatusItem('Checking...', undefined, 'loading~spin', 'status-checking', configureCommand)
                );
            }

            items.push(new StatusItem('Server', this.serverUrl, 'server', 'status-server', configureCommand));
        }

        items.push(
            new StatusItem('Reconnect', undefined, 'refresh', 'status-reconnect', reconnectCommand)
        );

        return items;
    }
}
