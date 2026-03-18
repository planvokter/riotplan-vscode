/**
 * RiotPlan VSCode Extension
 *
 * Provides plan management UI connected to RiotPlan HTTP MCP server
 */

import * as vscode from 'vscode';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpMcpClient } from './mcp-client';
import {
    PlanItem,
    PlansTreeProvider,
    PlanSortOrder,
    UNASSIGNED_PROJECT_FILTER,
    type PlanCategory,
} from './plans-provider';
import { PlanDetailPanel } from './plan-detail-panel';
import { ProjectDetailPanel } from './project-detail-panel';
import { StatusTreeProvider } from './status-provider';
import { DashboardViewProvider } from './dashboard-view';
import { ProjectsTreeProvider } from './projects-provider';
import { MultiServerConnectionManager } from './multiServer/connectionManager';
import { ServerProfilesStore } from './multiServer/profilesStore';
import { sanitizeToken, tokenStorageKey } from './multiServer/auth';
import { MultiServerAggregator } from './multiServer/aggregator';
import { fromServerScopedRef } from './multiServer/types';

interface ContextProject {
    id?: string;
    name?: string;
    active?: boolean;
    repo?: Record<string, unknown>;
    [key: string]: unknown;
}

interface ProjectQuickPickItem extends vscode.QuickPickItem {
    action: 'existing' | 'create';
    project?: ContextProject;
}

type PlanSelectionInput = PlanItem | any;

interface PlanTransferFile {
    format: 'riotplan-transfer';
    version: 1;
    exportedAt: string;
    source: {
        serverUrl: string;
        planRef: string;
    };
    plan: {
        code?: string;
        name?: string;
        description?: string;
        category?: PlanCategory;
        stage?: string;
        project?: ContextProject;
        ideaContent?: string | null;
    };
}

let mcpClient: HttpMcpClient;
let connectionManager: MultiServerConnectionManager;
let profilesStore: ServerProfilesStore;
let aggregator: MultiServerAggregator;
let plansProvider: PlansTreeProvider;
let projectsProvider: ProjectsTreeProvider;
let statusProvider: StatusTreeProvider;
let dashboardProvider: DashboardViewProvider;
let currentServerUrl = 'http://127.0.0.1:3002';
let extensionContextRef: vscode.ExtensionContext;
let currentProxyBypass = false;
const PLAN_LIST_AUTO_REFRESH_MS = 5 * 60 * 1000;
const PLAN_DETAIL_AUTO_REFRESH_MS = 2 * 60 * 1000;
const AUTH_DEBUG_CHANNEL_NAME = 'RiotPlan Auth Debug';

