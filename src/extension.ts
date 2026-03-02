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
let plansProvider: PlansTreeProvider;
let projectsProvider: ProjectsTreeProvider;
let statusProvider: StatusTreeProvider;
let dashboardProvider: DashboardViewProvider;
let currentServerUrl = 'http://127.0.0.1:3001';
let extensionContextRef: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
    console.log('RiotPlan extension is now active');
    extensionContextRef = context;

    const config = vscode.workspace.getConfiguration('riotplan');
    currentServerUrl = config.get<string>('serverUrl', 'http://127.0.0.1:3001');

    mcpClient = new HttpMcpClient(currentServerUrl);
    plansProvider = new PlansTreeProvider(mcpClient);
    projectsProvider = new ProjectsTreeProvider(mcpClient);
    statusProvider = new StatusTreeProvider(mcpClient, currentServerUrl);
    dashboardProvider = new DashboardViewProvider(context.extensionUri);
    dashboardProvider.setClient(mcpClient);
    syncDashboardFilters();

    function syncDashboardFilters(): void {
        dashboardProvider.setFilters({
            projectFilter: plansProvider.getProjectFilter(),
            statuses: plansProvider.getStatusFilter(),
            sortOrder: plansProvider.getSortOrder(),
        });
    }

    function applyServerUrl(newUrl: string): void {
        currentServerUrl = newUrl;
        mcpClient = new HttpMcpClient(newUrl);
        plansProvider.updateClient(mcpClient);
        statusProvider.updateClient(mcpClient, newUrl);
        dashboardProvider.setClient(mcpClient);
        projectsProvider.updateClient(mcpClient);
        syncDashboardFilters();
        plansProvider.refresh();
        projectsProvider.refresh();
        void checkConnection(newUrl);
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

    // Check server health and update connection status
    checkConnection(currentServerUrl);

    // Register commands
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
                placeHolder: 'http://127.0.0.1:3001',
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
            // Apply immediately so the active session switches even before configuration events propagate.
            applyServerUrl(nextUrl);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('riotplan.reconnect', async () => {
            checkConnection(currentServerUrl);
            plansProvider.refresh();
            projectsProvider.refresh();
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
                const planRef = resolvePlanRef(sourcePlan);
                if (!planRef) {
                    vscode.window.showWarningMessage('Unable to determine plan reference for this item.');
                    return;
                }
                const downloaded = await mcpClient.downloadPlanFile(planRef);
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

            let updated = 0;
            const failures: string[] = [];
            for (const planRef of selectedPlans) {
                try {
                    await mcpClient.bindProject(planRef, {
                        id: selected.id,
                        name: selected.name || selected.id,
                        repo: selected.repo,
                        relationship: 'primary',
                    });
                    updated += 1;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    failures.push(`${planRef}: ${message}`);
                }
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
            if (e.affectsConfiguration('riotplan.serverUrl')) {
                const newUrl = vscode.workspace
                    .getConfiguration('riotplan')
                    .get<string>('serverUrl', 'http://127.0.0.1:3001');
                applyServerUrl(newUrl);
            }
        })
    );
}

async function openPlan(plan: PlanItem | any): Promise<void> {
    if (typeof plan === 'string' && plan.trim()) {
        const planRef = plan.trim();
        await maybeRemapTransferredPlan(planRef);
        PlanDetailPanel.createOrShow(planRef, planRef, mcpClient);
        return;
    }

    const planRef = resolvePlanRef(plan);
    const planName = plan?.label || plan?.name || plan?.title || plan?.code || planRef || 'Plan';
    if (!planRef || typeof planRef !== 'string') {
        return;
    }
    await maybeRemapTransferredPlan(planRef);
    PlanDetailPanel.createOrShow(planRef, planName, mcpClient, plan?.project);
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
        const planRef = resolvePlanRef(source);
        if (planRef) {
            const binding = await mcpClient.getProjectBinding(planRef).catch(() => null);
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
        const binding = await mcpClient.getProjectBinding(planRef);
        if (!binding || binding.source === 'explicit' || !binding.project) {
            return;
        }

        const resolved = await mcpClient.resolveProjectContext(planRef, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        if (resolved?.resolved) {
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
            await mcpClient.bindProject(planRef, {
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
        const existingProjects = await mcpClient.listContextProjects(true).catch(() => []);
        const projectName = projectNameInput.trim();
        const projectId = makeProjectId(projectName, existingProjects);
        await mcpClient.createContextProject(buildDefaultProjectEntity(projectId, projectName));
        await mcpClient.bindProject(planRef, {
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

async function buildTransferFile(sourcePlan: PlanSelectionInput): Promise<PlanTransferFile> {
    const planRef = resolvePlanRef(sourcePlan);
    if (!planRef) {
        throw new Error('Unable to resolve selected plan.');
    }

    const [planData, ideaArtifact] = await Promise.all([
        mcpClient.getPlanResource(planRef),
        mcpClient.getArtifact(planRef, 'idea').catch(() => ({ content: null })),
    ]);

    const code = firstNonEmptyString(planData?.code, planData?.id, sourcePlan?.label, planRef);
    const name = firstNonEmptyString(planData?.name, planData?.title, sourcePlan?.label);
    const description = firstNonEmptyString(planData?.description, planData?.summary);
    const category = normalizeCategory(sourcePlan?.category, planData?.category);

    return {
        format: 'riotplan-transfer',
        version: 1,
        exportedAt: new Date().toISOString(),
        source: {
            serverUrl: currentServerUrl,
            planRef,
        },
        plan: {
            code,
            name,
            description,
            category,
            stage: firstNonEmptyString(sourcePlan?.stage, planData?.stage),
            project: sourcePlan?.project || planData?.project,
            ideaContent: typeof ideaArtifact?.content === 'string' ? ideaArtifact.content : null,
        },
    };
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function normalizeCategory(...values: unknown[]): PlanCategory {
    for (const value of values) {
        if (value === 'active' || value === 'done' || value === 'hold') {
            return value;
        }
    }
    return 'active';
}

export function deactivate() {
    console.log('RiotPlan extension is now deactivated');
}