export async function activate(context: vscode.ExtensionContext) {
    console.log('RiotPlan extension is now active');
    extensionContextRef = context;

    // Initialize core objects synchronously so commands can reference them.
    profilesStore = new ServerProfilesStore();
    connectionManager = new MultiServerConnectionManager();
    currentServerUrl = getLegacyServerUrl() || 'http://127.0.0.1:3002';
    currentProxyBypass = getConfiguredProxyBypass();
    mcpClient = new HttpMcpClient(currentServerUrl, undefined, currentProxyBypass);
    aggregator = new MultiServerAggregator(connectionManager);
    plansProvider = new PlansTreeProvider(aggregator as any);
    projectsProvider = new ProjectsTreeProvider(aggregator as any);
    statusProvider = new StatusTreeProvider(mcpClient, currentServerUrl);
    dashboardProvider = new DashboardViewProvider(context.extensionUri);
    dashboardProvider.setClient(aggregator as any);
    const authDebugChannel = vscode.window.createOutputChannel(AUTH_DEBUG_CHANNEL_NAME);
    context.subscriptions.push(authDebugChannel);

    function syncDashboardFilters(): void {
        dashboardProvider.setFilters({
            projectFilter: plansProvider.getProjectFilter(),
            statuses: plansProvider.getStatusFilter(),
            sortOrder: plansProvider.getSortOrder(),
        });
    }

    function isAuthDebugLoggingEnabled(): boolean {
        return vscode.workspace.getConfiguration('riotplan').get<boolean>('debugAuthLogging', false);
    }

    function applyAuthDebugLogging(): void {
        const enabled = isAuthDebugLoggingEnabled();
        const logger = enabled
            ? (line: string) => authDebugChannel.appendLine(line)
            : undefined;
        mcpClient.setRequestDebugLogger(logger);
        for (const profile of connectionManager.getProfiles()) {
            connectionManager.getClient(profile.id)?.setRequestDebugLogger(logger);
        }
        if (enabled) {
            authDebugChannel.appendLine(`[${new Date().toISOString()}] Auth request logging is enabled.`);
        }
    }

    syncDashboardFilters();
    applyAuthDebugLogging();

    async function refreshServerStatuses(): Promise<void> {
        const profileMap = new Map(connectionManager.getProfiles().map((profile) => [profile.id, profile]));
        const activeId = connectionManager.getActiveServerId();
        const statuses = await Promise.all(connectionManager.getStatuses().map(async (status) => {
            const profile = profileMap.get(status.serverId);
            const secret = await context.secrets.get(tokenStorageKey(status.serverId));
            return {
                serverId: status.serverId,
                serverName: profile?.name || status.serverId,
                serverUrl: status.serverUrl || profile?.url || '',
                state: status.state,
                lastError: status.lastError,
                hasApiKey: Boolean(sanitizeToken(secret)),
                isActive: status.serverId === activeId,
            };
        }));
        statusProvider.setServerStatuses(statuses);
    }

    function applyConnectionSettings(newUrl: string, proxyBypass?: boolean): void {
        currentServerUrl = newUrl;
        currentProxyBypass = proxyBypass ?? currentProxyBypass;
        mcpClient = new HttpMcpClient(newUrl, undefined, currentProxyBypass);
        applyAuthDebugLogging();
        plansProvider.updateClient(aggregator as any);
        statusProvider.updateClient(mcpClient, newUrl);
        dashboardProvider.setClient(aggregator as any);
        projectsProvider.updateClient(aggregator as any);
        PlanDetailPanel.updateClientForAll(mcpClient);
        ProjectDetailPanel.updateClientForAll(mcpClient);
        syncDashboardFilters();
        plansProvider.refresh();
        projectsProvider.refresh();
        void checkConnection(newUrl);
        void refreshServerStatuses();
    }

    async function reloadConnectionsFromProfiles(): Promise<void> {
        try {
            const fallbackServerUrl = getLegacyServerUrl();
            const fallbackProxyBypass = getConfiguredProxyBypass();
            const { profiles, activeServerId: configuredActiveServerId } = await profilesStore.loadProfiles(
                fallbackServerUrl,
                fallbackProxyBypass
            );
            connectionManager.configureProfiles(profiles, configuredActiveServerId);
            await hydrateProfileApiKeys(context, profiles);
            await connectionManager.connectAll();
            applyAuthDebugLogging();
            aggregator = new MultiServerAggregator(connectionManager);

            let nextActiveServerId: string | undefined = configuredActiveServerId;
            if (!nextActiveServerId || !profiles.some((profile) => profile.id === nextActiveServerId && profile.enabled)) {
                nextActiveServerId = profiles.find((profile) => profile.enabled)?.id;
                if (nextActiveServerId) {
                    await profilesStore.setActiveServerId(nextActiveServerId);
                    connectionManager.setActiveServerId(nextActiveServerId);
                }
            }

            const activeClient = connectionManager.getActiveClient();
            if (activeClient) {
                mcpClient = activeClient;
                currentServerUrl = mcpClient.baseUrl;
            }
            applyAuthDebugLogging();

            plansProvider.updateClient(aggregator as any);
            projectsProvider.updateClient(aggregator as any);
            statusProvider.updateClient(mcpClient, currentServerUrl);
            dashboardProvider.setClient(aggregator as any);
            syncDashboardFilters();
            plansProvider.refresh();
            projectsProvider.refresh();
            await refreshServerStatuses();
            await checkConnection(currentServerUrl);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to reload connections from profiles:', message);
            vscode.window.showWarningMessage(`RiotPlan connection setup failed: ${message}`);
        }
    }

    async function pickServerProfile(title: string): Promise<{ id: string; name: string; url: string } | undefined> {
        const profiles = connectionManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showWarningMessage('No server profiles are configured.');
            return undefined;
        }
        const selection = await vscode.window.showQuickPick(
            profiles.map((profile) => ({
                label: profile.name,
                description: profile.url,
                detail: profile.id,
                profile,
            })),
            {
                title,
                placeHolder: 'Select a server profile',
            }
        );
        return selection?.profile;
    }

    // Register tree views
    const plansTreeView = vscode.window.createTreeView('riotplan-plans', {
        treeDataProvider: plansProvider,
        dragAndDropController: plansProvider,
        canSelectMany: true,
    });

    const connectionTreeView = vscode.window.createTreeView('riotplan-connection', {
        treeDataProvider: statusProvider,
    });

    const projectsTreeView = vscode.window.createTreeView('riotplan-projects', {
        treeDataProvider: projectsProvider,
    });

    context.subscriptions.push(plansTreeView, projectsTreeView, connectionTreeView);

    context.subscriptions.push(
        plansTreeView.onDidChangeSelection((event) => {
            const selected = event.selection?.[0];
            if (selected?.contextValue === 'plan') {
                void openPlan(selected);
            }
        })
    );

    // Periodic sync
    const listRefreshTimer = setInterval(() => {
        try {
            plansProvider.refresh();
            projectsProvider.refresh();
        } catch {
            // Ignore background refresh errors and keep timer alive.
        }
    }, PLAN_LIST_AUTO_REFRESH_MS);
    const detailRefreshTimer = setInterval(() => {
        try {
            PlanDetailPanel.scheduleRefreshForAllOpenPanels();
        } catch {
            // Ignore background refresh errors and keep timer alive.
        }
    }, PLAN_DETAIL_AUTO_REFRESH_MS);
    context.subscriptions.push(
        new vscode.Disposable(() => {
            clearInterval(listRefreshTimer);
            clearInterval(detailRefreshTimer);
        })
    );

    // ── Register ALL commands before any async work ──
    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.refreshPlans', () => {
            plansProvider.refresh();
            projectsProvider.refresh();
            checkConnection(currentServerUrl);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.filterPlansByProject', async () => {
            const projects = await mcpClient.listContextProjects(true).catch(() => []);
            const quickPickItems: Array<vscode.QuickPickItem & { value?: string }> = [
                {
                    label: '$(clear-all) Show all projects',
                    value: undefined,
                    description: 'Clear project filter',
                },
                {
                    label: '$(circle-slash) Unassigned',
                    value: UNASSIGNED_PROJECT_FILTER,
                    description: 'Plans with no assigned project',
                },
                ...sortedProjects(projects).map((project: ContextProject) => ({
                    label: String(project.name || project.id || 'Unnamed project'),
                    description: String(project.id || ''),
                    value: String(project.id || project.name || ''),
                })),
            ];
            const selected = await vscode.window.showQuickPick(quickPickItems, {
                title: 'Filter plans by project',
                placeHolder: 'Choose a project to filter by',
            });
            if (!selected) {
                return;
            }
            plansProvider.setProjectFilter(selected.value);
            syncDashboardFilters();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.filterPlansByStatus', async () => {
            const options: Array<{ label: string; category: PlanCategory; picked: boolean }> = [
                { label: 'Active', category: 'active', picked: true },
                { label: 'Done', category: 'done', picked: true },
                { label: 'Hold', category: 'hold', picked: true },
            ];
            const selected = await vscode.window.showQuickPick(options, {
                title: 'Filter plans by status',
                canPickMany: true,
                placeHolder: 'Select one or more statuses to display',
            });
            if (!selected) {
                return;
            }
            plansProvider.setStatusFilter(selected.map((entry) => entry.category));
            syncDashboardFilters();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.sortPlans', async () => {
            const options: Array<{ label: string; order: PlanSortOrder }> = [
                { label: 'Name (A-Z)', order: 'name-asc' },
                { label: 'Name (Z-A)', order: 'name-desc' },
                { label: 'Stage (A-Z)', order: 'stage-asc' },
                { label: 'Progress (high to low)', order: 'progress-desc' },
                { label: 'Progress (low to high)', order: 'progress-asc' },
            ];
            const selected = await vscode.window.showQuickPick(options, {
                title: 'Sort plans',
                placeHolder: 'Choose how plans should be ordered',
            });
            if (!selected) {
                return;
            }
            plansProvider.setSortOrder(selected.order);
            syncDashboardFilters();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.addPlan', async () => {
            try {
                const code = await vscode.window.showInputBox({
                    title: 'Create Plan',
                    prompt: 'Enter plan code (kebab-case recommended)',
                    placeHolder: 'my-new-plan',
                    validateInput: (value) => (value.trim().length > 0 ? null : 'Plan code is required'),
                });
                if (!code?.trim()) {
                    return;
                }
                const description = await vscode.window.showInputBox({
                    title: 'Create Plan',
                    prompt: 'Enter plan description',
                    validateInput: (value) => (value.trim().length > 0 ? null : 'Plan description is required'),
                });
                if (!description?.trim()) {
                    return;
                }
                const name = await vscode.window.showInputBox({
                    title: 'Create Plan',
                    prompt: 'Enter display name (optional)',
                });
                await mcpClient.createPlan({
                    code: code.trim(),
                    description: description.trim(),
                    name: name?.trim() || undefined,
                });
                plansProvider.refresh();
                projectsProvider.refresh();
                vscode.window.showInformationMessage(`Plan "${code.trim()}" created.`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to create plan: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.uploadPlan', async () => {
            try {
                const selected = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    openLabel: 'Upload plan',
                    filters: { 'Plan files': ['plan'] },
                });
                if (!selected || selected.length === 0) {
                    return;
                }
                const fileUri = selected[0];
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                const fileName = basename(fileUri.fsPath || fileUri.path || 'uploaded.plan');
                try {
                    await mcpClient.uploadPlanFile(fileName, Buffer.from(bytes));
                } catch {
                    // Backward-compatible fallback for older servers without /plan/upload.
                    const transfer = await readTransferFile(fileUri);
                    await importPlanFromTransfer(transfer);
                }
                plansProvider.refresh();
                projectsProvider.refresh();
                vscode.window.showInformationMessage(`Uploaded plan "${fileName}".`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to upload plan: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.configureServerUrl', async () => {
            const input = await vscode.window.showInputBox({
                title: 'RiotPlan Server URL',
                prompt: 'Set RiotPlan HTTP MCP server URL',
                value: currentServerUrl,
                placeHolder: 'http://127.0.0.1:3002',
                validateInput: (value) => {
                    try {
                        const parsed = new URL(value.trim());
                        if (!/^https?:$/.test(parsed.protocol)) {
                            return 'URL must use http or https';
                        }
                        return null;
                    } catch {
                        return 'Enter a valid URL';
                    }
                },
            });
            if (!input) {
                return;
            }
            const nextUrl = input.trim();
            const config = vscode.workspace.getConfiguration('riotplan');
            const inspected = config.inspect<string>('serverUrl');
            const target =
                inspected?.workspaceFolderValue !== undefined
                    ? vscode.ConfigurationTarget.WorkspaceFolder
                    : inspected?.workspaceValue !== undefined
                        ? vscode.ConfigurationTarget.Workspace
                        : vscode.ConfigurationTarget.Global;

            await config.update('serverUrl', nextUrl, target);
            applyConnectionSettings(nextUrl, getConfiguredProxyBypass());
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.reconnect', async () => {
            await reloadConnectionsFromProfiles();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.debugServerAuth', async (serverId?: string) => {
            await debugServerAuth(serverId);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.configureApiKey', async (serverId?: string) => {
            const profile = serverId
                ? connectionManager.getProfiles().find((entry) => entry.id === serverId)
                : await pickServerProfile('Configure API token');
            if (!profile) {
                return;
            }
            const token = await vscode.window.showInputBox({
                title: `API token: ${profile.name}`,
                prompt: 'Enter API token for this server profile',
                ignoreFocusOut: true,
                password: true,
                validateInput: (value) => (value.trim().length > 0 ? null : 'API token cannot be empty'),
            });
            if (!token?.trim()) {
                return;
            }
            const sanitized = sanitizeToken(token);
            if (!sanitized) {
                return;
            }
            await context.secrets.store(tokenStorageKey(profile.id), sanitized);
            connectionManager.setClientApiKey(profile.id, sanitized);
            await refreshServerStatuses();
            vscode.window.showInformationMessage(`Configured token for "${profile.name}".`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.clearApiKey', async (serverId?: string) => {
            const profile = serverId
                ? connectionManager.getProfiles().find((entry) => entry.id === serverId)
                : await pickServerProfile('Clear API token');
            if (!profile) {
                return;
            }
            const confirmation = await vscode.window.showWarningMessage(
                `Clear API token for "${profile.name}"?`,
                { modal: true },
                'Clear',
                'Cancel'
            );
            if (confirmation !== 'Clear') {
                return;
            }
            await context.secrets.delete(tokenStorageKey(profile.id));
            connectionManager.setClientApiKey(profile.id, undefined);
            await refreshServerStatuses();
            vscode.window.showInformationMessage(`Cleared token for "${profile.name}".`);
        })
    );

    async function addServerConnection(): Promise<void> {
        const profiles = connectionManager.getProfiles();
        const name = await vscode.window.showInputBox({
            title: 'Add server connection',
            prompt: 'Profile name',
            validateInput: (value) => (value.trim().length > 0 ? null : 'Profile name is required'),
        });
        if (!name?.trim()) {
            return;
        }
        const url = await vscode.window.showInputBox({
            title: 'Add server connection',
            prompt: 'Server URL',
            value: 'http://127.0.0.1:3002',
            validateInput: (value) => {
                try {
                    const parsed = new URL(value.trim());
                    return /^https?:$/.test(parsed.protocol) ? null : 'URL must use http or https';
                } catch {
                    return 'Enter a valid URL';
                }
            },
        });
        if (!url?.trim()) {
            return;
        }
        const bypassChoice = await vscode.window.showQuickPick(
            [
                { label: 'Use system proxy settings', value: false },
                { label: 'Bypass proxy for this server', value: true },
            ],
            {
                title: 'Proxy behavior',
            }
        );
        if (!bypassChoice) {
            return;
        }

        const timestamp = new Date().toISOString();
        const nextProfiles = [...profiles, {
            id: randomUUID(),
            name: name.trim(),
            url: url.trim(),
            enabled: true,
            proxyBypass: bypassChoice.value,
            createdAt: timestamp,
            updatedAt: timestamp,
        }];
        await profilesStore.saveProfiles(nextProfiles);
        await reloadConnectionsFromProfiles();
    }

    async function switchServerConnection(): Promise<void> {
        const selected = await pickServerProfile('Switch active server');
        if (!selected) {
            return;
        }
        await profilesStore.setActiveServerId(selected.id);
        connectionManager.setActiveServerId(selected.id);
        await reloadConnectionsFromProfiles();
        vscode.window.showInformationMessage(`Active server set to "${selected.name}".`);
    }

    async function showServerConnectionDetails(serverId?: string): Promise<void> {
        let selected: { id: string; name: string; url: string } | undefined;
        if (serverId) {
            const profile = connectionManager.getProfiles().find((p) => p.id === serverId);
            if (profile) {
                selected = profile;
            }
        }
        if (!selected) {
            selected = await pickServerProfile('Server connection details');
        }
        if (!selected) {
            return;
        }
        const secret = await context.secrets.get(tokenStorageKey(selected.id));
        const tokenState = sanitizeToken(secret) ? 'Configured (secret storage)' : 'Not configured';
        const status = connectionManager.getStatuses().find((entry) => entry.serverId === selected!.id);
        const connectionState = status?.state || 'disconnected';
        const sessionId = status?.sessionId || undefined;

        const lines = [
            `Server: ${selected.name}`,
            `URL: ${selected.url}`,
            `Status: ${connectionState.charAt(0).toUpperCase() + connectionState.slice(1)}`,
            sessionId ? `Connected Session ID: ${sessionId}` : undefined,
            `API Token: ${tokenState}`,
            status?.lastError ? `Error: ${status.lastError}` : undefined,
        ].filter(Boolean).join('\n');

        const isActive = connectionManager.getActiveServerId() === selected.id;
        const actions = isActive
            ? ['Configure Token', 'Reconnect']
            : ['Switch to this Server', 'Configure Token', 'Reconnect'];

        const action = await vscode.window.showInformationMessage(
            lines,
            { modal: false },
            ...actions
        );

        if (action === 'Switch to this Server') {
            await profilesStore.setActiveServerId(selected.id);
            connectionManager.setActiveServerId(selected.id);
            await reloadConnectionsFromProfiles();
            vscode.window.showInformationMessage(`Active server set to "${selected.name}".`);
        } else if (action === 'Configure Token') {
            await vscode.commands.executeCommand('riotplan.configureApiKey');
        } else if (action === 'Reconnect') {
            await reloadConnectionsFromProfiles();
        }
    }

    async function debugServerAuth(serverId?: string): Promise<void> {
        let selected: { id: string; name: string; url: string } | undefined;
        if (serverId) {
            const profile = connectionManager.getProfiles().find((entry) => entry.id === serverId);
            if (profile) {
                selected = { id: profile.id, name: profile.name, url: profile.url };
            }
        }
        if (!selected) {
            selected = await pickServerProfile('Debug auth token delivery');
        }
        if (!selected) {
            return;
        }

        applyAuthDebugLogging();
        authDebugChannel.appendLine('');
        authDebugChannel.appendLine(`[${new Date().toISOString()}] --- Debug auth for ${selected.name} (${selected.id}) ---`);
        authDebugChannel.appendLine(`Configured URL: ${selected.url}`);

        const secret = await context.secrets.get(tokenStorageKey(selected.id));
        const sanitizedSecret = sanitizeToken(secret);
        authDebugChannel.appendLine(
            `Secret storage token: ${sanitizedSecret ? `present (len=${sanitizedSecret.length}, last4=${tokenLast4(sanitizedSecret)})` : 'missing'}`
        );

        let client = connectionManager.getClient(selected.id);
        if (!client) {
            authDebugChannel.appendLine('No client found in memory for this server; connecting now...');
            await connectionManager.connect(selected.id);
            client = connectionManager.getClient(selected.id);
            applyAuthDebugLogging();
        }
        if (!client) {
            authDebugChannel.appendLine('Unable to create client for selected server.');
            authDebugChannel.show(true);
            vscode.window.showErrorMessage(`Could not create an MCP client for "${selected.name}".`);
            return;
        }

        const before = client.getAuthDebugState();
        authDebugChannel.appendLine(
            `Client token state before probe: present=${before.hasApiKey}, preview=${before.tokenPreview}, len=${before.tokenLength}`
        );
        authDebugChannel.appendLine(
            `Client session before probe: present=${before.hasSessionId}, preview=${before.sessionIdPreview}`
        );
        authDebugChannel.appendLine('Probe: sending tools/list request...');

        const hasGlobalDebugLogging = isAuthDebugLoggingEnabled();
        if (!hasGlobalDebugLogging) {
            client.setRequestDebugLogger((line: string) => authDebugChannel.appendLine(line));
        }
        try {
            const result = await client.sendRequest('tools/list');
            const tools = Array.isArray(result?.tools) ? result.tools : [];
            authDebugChannel.appendLine(`Probe result: success (${tools.length} tool${tools.length === 1 ? '' : 's'} returned).`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            authDebugChannel.appendLine(`Probe result: failed (${message})`);
        } finally {
            if (!hasGlobalDebugLogging) {
                client.setRequestDebugLogger(undefined);
            }
        }

        const after = client.getAuthDebugState();
        authDebugChannel.appendLine(
            `Client token state after probe: present=${after.hasApiKey}, preview=${after.tokenPreview}, len=${after.tokenLength}`
        );
        authDebugChannel.appendLine(
            `Client session after probe: present=${after.hasSessionId}, preview=${after.sessionIdPreview}`
        );

        authDebugChannel.show(true);
        vscode.window.showInformationMessage(`Auth debug output opened for "${selected.name}".`);
    }

    async function removeServerConnection(): Promise<void> {
        const selected = await pickServerProfile('Remove server connection');
        if (!selected) {
            return;
        }
        const confirmation = await vscode.window.showWarningMessage(
            `Remove server profile "${selected.name}"?`,
            { modal: true },
            'Remove',
            'Cancel'
        );
        if (confirmation !== 'Remove') {
            return;
        }
        const profiles = connectionManager.getProfiles();
        const updatedProfiles = profiles.filter((profile) => profile.id !== selected.id);
        await profilesStore.saveProfiles(updatedProfiles);
        await context.secrets.delete(tokenStorageKey(selected.id));
        await reloadConnectionsFromProfiles();
    }

    function resolvePlanCodeCandidate(plan: PlanSelectionInput, scopedRef: string, downloadedFilename: string): string {
        const fromLabel = typeof plan?.label === 'string' ? plan.label.trim() : '';
        if (fromLabel) {
            return sanitizePlanCode(fromLabel);
        }
        const fromName = typeof plan?.name === 'string' ? plan.name.trim() : '';
        if (fromName) {
            return sanitizePlanCode(fromName);
        }
        const fromRef = sanitizePlanCode(fromServerScopedRef(scopedRef)?.value || scopedRef);
        if (fromRef) {
            return fromRef;
        }
        return sanitizePlanCode(downloadedFilename.replace(/\.plan$/i, ''));
    }

    function findTargetPlanConflict(plans: any[], candidateCode: string): string | undefined {
        const normalized = candidateCode.toLowerCase();
        for (const plan of plans) {
            const values = [
                typeof plan?.code === 'string' ? plan.code : '',
                typeof plan?.name === 'string' ? plan.name : '',
                typeof plan?.title === 'string' ? plan.title : '',
                typeof plan?.id === 'string' ? plan.id : '',
                typeof plan?.path === 'string' ? basename(plan.path) : '',
            ]
                .map((value) => sanitizePlanCode(value))
                .filter(Boolean);
            if (values.some((value) => value.toLowerCase() === normalized)) {
                return resolvePlanRef(plan);
            }
        }
        return undefined;
    }

    async function transferPlanToServer(plan: PlanSelectionInput): Promise<void> {
        const scopedPlanRef = resolvePlanRef(plan);
        if (!scopedPlanRef) {
            vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
            return;
        }
        const sourceScoped = fromServerScopedRef(scopedPlanRef);
        const sourceServerId = sourceScoped?.serverId || connectionManager.getActiveServerId();
        const sourceServer = sourceServerId
            ? connectionManager.getProfiles().find((profile) => profile.id === sourceServerId)
            : undefined;

        const candidates = connectionManager.getProfiles().filter((profile) => {
            if (!profile.enabled) {
                return false;
            }
            if (!sourceServerId) {
                return true;
            }
            return profile.id !== sourceServerId;
        });
        if (candidates.length === 0) {
            vscode.window.showWarningMessage('No other enabled servers are available for transfer.');
            return;
        }

        const targetSelection = await vscode.window.showQuickPick(
            candidates.map((profile) => ({
                label: profile.name,
                description: profile.url,
                detail: profile.id,
                profile,
            })),
            {
                title: 'Transfer Plan to Server',
                placeHolder: 'Select target server',
                ignoreFocusOut: true,
            }
        );
        if (!targetSelection) {
            return;
        }

        const modeSelection = await vscode.window.showQuickPick(
            [
                { label: 'Move', description: 'Copy to target, then remove from source', mode: 'move' as const },
                { label: 'Copy', description: 'Keep source plan and add to target', mode: 'copy' as const },
            ],
            {
                title: 'Transfer Mode',
                placeHolder: 'Select transfer mode',
                ignoreFocusOut: true,
            }
        );
        if (!modeSelection) {
            return;
        }

        const { client: sourceClient, planRef } = resolvePlanClientAndRef(scopedPlanRef);
        const targetProfile = targetSelection.profile;
        let targetClient = connectionManager.getClient(targetProfile.id);
        if (!targetClient) {
            await connectionManager.connect(targetProfile.id);
            targetClient = connectionManager.getClient(targetProfile.id);
        }
        if (!targetClient) {
            vscode.window.showErrorMessage(`Failed to connect to target server "${targetProfile.name}".`);
            return;
        }

        let moveCleanupError: string | undefined;
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Transferring "${plan?.label || planRef}"`,
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: 'Downloading plan from source...' });
                const downloaded = await sourceClient.downloadPlanFile(planRef);
                const candidateCode = sanitizePlanCode(
                    plan?.label || plan?.name || plan?.code || planRef
                ) || 'transferred-plan';

                progress.report({ message: 'Checking target conflicts...' });
                const targetListResponse = await targetClient.listPlans('all');
                const targetPlans = JSON.parse(String(targetListResponse?.content?.[0]?.text || '{"plans": []}')).plans || [];
                const conflictingPlanRef = findTargetPlanConflict(targetPlans, candidateCode);

                let targetCode = candidateCode;
                if (conflictingPlanRef) {
                    const conflictAction = await vscode.window.showQuickPick(
                        [
                            { label: 'Overwrite', value: 'overwrite' as const, description: 'Remove existing target plan then create' },
                            { label: 'Rename', value: 'rename' as const, description: 'Create with a new plan code' },
                            { label: 'Skip', value: 'skip' as const, description: 'Cancel transfer for this plan' },
                        ],
                        {
                            title: 'Plan conflict detected',
                            placeHolder: `A plan with code "${candidateCode}" exists on ${targetProfile.name}.`,
                            ignoreFocusOut: true,
                        }
                    );
                    if (!conflictAction || conflictAction.value === 'skip') {
                        return;
                    }
                    if (conflictAction.value === 'overwrite') {
                        progress.report({ message: 'Removing conflicting plan on target...' });
                        await deletePlanBestEffort(targetClient, conflictingPlanRef);
                    } else if (conflictAction.value === 'rename') {
                        const renamed = await vscode.window.showInputBox({
                            title: 'Rename transferred plan',
                            prompt: 'Enter a new plan code',
                            value: `${candidateCode}-copy`,
                            ignoreFocusOut: true,
                            validateInput: (value) => (sanitizePlanCode(value).length > 0 ? null : 'Enter a valid name'),
                        });
                        if (!renamed?.trim()) {
                            return;
                        }
                        targetCode = sanitizePlanCode(renamed);
                    }
                }

                const uploadFilename = `${sanitizeFileName(targetCode)}.plan`;
                progress.report({ message: `Uploading plan file to ${targetProfile.name}...` });
                await targetClient.uploadPlanFile(uploadFilename, downloaded.content);

                if (modeSelection.mode === 'move') {
                    progress.report({ message: 'Removing source plan...' });
                    const deleteError = await deletePlanWithReport(sourceClient, planRef);
                    if (deleteError) {
                        moveCleanupError = deleteError;
                    }
                }
            }
        );

        plansProvider.refresh();
        projectsProvider.refresh();
        await refreshServerStatuses();
        if (moveCleanupError) {
            vscode.window.showWarningMessage(
                `Plan copied to "${targetProfile.name}", but removing source failed: ${moveCleanupError}`
            );
        } else {
            const modeLabel = modeSelection.mode === 'move' ? 'Moved' : 'Copied';
            vscode.window.showInformationMessage(`${modeLabel} plan to "${targetProfile.name}".`);
        }
        if (sourceServer) {
            void checkConnection(sourceServer.url);
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.openServerManager', async () => {
            try {
                const action = await vscode.window.showQuickPick(
                    [
                        { label: 'Add server connection', value: 'add' },
                        { label: 'Switch active server', value: 'switch' },
                        { label: 'Show server connection details', value: 'details' },
                        { label: 'Edit server URL', value: 'edit' },
                        { label: 'Remove server profile', value: 'remove' },
                        { label: 'Configure API token', value: 'setToken' },
                        { label: 'Clear API token', value: 'clearToken' },
                        { label: 'Reconnect all servers', value: 'reconnect' },
                        { label: 'Open RiotPlan settings (UI)', value: 'settingsUi' },
                        { label: 'Open RiotPlan settings (JSON)', value: 'settingsJson' },
                    ],
                    {
                        title: 'Manage Servers and Tokens',
                        placeHolder: 'Choose a server management action',
                    }
                );
                if (!action) {
                    return;
                }
                if (action.value === 'setToken') {
                    await vscode.commands.executeCommand('riotplan.configureApiKey');
                    return;
                }
                if (action.value === 'clearToken') {
                    await vscode.commands.executeCommand('riotplan.clearApiKey');
                    return;
                }
                if (action.value === 'reconnect') {
                    await reloadConnectionsFromProfiles();
                    return;
                }
                if (action.value === 'settingsUi') {
                    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:kjerneverk.riotplan-vscode');
                    return;
                }
                if (action.value === 'settingsJson') {
                    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
                    return;
                }
                if (action.value === 'add') {
                    await addServerConnection();
                    return;
                }
                if (action.value === 'switch') {
                    await switchServerConnection();
                    return;
                }
                if (action.value === 'details') {
                    await showServerConnectionDetails();
                    return;
                }
                if (action.value === 'remove') {
                    await removeServerConnection();
                    return;
                }

                const selected = await pickServerProfile('Select server profile');
                if (!selected) {
                    return;
                }

                if (action.value === 'switch') {
                    await profilesStore.setActiveServerId(selected.id);
                    connectionManager.setActiveServerId(selected.id);
                    await reloadConnectionsFromProfiles();
                    vscode.window.showInformationMessage(`Active server set to "${selected.name}".`);
                    return;
                }

                if (action.value === 'edit') {
                    const nextUrl = await vscode.window.showInputBox({
                        title: `Edit server URL: ${selected.name}`,
                        value: selected.url,
                        validateInput: (value) => {
                            try {
                                const parsed = new URL(value.trim());
                                return /^https?:$/.test(parsed.protocol) ? null : 'URL must use http or https';
                            } catch {
                                return 'Enter a valid URL';
                            }
                        },
                    });
                    if (!nextUrl?.trim()) {
                        return;
                    }
                    const profiles = connectionManager.getProfiles();
                    const updatedProfiles = profiles.map((profile) => {
                        if (profile.id !== selected.id) {
                            return profile;
                        }
                        return {
                            ...profile,
                            url: nextUrl.trim(),
                            updatedAt: new Date().toISOString(),
                        };
                    });
                    await profilesStore.saveProfiles(updatedProfiles);
                    await reloadConnectionsFromProfiles();
                    return;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Manage Servers and Tokens failed: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.addServerConnection', async () => {
            await addServerConnection();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.switchServerConnection', async () => {
            await switchServerConnection();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.showServerConnectionDetails', async (serverId?: string) => {
            await showServerConnectionDetails(serverId);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.removeServerConnection', async () => {
            await removeServerConnection();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.openPlan', (plan: any) => {
            void openPlan(plan);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.downloadPlan', async (plan: PlanSelectionInput) => {
            try {
                const selectedPlans = uniquePlanItems(plan);
                if (selectedPlans.length === 0) {
                    vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                    return;
                }
                const sourcePlan = selectedPlans[0];
                const scopedPlanRef = resolvePlanRef(sourcePlan);
                if (!scopedPlanRef) {
                    vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                    return;
                }
                const { client, planRef } = resolvePlanClientAndRef(scopedPlanRef);
                const downloaded = await client.downloadPlanFile(planRef);
                const defaultName = sanitizeFileName(downloaded.filename.replace(/\.plan$/i, '') || sourcePlan.label || 'plan');
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
                const target = await vscode.window.showSaveDialog({
                    saveLabel: 'Download plan',
                    filters: { 'Plan files': ['plan'] },
                    defaultUri: workspaceFolder
                        ? vscode.Uri.joinPath(workspaceFolder, `${defaultName}.plan`)
                        : undefined,
                });
                if (!target) {
                    return;
                }
                await vscode.workspace.fs.writeFile(target, downloaded.content);
                vscode.window.showInformationMessage(`Downloaded ${defaultName}.plan`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to download plan: ${error instanceof Error ? error.message : String(error)}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.transferPlan', async (plan: PlanSelectionInput) => {
            try {
                await transferPlanToServer(plan);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to transfer plan: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.copyPlanUrl', async (plan: PlanSelectionInput, selections?: PlanSelectionInput[]) => {
            const selectedPlans = uniquePlanSelections(plan, selections);
            if (selectedPlans.length === 0) {
                vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                return;
            }

            const planUrls = selectedPlans.map((planRef) => `riotplan://plan/${planRef}`);
            await vscode.env.clipboard.writeText(planUrls.join('\n'));
            vscode.window.setStatusBarMessage(
                selectedPlans.length === 1 ? 'Copied plan URL to clipboard' : `Copied ${selectedPlans.length} plan URLs to clipboard`,
                2000
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.changePlanProject', async (plan: PlanSelectionInput, selections?: PlanSelectionInput[]) => {
            const selectedPlans = uniquePlanSelections(plan, selections);
            if (selectedPlans.length === 0) {
                vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                return;
            }

            const selected = await pickOrCreateProject({
                title: 'Change Project',
                placeHolder:
                    selectedPlans.length === 1
                        ? 'Select or create a project for this plan'
                        : `Select or create a project for ${selectedPlans.length} plans`,
            });
            if (!selected?.id) {
                return;
            }

            const bindingPayload = {
                id: selected.id,
                name: selected.name || selected.id,
                repo: selected.repo,
                relationship: 'primary',
            };

            const outcomes = await Promise.allSettled(
                selectedPlans.map(async (scopedPlanRef) => {
                    const { client, planRef } = resolvePlanClientAndRef(scopedPlanRef);
                    await client.bindProject(planRef, bindingPayload);
                    return scopedPlanRef;
                })
            );

            const updatedPlans = outcomes
                .filter((outcome): outcome is PromiseFulfilledResult<string> => outcome.status === 'fulfilled')
                .map((outcome) => outcome.value);
            const failures: string[] = [];
            outcomes.forEach((outcome, index) => {
                if (outcome.status === 'fulfilled') {
                    return;
                }
                const ref = selectedPlans[index] || 'unknown-plan';
                const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                failures.push(`${ref}: ${message}`);
            });
            const updated = updatedPlans.length;

            for (const planRef of updatedPlans) {
                PlanDetailPanel.applyProjectBindingUpdate(planRef, bindingPayload);
            }

            plansProvider.refresh();
            projectsProvider.refresh();

            if (updated > 0 && failures.length === 0) {
                vscode.window.showInformationMessage(
                    selectedPlans.length === 1
                        ? `Plan project changed to ${selected.name || selected.id}.`
                        : `${updated} plans changed to ${selected.name || selected.id}.`
                );
                return;
            }
            if (updated > 0 && failures.length > 0) {
                vscode.window.showWarningMessage(
                    `Updated ${updated} plan${updated === 1 ? '' : 's'}; ${failures.length} failed.`
                );
                console.error('Failed to update plan project bindings:', failures);
                return;
            }

            vscode.window.showErrorMessage('Failed to update project for selected plans.');
            console.error('Failed to update plan project bindings:', failures);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.renamePlan', async (plan: PlanSelectionInput, currentName?: string) => {
            const scopedPlanRef = resolvePlanRef(plan);
            if (!scopedPlanRef) {
                vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                return;
            }

            const initialValue = (typeof currentName === 'string' && currentName.trim())
                || (typeof plan?.label === 'string' && plan.label.trim())
                || scopedPlanRef;
            const nextName = await vscode.window.showInputBox({
                title: 'Rename Plan',
                prompt: 'Enter a new plan title',
                value: initialValue,
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || !value.trim()) {
                        return 'Plan title is required.';
                    }
                    if (value.trim().length > 120) {
                        return 'Plan title must be 120 characters or fewer.';
                    }
                    return undefined;
                },
            });
            if (nextName === undefined) {
                return;
            }
            const trimmedName = nextName.trim();
            if (!trimmedName) {
                return;
            }
            if (trimmedName === initialValue.trim()) {
                return;
            }

            try {
                const { client, planRef } = resolvePlanClientAndRef(scopedPlanRef);
                await client.renamePlan(planRef, trimmedName);
                PlanDetailPanel.applyPlanTitleUpdate(planRef, trimmedName);
                plansProvider.refresh();
                vscode.window.showInformationMessage(`Renamed plan to "${trimmedName}".`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to rename plan: ${message}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.deletePlan', async (plan: PlanSelectionInput, selections?: PlanSelectionInput[]) => {
            const selectedPlans = uniquePlanItems(plan, selections);
            if (selectedPlans.length === 0) {
                vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                return;
            }
            const planNames = selectedPlans
                .map((entry) => entry?.label || resolvePlanRef(entry) || 'unknown')
                .join(', ');
            const confirmation = await vscode.window.showWarningMessage(
                selectedPlans.length === 1
                    ? `Delete plan "${planNames}"? This cannot be undone.`
                    : `Delete ${selectedPlans.length} plans (${planNames})? This cannot be undone.`,
                { modal: true },
                'Delete',
                'Cancel'
            );
            if (confirmation !== 'Delete') {
                return;
            }
            let deleted = 0;
            const failures: string[] = [];
            for (const item of selectedPlans) {
                const scopedRef = resolvePlanRef(item);
                if (!scopedRef) {
                    continue;
                }
                const { client, planRef } = resolvePlanClientAndRef(scopedRef);
                try {
                    await client.deletePlan(planRef);
                    deleted += 1;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    failures.push(`${item?.label || planRef}: ${message}`);
                }
            }
            plansProvider.refresh();
            projectsProvider.refresh();
            if (failures.length > 0) {
                vscode.window.showErrorMessage(
                    `Deleted ${deleted}, failed ${failures.length}: ${failures.join('; ')}`
                );
            } else {
                vscode.window.showInformationMessage(
                    deleted === 1 ? 'Plan deleted.' : `${deleted} plans deleted.`
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.openPlanDetails', async (plan: PlanSelectionInput, selections?: PlanSelectionInput[]) => {
            const selectedItems = uniquePlanItems(plan, selections);
            if (selectedItems.length === 0) {
                vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                return;
            }
            for (const item of selectedItems) {
                await openPlan(item);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.openProjectEntity', async (source?: PlanSelectionInput, selections?: PlanSelectionInput[]) => {
            const sources = uniquePlanItems(source, selections);
            const targets = sources.length > 0 ? sources : [source];
            const opened = new Set<string>();
            let missing = 0;

            for (const target of targets) {
                const resolved = await resolveProjectFromSource(target);
                if (!resolved?.projectId) {
                    missing += 1;
                    continue;
                }
                if (opened.has(resolved.projectId)) {
                    continue;
                }
                opened.add(resolved.projectId);
                ProjectDetailPanel.createOrShow(resolved.projectId, mcpClient, resolved.project);
            }

            if (opened.size === 0) {
                vscode.window.showWarningMessage('No project is associated with the selected item(s).');
                return;
            }
            if (missing > 0) {
                vscode.window.showWarningMessage(
                    `Opened ${opened.size} project detail view${opened.size === 1 ? '' : 's'}; ${missing} item${missing === 1 ? '' : 's'} had no project mapping.`
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.openDashboard', () => {
            syncDashboardFilters();
            dashboardProvider.show();
        })
    );

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration('riotplan.serverProfiles') ||
                e.affectsConfiguration('riotplan.activeServerId') ||
                e.affectsConfiguration('riotplan.serverUrl') ||
                e.affectsConfiguration('riotplan.proxyBypass')
            ) {
                void reloadConnectionsFromProfiles();
            }
            if (e.affectsConfiguration('riotplan.debugAuthLogging')) {
                applyAuthDebugLogging();
            }
        })
    );

    // ── Async connection bootstrap (runs AFTER all commands are registered) ──
    // Failures here produce warnings but never prevent the extension from loading.
    try {
        const fallbackServerUrl = getLegacyServerUrl();
        const fallbackProxyBypass = getConfiguredProxyBypass();
        const { profiles, activeServerId } = await profilesStore.loadProfiles(fallbackServerUrl, fallbackProxyBypass);
        connectionManager.configureProfiles(profiles, activeServerId);
        await hydrateProfileApiKeys(context, profiles);
        await connectionManager.connectAll();
        applyAuthDebugLogging();
        aggregator = new MultiServerAggregator(connectionManager);

        const activeClient = connectionManager.getActiveClient();
        if (activeClient) {
            mcpClient = activeClient;
            currentServerUrl = mcpClient.baseUrl;
        }
        applyAuthDebugLogging();

        plansProvider.updateClient(aggregator as any);
        projectsProvider.updateClient(aggregator as any);
        statusProvider.updateClient(mcpClient, currentServerUrl);
        dashboardProvider.setClient(aggregator as any);
        syncDashboardFilters();
        plansProvider.refresh();
        projectsProvider.refresh();
        void refreshServerStatuses();
        void checkConnection(currentServerUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('RiotPlan activation connection setup failed:', message);
        vscode.window.showWarningMessage(`RiotPlan: server connection failed on startup. Use "Manage Servers and Tokens" to configure. (${message})`);
    }
}

function getConfiguredProxyBypass(): boolean {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folderUri) {
        const folderValue = vscode.workspace.getConfiguration('riotplan', folderUri).get<boolean>('proxyBypass');
        if (typeof folderValue === 'boolean') {
            return folderValue;
        }
    }
    return vscode.workspace.getConfiguration('riotplan').get<boolean>('proxyBypass', false);
}

async function openPlan(plan: PlanItem | any): Promise<void> {
    if (typeof plan === 'string' && plan.trim()) {
        const scopedRef = plan.trim();
        const { client, planRef } = resolvePlanClientAndRef(scopedRef);
        await maybeRemapTransferredPlan(scopedRef);
        PlanDetailPanel.createOrShow(planRef, planRef, client);
        return;
    }

    const scopedRef = resolvePlanRef(plan);
    const planName = plan?.label || plan?.name || plan?.title || plan?.code || scopedRef || 'Plan';
    if (!scopedRef || typeof scopedRef !== 'string') {
        return;
    }
    const { client, planRef } = resolvePlanClientAndRef(scopedRef);
    await maybeRemapTransferredPlan(scopedRef);
    PlanDetailPanel.createOrShow(planRef, planName, client, plan?.project);
}

function resolvePlanRef(plan: PlanItem | any): string | undefined {
    if (typeof plan === 'string' && plan.trim()) {
        return plan.trim();
    }
    const sqliteNameRef =
        typeof plan?.name === 'string' && /^[0-9a-f]{8}-/i.test(plan.name)
            ? plan.name
            : undefined;
    const ref = plan?.planId ?? plan?.id ?? sqliteNameRef ?? plan?.uuid ?? plan?.path;
    if (typeof ref === 'string' && ref.trim()) {
        return ref.trim();
    }
    return undefined;
}

function resolvePlanClientAndRef(scopedPlanRef: string): { client: HttpMcpClient; planRef: string } {
    const scoped = fromServerScopedRef(scopedPlanRef);
    if (!scoped) {
        return { client: mcpClient, planRef: scopedPlanRef };
    }
    const client = aggregator.getClientForServer(scoped.serverId) || mcpClient;
    return { client, planRef: scoped.value };
}

function uniquePlanItems(plan: PlanSelectionInput, selections?: PlanSelectionInput[]): PlanSelectionInput[] {
    const all = [plan, ...(Array.isArray(selections) ? selections : [])];
    const byRef = new Map<string, PlanSelectionInput>();

    for (const entry of all) {
        const planRef = resolvePlanRef(entry);
        if (!planRef) {
            continue;
        }
        if (!byRef.has(planRef)) {
            byRef.set(planRef, entry);
        }
    }

    return [...byRef.values()];
}

function uniquePlanSelections(plan: PlanSelectionInput, selections?: PlanSelectionInput[]): string[] {
    return uniquePlanItems(plan, selections)
        .map((entry) => resolvePlanRef(entry))
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function resolveProjectFromSource(
    source?: PlanSelectionInput
): Promise<{ project?: ContextProject; projectId?: string } | undefined> {
    let project = source?.project ? source.project : source;
    let projectId = typeof project?.id === 'string' ? project.id : undefined;

    if (!projectId) {
        const scopedPlanRef = resolvePlanRef(source);
        if (scopedPlanRef) {
            const { client, planRef } = resolvePlanClientAndRef(scopedPlanRef);
            const binding = await client.getProjectBinding(planRef).catch(() => null);
            project = binding?.project;
            projectId = typeof project?.id === 'string' ? project.id : undefined;
        }
    }

    if (!projectId) {
        return undefined;
    }

    return {
        project,
        projectId,
    };
}

async function checkConnection(serverUrl: string): Promise<void> {
    statusProvider.setConnectionState('checking');
    const result = await mcpClient.verifyRiotPlanServer();
    if (result.ok) {
        statusProvider.setConnectionState('connected');
    } else {
        statusProvider.setConnectionState('disconnected');
        if (result.reason === 'missing_riotplan_tools') {
            vscode.window.showWarningMessage(
                `Server at ${serverUrl} is reachable but does not appear to be a RiotPlan MCP server (missing riotplan_* tools). ` +
                `Check riotplan.serverUrl in settings.`
            );
        } else if (result.reason === 'unauthorized') {
            const action = await vscode.window.showWarningMessage(
                `RiotPlan server at ${serverUrl} rejected authentication (HTTP 401). Configure an API token for the active server.`,
                'Configure API token',
                'Manage Servers and Tokens'
            );
            if (action === 'Configure API token') {
                await vscode.commands.executeCommand('riotplan.configureApiKey');
            } else if (action === 'Manage Servers and Tokens') {
                await vscode.commands.executeCommand('riotplan.openServerManager');
            }
        } else {
            vscode.window.showWarningMessage(
                `RiotPlan server not available at ${serverUrl}. Please start the server and reload the window.`
            );
        }
    }
}

function remapDecisionStorageKey(planRef: string, signature: string): string {
    return `riotplan.remapDecision.${planRef}:${signature}`;
}

function bindingSignature(binding: any): string {
    const repo = binding?.project?.repo;
    if (repo?.provider && repo?.owner && repo?.name) {
        return `${String(repo.provider).toLowerCase()}:${String(repo.owner).toLowerCase()}/${String(repo.name).toLowerCase()}`;
    }
    if (binding?.project?.id) {
        return String(binding.project.id).toLowerCase();
    }
    return 'unresolved';
}

async function maybeRemapTransferredPlan(planRef: string): Promise<void> {
    try {
        const resolved = resolvePlanClientAndRef(planRef);
        const binding = await resolved.client.getProjectBinding(resolved.planRef);
        if (!binding || binding.source === 'explicit' || !binding.project) {
            return;
        }

        const projectContext = await resolved.client.resolveProjectContext(
            resolved.planRef,
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        );
        if (projectContext?.resolved) {
            return;
        }

        const signature = bindingSignature(binding);
        const decisionKey = remapDecisionStorageKey(planRef, signature);
        const priorDecision = extensionContextRef.workspaceState.get<string>(decisionKey);
        if (priorDecision) {
            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                { label: 'Map to existing project', value: 'map' },
                { label: 'Create new project', value: 'create' },
                { label: 'Skip', value: 'skip' },
            ],
            {
                title: 'Unresolved plan project',
                placeHolder: `Plan ${planRef} has no local project mapping. Choose an action.`,
            }
        );
        if (!choice || choice.value === 'skip') {
            await extensionContextRef.workspaceState.update(decisionKey, 'skip');
            return;
        }

        if (choice.value === 'map') {
            const selected = await pickOrCreateProject({
                title: 'Map plan to project',
                placeHolder: 'Select or create a project',
            });
            if (!selected?.id) {
                return;
            }
            await resolved.client.bindProject(resolved.planRef, {
                id: selected.id,
                name: selected.name || selected.id,
                repo: selected.repo,
                relationship: 'primary',
            });
            await extensionContextRef.workspaceState.update(decisionKey, 'mapped');
            plansProvider.refresh();
            projectsProvider.refresh();
            return;
        }

        const projectNameInput = await vscode.window.showInputBox({
            title: 'Create project for plan',
            prompt: 'Enter new project name',
            value: binding?.project?.name || binding?.project?.id || '',
        });
        if (!projectNameInput || !projectNameInput.trim()) {
            return;
        }
        const existingProjects = await resolved.client.listContextProjects(true).catch(() => []);
        const projectName = projectNameInput.trim();
        const projectId = makeProjectId(projectName, existingProjects);
        await resolved.client.createContextProject(buildDefaultProjectEntity(projectId, projectName));
        await resolved.client.bindProject(resolved.planRef, {
            id: projectId,
            name: projectName,
            repo: binding?.project?.repo,
            relationship: 'primary',
        });
        await extensionContextRef.workspaceState.update(decisionKey, 'created');
        plansProvider.refresh();
        projectsProvider.refresh();
    } catch (error) {
        console.error('Failed remap flow:', error);
    }
}

function sortedProjects(projects: ContextProject[]): ContextProject[] {
    return [...projects].sort((a, b) => {
        const left = String(a?.name || a?.id || '').toLowerCase();
        const right = String(b?.name || b?.id || '').toLowerCase();
        return left.localeCompare(right);
    });
}

function makeProjectId(name: string, existingProjects: ContextProject[]): string {
    void name;
    void existingProjects;
    return randomUUID();
}

function buildDefaultProjectEntity(id: string, name: string): Record<string, unknown> {
    return {
        id,
        name,
        type: 'project',
        active: true,
        classification: {
            context_type: 'work',
        },
        routing: {
            structure: 'none',
            filename_options: ['subject'],
        },
    };
}

async function createContextProjectFromName(name: string): Promise<ContextProject | undefined> {
    const trimmed = name.trim();
    if (!trimmed) {
        return undefined;
    }
    const existingProjects = await mcpClient.listContextProjects(true).catch(() => []);
    const matching = existingProjects.find((project: ContextProject) => {
        return String(project.name || '').toLowerCase() === trimmed.toLowerCase();
    });
    if (matching) {
        return matching;
    }
    const id = makeProjectId(trimmed, existingProjects);
    await mcpClient.createContextProject(buildDefaultProjectEntity(id, trimmed));
    return {
        id,
        name: trimmed,
        active: true,
    };
}

async function pickOrCreateProject(options: { title: string; placeHolder: string }): Promise<ContextProject | undefined> {
    const quickPick = vscode.window.createQuickPick<ProjectQuickPickItem>();
    quickPick.title = options.title;
    quickPick.placeholder = options.placeHolder;
    quickPick.matchOnDescription = true;
    quickPick.ignoreFocusOut = true;

    let allProjects: ContextProject[] = [];

    const refreshItems = (query: string) => {
        const trimmed = query.trim();
        const queryLower = trimmed.toLowerCase();
        const filtered = sortedProjects(allProjects).filter((project) => {
            if (!queryLower) {
                return true;
            }
            const id = String(project.id || '').toLowerCase();
            const name = String(project.name || '').toLowerCase();
            return id.includes(queryLower) || name.includes(queryLower);
        });

        const items: ProjectQuickPickItem[] = [];
        if (trimmed) {
            items.push({
                label: `$(add) Create new project "${trimmed}"`,
                description: 'Create and select this project',
                action: 'create',
                alwaysShow: true,
            });
        }
        for (const project of filtered) {
            items.push({
                label: String(project.name || project.id || 'Unnamed project'),
                description: String(project.id || ''),
                action: 'existing',
                project,
            });
        }
        quickPick.items = items;
    };

    const decision = new Promise<ContextProject | undefined>((resolve) => {
        let settled = false;
        let accepted = false;
        const settle = (value: ContextProject | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };

        const acceptDisposable = quickPick.onDidAccept(async () => {
            accepted = true;
            const selected = quickPick.selectedItems[0] || quickPick.activeItems[0];
            const fallbackName = quickPick.value.trim();
            if (!selected && !fallbackName) {
                settle(undefined);
                quickPick.hide();
                return;
            }
            if (selected?.action === 'existing') {
                settle(selected.project);
                quickPick.hide();
                return;
            }
            const created = await createContextProjectFromName(fallbackName || quickPick.value);
            settle(created);
            quickPick.hide();
        });

        const hideDisposable = quickPick.onDidHide(() => {
            acceptDisposable.dispose();
            hideDisposable.dispose();
            quickPick.dispose();
            if (!accepted) {
                settle(undefined);
            }
        });
    });

    quickPick.busy = true;
    allProjects = await mcpClient.listContextProjects(true).catch(() => []);
    quickPick.busy = false;
    refreshItems('');
    quickPick.onDidChangeValue((value) => refreshItems(value));
    quickPick.show();

    return decision;
}

async function readTransferFile(file: vscode.Uri): Promise<PlanTransferFile> {
    const bytes = await vscode.workspace.fs.readFile(file);
    const text = Buffer.from(bytes).toString('utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Invalid .plan file: not valid JSON.');
    }
    if (!isPlanTransferFile(parsed)) {
        throw new Error('Invalid .plan file: unsupported format.');
    }
    return parsed;
}

function isPlanTransferFile(value: unknown): value is PlanTransferFile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<PlanTransferFile>;
    return candidate.format === 'riotplan-transfer' && candidate.version === 1 && typeof candidate.plan === 'object';
}

async function importPlanFromTransfer(transfer: PlanTransferFile): Promise<void> {
    const code = sanitizePlanCode(transfer.plan.code || transfer.plan.name || '');
    if (!code) {
        throw new Error('Upload failed: plan file is missing a valid code or name.');
    }
    const description = (transfer.plan.description || transfer.plan.ideaContent || '').trim();
    if (!description) {
        throw new Error('Upload failed: plan file is missing description/idea content.');
    }

    const created = await mcpClient.createPlan({
        code,
        name: transfer.plan.name || undefined,
        description,
    });
    const createdPlanRef =
        resolvePlanRef(created) ||
        (typeof created?.planId === 'string' ? created.planId : undefined) ||
        (typeof created?.path === 'string' ? created.path : undefined) ||
        code;

    if (transfer.plan.ideaContent && transfer.plan.ideaContent.trim()) {
        await mcpClient.setIdeaContent(createdPlanRef, transfer.plan.ideaContent);
    }
    if (transfer.plan.category && transfer.plan.category !== 'active') {
        await mcpClient.movePlan(createdPlanRef, transfer.plan.category);
    }
    if (transfer.plan.project?.id) {
        await mcpClient.bindProject(createdPlanRef, {
            id: transfer.plan.project.id,
            name: transfer.plan.project.name || transfer.plan.project.id,
            repo: transfer.plan.project.repo,
            relationship: 'primary',
        });
    }
}

function sanitizeFileName(input: string): string {
    return input.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'plan';
}

function sanitizePlanCode(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

async function deletePlanBestEffort(client: HttpMcpClient, planRefOrPath: string): Promise<void> {
    const candidates = planDeleteCandidates(planRefOrPath);
    for (const id of candidates) {
        try {
            await client.deletePlan(id);
            return;
        } catch {
            // Try next candidate.
        }
    }
}

async function deletePlanWithReport(client: HttpMcpClient, planRefOrPath: string): Promise<string | undefined> {
    const candidates = planDeleteCandidates(planRefOrPath);
    let lastError: string | undefined;
    for (const id of candidates) {
        try {
            await client.deletePlan(id);
            return undefined;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    return lastError || `Could not delete plan: ${planRefOrPath}`;
}

function planDeleteCandidates(value: string): string[] {
    const trimmed = value.trim();
    const results: string[] = [trimmed];
    const parts = trimmed.split(/[\\/]+/).filter(Boolean);
    if (parts.length > 1) {
        results.push(parts[parts.length - 1]);
    }
    const uuidMatch = trimmed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (uuidMatch) {
        results.push(uuidMatch[1]);
    }
    return [...new Set(results)];
}


function tokenLast4(token: string): string {
    const trimmed = token.trim();
    if (!trimmed) {
        return 'none';
    }
    return trimmed.slice(-Math.min(4, trimmed.length));
}

async function hydrateProfileApiKeys(context: vscode.ExtensionContext, profiles: Array<{ id: string }>): Promise<void> {
    await Promise.all(profiles.map(async (profile) => {
        const secret = await context.secrets.get(tokenStorageKey(profile.id));
        connectionManager.setClientApiKey(profile.id, sanitizeToken(secret));
    }));
}

function getLegacyServerUrl(): string {
    const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folderUri) {
        const folderValue = vscode.workspace.getConfiguration('riotplan', folderUri).get<string>('serverUrl');
        if (typeof folderValue === 'string' && folderValue.trim()) {
            return folderValue.trim();
        }
    }
    const globalValue = vscode.workspace.getConfiguration('riotplan').get<string>('serverUrl', 'http://127.0.0.1:3002');
    return globalValue.trim() || 'http://127.0.0.1:3002';
}

export function deactivate() {
    console.log('RiotPlan extension is now deactivated');
}
