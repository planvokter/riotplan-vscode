/**
 * Plan Detail Panel
 *
 * A rich webview panel for viewing a RiotPlan plan with tabs for
 * Overview (IDEA), Steps, Evidence, and History.
 */

import * as vscode from 'vscode';
import { HttpMcpClient } from './mcp-client';

export class PlanDetailPanel {
    public static readonly viewType = 'riotplanDetail';
    public static currentPanels = new Map<string, PlanDetailPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly resourceUri: string;
    private mcpClient: HttpMcpClient;
    private unsubscribeNotification?: () => void;
    private unsubscribeSessionRecovered?: () => void;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private projectMetaRefreshTimer?: ReturnType<typeof setTimeout>;
    private readonly subscribedResourceUris = new Set<string>();

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly planPath: string,
        mcpClient: HttpMcpClient,
        private readonly initialProject?: any
    ) {
        this._panel = panel;
        this.mcpClient = mcpClient;
        this.resourceUri = `riotplan://plan/${this.planPath}`;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            (msg) => this._handleMessage(msg),
            null,
            this._disposables
        );
        this.bindClientSubscriptions();
        this._loadContent();
    }

    static updateClientForAll(mcpClient: HttpMcpClient): void {
        for (const panel of PlanDetailPanel.currentPanels.values()) {
            panel.updateClient(mcpClient);
        }
    }

    static applyProjectBindingUpdate(planPath: string, project: any): void {
        const panel = PlanDetailPanel.currentPanels.get(planPath);
        if (!panel) {
            return;
        }
        panel.postProjectMetaUpdate(project || null);
    }

    static applyPlanTitleUpdate(planPath: string, title: string): void {
        const panel = PlanDetailPanel.currentPanels.get(planPath);
        if (!panel) {
            return;
        }
        panel._panel.title = title;
        panel._panel.webview.postMessage({
            command: 'planTitleUpdated',
            title,
        });
    }

    static scheduleRefreshForAllOpenPanels(): void {
        for (const panel of PlanDetailPanel.currentPanels.values()) {
            panel.scheduleRefresh();
        }
    }

    private bindClientSubscriptions(): void {
        this.unsubscribeNotification = this.mcpClient.onNotification(
            'notifications/resource_changed',
            async (data: unknown) => {
                const uris = this.extractNotificationUris(data);
                const matchingUris = uris.filter((uri) => this.resourceMatchesPlan(uri));
                if (matchingUris.length === 0) {
                    return;
                }
                if (matchingUris.every((uri) => this.isExactPlanResourceUri(uri))) {
                    this.scheduleProjectMetaRefresh();
                    return;
                }
                this.scheduleRefresh();
            }
        );
        this.unsubscribeSessionRecovered = this.mcpClient.onSessionRecovered(async () => {
            await this.subscribeToPlanResources();
        });
        void this.subscribeToPlanResources();
    }

    private updateClient(mcpClient: HttpMcpClient): void {
        if (this.mcpClient === mcpClient) {
            return;
        }
        this.unsubscribeNotification?.();
        this.unsubscribeNotification = undefined;
        this.unsubscribeSessionRecovered?.();
        this.unsubscribeSessionRecovered = undefined;
        for (const uri of this.subscribedResourceUris) {
            void this.mcpClient.unsubscribeFromResource(uri).catch(() => undefined);
        }
        this.subscribedResourceUris.clear();
        this.mcpClient = mcpClient;
        this.bindClientSubscriptions();
        this.scheduleRefresh();
    }

    static createOrShow(
        planPath: string,
        planName: string,
        mcpClient: HttpMcpClient,
        initialProject?: any
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        const existing = PlanDetailPanel.currentPanels.get(planPath);
        if (existing) {
            existing.updateClient(mcpClient);
            existing._panel.reveal(column);
            existing._panel.title = planName;
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            PlanDetailPanel.viewType,
            planName,
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        PlanDetailPanel.currentPanels.set(
            planPath,
            new PlanDetailPanel(panel, planPath, mcpClient, initialProject)
        );
    }

    private async _handleMessage(msg: any): Promise<void> {
        switch (msg.command) {
            case 'refresh':
                await this._loadContent();
                break;
            case 'saveIdeaContent':
                await this._saveIdeaContent(msg.content);
                break;
            case 'getStepContent':
                await this._sendStepContent(msg.stepNumber);
                break;
            case 'getEvidenceContent':
                await this._sendEvidenceContent(msg.filename);
                break;
            case 'saveEvidenceContent':
                await this._saveEvidenceContent(msg.filename, msg.content);
                break;
            case 'addEvidence':
                await this._addEvidence(msg.description, msg.source, msg.summary, msg.content);
                break;
            case 'removeEvidence':
                await this._removeEvidence(msg.filename, msg.filenames, msg.idx);
                break;
            case 'copyPlanId':
                await this._copyPlanIdToClipboard();
                break;
            case 'copyEvidenceUrl':
                await this._copyEvidenceUrlToClipboard(msg.filename, msg.idx, msg.filenames);
                break;
            case 'copyEvidenceContent':
                await this._copyEvidenceContentToClipboard(
                    msg.filename,
                    msg.content,
                    msg.idx,
                    msg.filenames,
                    msg.contentsByFilename
                );
                break;
            case 'openProjectEntity':
                await this._openProjectEntity(msg.project);
                break;
            case 'changePlanProject':
                await this._changePlanProject();
                break;
            case 'renamePlan':
                await this._renamePlan(msg.currentTitle);
                break;
        }
    }

    private async _loadContent(): Promise<void> {
        this._panel.webview.html = this._getLoadingHtml();

        try {
            const [status, context, planResource, projectBinding, summaryArtifact, executionPlanArtifact, steps] = await Promise.all([
                this.mcpClient.getPlanStatus(this.planPath),
                this.mcpClient.readContext(this.planPath).catch(() => null),
                this.mcpClient.getPlanResource(this.planPath).catch(() => null),
                this.mcpClient.getProjectBinding(this.planPath).catch(() => null),
                this.mcpClient.getArtifact(this.planPath, 'summary').catch(() => null),
                this.mcpClient.getExecutionPlan(this.planPath).catch(() => null),
                this.mcpClient.listSteps(this.planPath).catch(() => []),
            ]);

            const enrichedContext = {
                ...context,
                summary: summaryArtifact,
                executionPlan: executionPlanArtifact,
            };

            const statusWithSteps = {
                ...(status || {}),
                steps: Array.isArray(steps) ? steps : [],
            };

            const boundProject = projectBinding?.project || null;
            const effectivePlanResource = {
                ...(planResource || {}),
                project: boundProject || planResource?.project || this.initialProject || null,
            };

            this._panel.webview.html = this._getHtml(statusWithSteps, enrichedContext, effectivePlanResource);
        } catch (error) {
            this._panel.webview.html = this._getErrorHtml(String(error));
        }
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this._loadContent();
        }, 250);
    }

    private scheduleProjectMetaRefresh(): void {
        if (this.projectMetaRefreshTimer) {
            clearTimeout(this.projectMetaRefreshTimer);
        }
        this.projectMetaRefreshTimer = setTimeout(() => {
            this.projectMetaRefreshTimer = undefined;
            void this.refreshProjectMetadata();
        }, 180);
    }

    private async refreshProjectMetadata(): Promise<void> {
        try {
            const [planResource, projectBinding] = await Promise.all([
                this.mcpClient.getPlanResource(this.planPath).catch(() => null),
                this.mcpClient.getProjectBinding(this.planPath).catch(() => null),
            ]);
            const project = projectBinding?.project || planResource?.project || this.initialProject || null;
            const projectPath =
                typeof planResource?.metadata?.projectPath === 'string'
                    ? planResource.metadata.projectPath
                    : '';
            const repoUrl =
                typeof project?.repo?.url === 'string'
                    ? project.repo.url
                    : '';
            this.postProjectMetaUpdate(project, projectPath, repoUrl);
        } catch {
            // Ignore metadata refresh errors to avoid interrupting the panel.
        }
    }

    private getPlanResourceUris(): string[] {
        return [
            `riotplan://plan/${this.planPath}`,
            `riotplan://status/${this.planPath}`,
            `riotplan://steps/${this.planPath}`,
            `riotplan://history/${this.planPath}`,
            `riotplan://shaping/${this.planPath}`,
            `riotplan://artifact/${this.planPath}?type=summary`,
            `riotplan://artifact/${this.planPath}?type=execution_plan`,
        ];
    }

    private async subscribeToPlanResources(): Promise<void> {
        const uris = this.getPlanResourceUris();
        for (const uri of uris) {
            try {
                await this.mcpClient.subscribeToResource(uri);
                this.subscribedResourceUris.add(uri);
            } catch {
                // Continue without hard-failing the panel if a specific subscription is unavailable.
            }
        }
    }

    private extractNotificationUris(data: unknown): string[] {
        const params = data as {
            uri?: unknown;
            resource?: { uri?: unknown };
            resources?: Array<{ uri?: unknown }>;
            uris?: unknown[];
        };
        const values: unknown[] = [
            params?.uri,
            params?.resource?.uri,
            ...(Array.isArray(params?.resources) ? params.resources.map((resource) => resource?.uri) : []),
            ...(Array.isArray(params?.uris) ? params.uris : []),
        ];
        return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
    }

    private resourceMatchesPlan(uri: string): boolean {
        const normalizedPlanPath = this.planPath.toLowerCase();
        const encodedPlanPath = encodeURIComponent(this.planPath).toLowerCase();
        const candidates = [uri];

        try {
            candidates.push(decodeURIComponent(uri));
        } catch {
            // Ignore malformed URI encoding and just use original URI.
        }

        return candidates.some((candidate) => {
            const normalized = candidate.toLowerCase();
            return (
                normalized === this.resourceUri.toLowerCase() ||
                normalized.includes(normalizedPlanPath) ||
                normalized.includes(encodedPlanPath)
            );
        });
    }

    private isExactPlanResourceUri(uri: string): boolean {
        const target = this.resourceUri.toLowerCase();
        const candidates = [uri];
        try {
            candidates.push(decodeURIComponent(uri));
        } catch {
            // Ignore malformed URI encoding and just use original URI.
        }
        return candidates.some((candidate) => candidate.toLowerCase() === target);
    }

    private postProjectMetaUpdate(project: any, projectPath = '', repoUrl = ''): void {
        this._panel.webview.postMessage({
            command: 'projectMetaUpdated',
            project,
            projectPath,
            repoUrl,
        });
    }

    private async _saveIdeaContent(content: string): Promise<void> {
        try {
            await this.mcpClient.setIdeaContent(this.planPath, content);
            await this._loadContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save idea: ${error}`);
            this._panel.webview.postMessage({ command: 'saveError', error: String(error) });
        }
    }

    private async _sendStepContent(stepNumber: number): Promise<void> {
        try {
            const content = await this.mcpClient.getStepContent(this.planPath, stepNumber);
            this._panel.webview.postMessage({ command: 'stepContent', stepNumber, content });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'stepContent',
                stepNumber,
                content: `*Failed to load step content: ${error}*`,
            });
        }
    }

    private async _sendEvidenceContent(filename: string): Promise<void> {
        try {
            const content = await this.mcpClient.getEvidenceContent(this.planPath, filename);
            this._panel.webview.postMessage({ command: 'evidenceContent', filename, content });
        } catch (error) {
            this._panel.webview.postMessage({
                command: 'evidenceContent',
                filename,
                content: `# ${filename}\n\n*Failed to load: ${error}*`,
            });
        }
    }

    private async _saveEvidenceContent(filename: string, content: string): Promise<void> {
        void filename;
        void content;
        vscode.window.showWarningMessage(
            'Editing existing evidence files is not yet supported in service-only mode. Add a new evidence item instead.'
        );
        this._panel.webview.postMessage({
            command: 'saveError',
            error: 'Editing existing evidence is not supported in service-only mode yet.',
        });
    }

    private async _addEvidence(
        description: string,
        source: string,
        summary: string,
        evidenceContent: string
    ): Promise<void> {
        try {
            await this.mcpClient.addEvidence(this.planPath, description, source, summary, evidenceContent);
            await this._loadContent();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add evidence: ${error}`);
            this._panel.webview.postMessage({ command: 'saveError', error: String(error) });
        }
    }

    private async _removeEvidence(filename?: string, filenames?: string[], idx?: number): Promise<void> {
        try {
            const resolvedFilenames = this._resolveEvidenceFilenames(filename, filenames);
            if (resolvedFilenames.length === 0) {
                throw new Error('Missing evidence filename');
            }
            const itemCount = resolvedFilenames.length;
            const confirmationMessage = itemCount === 1
                ? 'Remove this evidence entry? This cannot be undone.'
                : `Remove ${itemCount} evidence entries? This cannot be undone.`;
            const confirmation = await vscode.window.showWarningMessage(
                confirmationMessage,
                { modal: true },
                'Remove Evidence'
            );
            if (confirmation !== 'Remove Evidence') {
                this._panel.webview.postMessage({ command: 'removeEvidenceResult', ok: false, cancelled: true, idx });
                return;
            }
            this._panel.webview.postMessage({
                command: 'evidenceRemovalPending',
                pending: true,
                filenames: resolvedFilenames,
            });

            const removed: string[] = [];
            const failures: string[] = [];

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: itemCount === 1 ? 'Removing evidence…' : `Removing ${itemCount} evidence entries…`,
                    cancellable: false,
                },
                async (progress) => {
                    const maxParallel = Math.min(3, itemCount);
                    let completed = 0;
                    let nextIndex = 0;
                    const incrementPerItem = 100 / itemCount;

                    const runWorker = async (): Promise<void> => {
                        while (nextIndex < itemCount) {
                            const currentIndex = nextIndex;
                            nextIndex += 1;
                            const currentFilename = resolvedFilenames[currentIndex];
                            try {
                                await this.mcpClient.removeEvidence(this.planPath, currentFilename);
                                removed.push(currentFilename);
                            } catch (error) {
                                failures.push(String(error));
                            }
                            completed += 1;
                            progress.report({
                                increment: incrementPerItem,
                                message: `${completed}/${itemCount}`,
                            });
                        }
                    };

                    await Promise.all(
                        Array.from({ length: maxParallel }, async () => runWorker())
                    );
                    if (completed < itemCount) {
                        progress.report({ increment: 100, message: `${itemCount}/${itemCount}` });
                    }
                }
            );

            if (removed.length > 0) {
                this._panel.webview.postMessage({
                    command: 'removeEvidenceResult',
                    ok: true,
                    idx,
                    removed,
                });
            }

            if (failures.length > 0) {
                const firstFailure = failures[0];
                const failureMessage =
                    failures.length === 1
                        ? firstFailure
                        : `${failures.length} evidence removals failed; first error: ${firstFailure}`;
                if (removed.length === 0) {
                    this._panel.webview.postMessage({ command: 'removeEvidenceResult', ok: false, idx });
                    throw new Error(failureMessage);
                }
                vscode.window.showWarningMessage(
                    `Some evidence could not be removed (${failures.length}/${itemCount}). ${failureMessage}`
                );
            }

            vscode.window.setStatusBarMessage(
                itemCount === 1
                    ? 'Removed evidence item'
                    : `Removed ${removed.length} evidence items`,
                2500
            );
        } catch (error) {
            this._panel.webview.postMessage({ command: 'removeEvidenceResult', ok: false, idx });
            vscode.window.showErrorMessage(`Failed to remove evidence: ${error}`);
        } finally {
            this._panel.webview.postMessage({
                command: 'evidenceRemovalPending',
                pending: false,
            });
        }
    }

    private async _copyPlanIdToClipboard(): Promise<void> {
        try {
            await vscode.env.clipboard.writeText(this.planPath);
            vscode.window.setStatusBarMessage('Copied plan ID to clipboard', 2000);
            this._panel.webview.postMessage({ command: 'copyPlanIdResult', ok: true });
        } catch (error) {
            this._panel.webview.postMessage({ command: 'copyPlanIdResult', ok: false });
            vscode.window.showErrorMessage(`Failed to copy plan ID: ${error}`);
        }
    }

    private _resolveEvidenceFilenames(
        filename?: string,
        filenames?: string[]
    ): string[] {
        const raw = Array.isArray(filenames) && filenames.length > 0
            ? filenames
            : (typeof filename === 'string' ? [filename] : []);
        const deduped = new Set<string>();
        for (const name of raw) {
            if (typeof name !== 'string') {
                continue;
            }
            const trimmed = name.trim();
            if (!trimmed) {
                continue;
            }
            deduped.add(trimmed);
        }
        return Array.from(deduped);
    }

    private async _copyEvidenceUrlToClipboard(
        filename?: string,
        idx?: number,
        filenames?: string[]
    ): Promise<void> {
        try {
            const resolvedFilenames = this._resolveEvidenceFilenames(filename, filenames);
            if (resolvedFilenames.length === 0) {
                throw new Error('Missing evidence filename');
            }
            const evidenceUrls = resolvedFilenames
                .map((name) => `riotplan://evidence-file/${this.planPath}?file=${encodeURIComponent(name)}`)
                .join('\n');
            await vscode.env.clipboard.writeText(evidenceUrls);
            const itemCount = resolvedFilenames.length;
            vscode.window.setStatusBarMessage(
                itemCount === 1
                    ? 'Copied evidence URL to clipboard'
                    : `Copied ${itemCount} evidence URLs to clipboard`,
                2000
            );
            this._panel.webview.postMessage({
                command: 'copyEvidenceResult',
                ok: true,
                kind: 'url',
                idx,
            });
        } catch (error) {
            this._panel.webview.postMessage({ command: 'copyEvidenceResult', ok: false, kind: 'url', idx });
            vscode.window.showErrorMessage(`Failed to copy evidence URL: ${error}`);
        }
    }

    private async _copyEvidenceContentToClipboard(
        filename?: string,
        content?: string,
        idx?: number,
        filenames?: string[],
        contentsByFilename?: Record<string, string>
    ): Promise<void> {
        try {
            const resolvedFilenames = this._resolveEvidenceFilenames(filename, filenames);
            if (resolvedFilenames.length === 0) {
                throw new Error('Missing evidence filename');
            }
            const normalizedContentsByFilename =
                contentsByFilename && typeof contentsByFilename === 'object'
                    ? contentsByFilename
                    : {};

            const collected: string[] = [];
            for (const currentFilename of resolvedFilenames) {
                const hasInlineSingleContent =
                    resolvedFilenames.length === 1 &&
                    typeof content === 'string' &&
                    content.length > 0;
                const inlineContent = hasInlineSingleContent
                    ? content
                    : normalizedContentsByFilename[currentFilename];
                const text =
                    typeof inlineContent === 'string' && inlineContent.length > 0
                        ? inlineContent
                        : await this.mcpClient.getEvidenceContent(this.planPath, currentFilename);
                if (resolvedFilenames.length > 1) {
                    collected.push(`# ${currentFilename}\n\n${text || ''}`);
                } else {
                    collected.push(text || '');
                }
            }

            const clipboardText = resolvedFilenames.length > 1
                ? collected.join('\n\n---\n\n')
                : (collected[0] || '');

            await vscode.env.clipboard.writeText(clipboardText);
            const itemCount = resolvedFilenames.length;
            vscode.window.setStatusBarMessage(
                itemCount === 1
                    ? 'Copied evidence content to clipboard'
                    : `Copied ${itemCount} evidence contents to clipboard`,
                2000
            );
            this._panel.webview.postMessage({ command: 'copyEvidenceResult', ok: true, kind: 'content', idx });
        } catch (error) {
            this._panel.webview.postMessage({ command: 'copyEvidenceResult', ok: false, kind: 'content', idx });
            vscode.window.showErrorMessage(`Failed to copy evidence content: ${error}`);
        }
    }

    private async _openProjectEntity(project?: any): Promise<void> {
        const projectId = typeof project?.id === 'string' ? project.id : undefined;
        if (!projectId) {
            vscode.window.showWarningMessage('This plan is not currently mapped to a project entity.');
            return;
        }
        await vscode.commands.executeCommand('riotplan.openProjectEntity', project);
    }

    private async _changePlanProject(): Promise<void> {
        await vscode.commands.executeCommand('riotplan.changePlanProject', this.planPath);
    }

    private async _renamePlan(currentTitle?: string): Promise<void> {
        const title = typeof currentTitle === 'string' ? currentTitle.trim() : '';
        await vscode.commands.executeCommand('riotplan.renamePlan', this.planPath, title);
    }

    private dispose(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        if (this.projectMetaRefreshTimer) {
            clearTimeout(this.projectMetaRefreshTimer);
            this.projectMetaRefreshTimer = undefined;
        }
        this.unsubscribeNotification?.();
        this.unsubscribeNotification = undefined;
        this.unsubscribeSessionRecovered?.();
        this.unsubscribeSessionRecovered = undefined;
        for (const uri of this.subscribedResourceUris) {
            void this.mcpClient.unsubscribeFromResource(uri).catch(() => undefined);
        }
        this.subscribedResourceUris.clear();
        PlanDetailPanel.currentPanels.delete(this.planPath);
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    private _esc(s: string): string {
        if (typeof s !== 'string') { return ''; }
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
         font-family: var(--vscode-font-family); display: flex; align-items: center;
         justify-content: center; height: 100vh; margin: 0; }
  .loading { display: flex; flex-direction: column; align-items: center; gap: 12px;
             color: var(--vscode-descriptionForeground); }
  .dot-pulse { display: flex; gap: 6px; }
  .dot-pulse span { width: 8px; height: 8px; border-radius: 50%;
                    background: var(--vscode-progressBar-background);
                    animation: pulse 1.2s infinite; }
  .dot-pulse span:nth-child(2) { animation-delay: 0.2s; }
  .dot-pulse span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
                     40% { opacity: 1; transform: scale(1); } }
</style>
</head><body>
<div class="loading">
  <div class="dot-pulse"><span></span><span></span><span></span></div>
  <span>Loading plan…</span>
</div>
</body></html>`;
    }

    private _getErrorHtml(error: string): string {
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
         font-family: var(--vscode-font-family); padding: 24px; margin: 0; }
  .err { color: var(--vscode-errorForeground); padding: 16px;
         border: 1px solid var(--vscode-inputValidation-errorBorder);
         border-radius: 6px; font-size: 13px; }
</style>
</head><body>
<div class="err">Failed to load plan: ${this._esc(error)}</div>
</body></html>`;
    }

    private _getHtml(status: any, context: any, planResource: any): string {
        const name = this._esc(status?.name || status?.code || 'Unknown Plan');
        const code = this._esc(status?.code || '');
        const planStatus = status?.status || context?.stage || 'unknown';
        const stage = context?.stage || planStatus;
        const progress = status?.progress ?? { completed: 0, total: 0, percentage: 0 };
        const steps = (status?.steps || []) as Array<{
            number: number; title: string; status: string; startedAt?: string; completedAt?: string;
        }>;
        const lastUpdated = status?.lastUpdated
            ? new Date(status.lastUpdated).toLocaleString() : '';
        const projectPath = this._esc(planResource?.metadata?.projectPath || '');
        const project = planResource?.project || this.initialProject || null;
        const projectName = this._esc(project?.name || project?.id || '');
        const repoUrlRaw = project?.repo?.url || '';
        const repoUrl = this._esc(repoUrlRaw);

        // Context data
        const ideaContent = context?.idea?.content || '';
        const shapingContent = context?.shaping?.content || '';
        const selectedApproach = context?.shaping?.selectedApproach || '';
        const summaryContent = context?.summary?.content || '';
        const executionPlanContent = context?.executionPlan?.content || '';
        const constraints = (context?.constraints || []) as string[];
        const questions = (context?.questions || []) as string[];
        const evidenceFiles = (context?.evidence?.files || []) as Array<{
            name: string; title?: string; preview: string; size: number; createdAt?: string;
        }>;
        const historyEvents = (context?.history?.recentEvents || []) as Array<{
            type: string; timestamp: string; summary: string;
        }>;

        // Stage/status colors
        const stagePalette: Record<string, { bg: string; text: string }> = {
            idea:        { bg: '#1a3a5c', text: '#4fc3f7' },
            shaping:     { bg: '#3a1a5c', text: '#ce93d8' },
            built:       { bg: '#3a2a0a', text: '#ffb74d' },
            executing:   { bg: '#3a3a0a', text: '#fff176' },
            completed:   { bg: '#0a3a1a', text: '#81c784' },
            cancelled:   { bg: '#3a0a0a', text: '#e57373' },
            in_progress: { bg: '#1a3a5c', text: '#4fc3f7' },
            pending:     { bg: '#2a2a2a', text: '#9e9e9e' },
            unknown:     { bg: '#2a2a2a', text: '#9e9e9e' },
        };
        const stagePal = stagePalette[stage] ?? stagePalette['unknown'];
        const statusPal = stagePalette[planStatus] ?? stagePalette['unknown'];

        // Progress bar
        const pct = Math.min(100, Math.max(0, progress.percentage || 0));

        // Steps HTML — clickable rows with expansion
        const stepsHtml = steps.length === 0
            ? `<div class="empty-state"><span class="empty-icon">○</span><p>No steps defined for this plan</p></div>`
            : steps.map(step => {
                const isDone = step.status === 'completed';
                const isActive = step.status === 'in_progress';
                const pal = isDone ? stagePalette['completed'] : isActive ? stagePalette['executing'] : stagePalette['pending'];
                const icon = isDone ? '✓' : isActive ? '▶' : '○';
                const rawTitle = (step.title || '').replace(/^Step\s+\d+:\s*/i, '');
                const dateStr = isDone && step.completedAt
                    ? new Date(step.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    : isActive && step.startedAt
                        ? `Started ${new Date(step.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                        : '';
                return `<div class="step-row ${isDone ? 'done' : isActive ? 'active' : ''}" data-step="${step.number}" onclick="toggleStep(${step.number})">
  <div class="step-indicator" style="color:${pal.text};border-color:${pal.text}20;background:${pal.bg}">${icon}</div>
  <div class="step-body">
    <span class="step-num">${step.number}</span>
    <span class="step-title${isDone ? ' struck' : ''}">${this._esc(rawTitle)}</span>
    ${dateStr ? `<span class="step-date">${this._esc(dateStr)}</span>` : ''}
  </div>
  <span class="step-chevron" id="step-chevron-${step.number}">›</span>
</div>
<div class="step-content-area" id="step-content-${step.number}">
  <div class="step-content-loading" id="step-loading-${step.number}">
    <span class="spinner-text">Loading…</span>
  </div>
  <div class="step-content-body md-content" id="step-body-${step.number}"></div>
</div>`;
            }).join('');

        // Evidence HTML — step-like list + detail pane
        const evidenceHtml = evidenceFiles.length === 0
            ? `<div class="empty-state"><span class="empty-icon">◫</span><p>No evidence files attached</p></div>`
            : evidenceFiles.map((e, idx) => {
                const addedDate = e.createdAt ? new Date(e.createdAt) : null;
                const addedLabel = addedDate && !Number.isNaN(addedDate.getTime())
                    ? `Added ${addedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
                    : 'Added date unknown';
                return `<div class="evidence-row" role="button" tabindex="0" data-evidence-idx="${idx}" onclick="selectEvidence(${idx}, event)">
  <span class="evidence-row-icon">◫</span>
  <span class="evidence-row-body">
    <span class="evidence-row-name">${this._esc(e.title || e.name)}</span>
    <span class="evidence-row-id">ID: ${this._esc(e.name)}</span>
    <span class="evidence-row-meta">${this._esc(addedLabel)}</span>
  </span>
  ${e.size ? `<span class="evidence-row-size">${(e.size / 1024).toFixed(1)} kb</span>` : ''}
  <button class="evidence-row-action" id="evidence-copy-url-${idx}" onclick="copyEvidenceUrl(${idx}, event)" title="Copy Evidence URL">⧉</button>
</div>`;
            }).join('');

        // History HTML
        const historyHtml = historyEvents.length === 0
            ? `<div class="empty-state"><span class="empty-icon">◷</span><p>No history events</p></div>`
            : historyEvents.map(e => {
                const timeStr = e.timestamp
                    ? new Date(e.timestamp).toLocaleString(undefined, {
                        month: 'short', day: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                    }) : '';
                const typeColor = e.type?.includes('complete') ? '#81c784'
                    : e.type?.includes('start') ? '#4fc3f7'
                        : e.type?.includes('error') || e.type?.includes('fail') ? '#e57373'
                            : '#9e9e9e';
                return `<div class="history-row">
  <div class="history-dot" style="background:${typeColor}"></div>
  <div class="history-body">
    <span class="history-type" style="color:${typeColor}">${this._esc(e.type || '')}</span>
    <span class="history-summary">${this._esc(e.summary || '')}</span>
  </div>
  <span class="history-time">${this._esc(timeStr)}</span>
</div>`;
            }).join('');

        // Tab labels
        const stepTab = `Steps${steps.length > 0 ? ` (${progress.completed}/${progress.total})` : ''}`;
        const evidTab = `Evidence${evidenceFiles.length > 0 ? ` (${evidenceFiles.length})` : ''}`;
        const histTab = `History${historyEvents.length > 0 ? ` (${historyEvents.length})` : ''}`;

        // Constraints & questions for overview tab
        const constraintsBlock = constraints.length > 0
            ? `<div class="meta-section"><h3 class="meta-section-title">⚑ Constraints</h3><ul class="bullet-list">${constraints.map(c => `<li>${this._esc(c)}</li>`).join('')}</ul></div>`
            : '';
        const questionsBlock = questions.length > 0
            ? `<div class="meta-section"><h3 class="meta-section-title">? Open Questions</h3><ul class="bullet-list">${questions.map(q => `<li>${this._esc(q)}</li>`).join('')}</ul></div>`
            : '';
        const shapingBlock = shapingContent
            ? `<div class="meta-section">${selectedApproach ? `<h3 class="meta-section-title">✦ Selected Approach: ${this._esc(selectedApproach)}</h3>` : `<h3 class="meta-section-title">✦ Shaping</h3>`}<div class="shaping-content md-content" id="shaping-md"></div></div>`
            : '';

        // Embed content as JSON for the webview JS to render.
        // Escape </ to prevent </script> in content from closing the script tag early.
        const escapeScript = (s: string) => s.replace(/<\//g, '\\u003c/');
        const ideaJson = escapeScript(JSON.stringify(ideaContent));
        const shapingJson = escapeScript(JSON.stringify(shapingContent));
        const summaryJson = escapeScript(JSON.stringify(summaryContent));
        const executionPlanJson = escapeScript(JSON.stringify(executionPlanContent));
        const evidenceFilesJson = escapeScript(JSON.stringify(evidenceFiles));
        const projectJson = escapeScript(JSON.stringify(project || null));

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*, *::before, *::after { box-sizing: border-box; }

body {
    margin: 0;
    padding: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.6;
    overflow-x: hidden;
}

/* ── Header ──────────────────────────────────────────────────── */
.header {
    padding: 20px 24px 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

.title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.plan-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
    line-height: 1.3;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.plan-title.editable {
    cursor: pointer;
    transition: color 0.15s;
}
.plan-title.editable:hover {
    color: var(--vscode-textLink-foreground, #4fc3f7);
}

.badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    flex-shrink: 0;
}

.refresh-btn {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.15));
    color: var(--vscode-descriptionForeground);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
    transition: background 0.15s;
}
.refresh-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-editor-foreground);
}

.progress-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
}

.progress-bar {
    flex: 1;
    height: 5px;
    background: var(--vscode-progressBar-background, rgba(255,255,255,0.1));
    border-radius: 3px;
    overflow: hidden;
    opacity: 0.4;
    max-width: 240px;
}
.progress-bar.has-progress { opacity: 1; }
.progress-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--vscode-progressBar-background, #4fc3f7);
    transition: width 0.4s ease;
}

.progress-label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
}

.meta-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding-bottom: 12px;
    flex-wrap: wrap;
}
.meta-item {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    align-items: center;
    gap: 4px;
}
.meta-item .label {
    opacity: 0.6;
}
.meta-item .mono {
    font-family: var(--vscode-editor-font-family, monospace);
}
.copy-inline-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--vscode-descriptionForeground);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 10px;
    line-height: 1.2;
    cursor: pointer;
    margin-left: 3px;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.copy-inline-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-editor-foreground);
    border-color: var(--vscode-button-secondaryBorder, rgba(255,255,255,0.2));
}
.meta-link {
    color: var(--vscode-textLink-foreground, #4fc3f7);
    text-decoration: none;
}
.meta-link:hover {
    text-decoration: underline;
}

/* ── Tabs ────────────────────────────────────────────────────── */
.tabs {
    display: flex;
    gap: 0;
    padding: 0 24px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    overflow-x: auto;
}

.tab-btn {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground);
    padding: 10px 16px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
    margin-bottom: -1px;
}
.tab-btn:hover {
    color: var(--vscode-editor-foreground);
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.05));
}
.tab-btn.active {
    color: var(--vscode-editor-foreground);
    border-bottom-color: var(--vscode-focusBorder, #4fc3f7);
    font-weight: 500;
}

/* ── Content pane ────────────────────────────────────────────── */
.pane {
    display: none;
    padding: 24px;
    overflow-y: auto;
    max-height: calc(100vh - 160px);
}
.pane.active { display: block; }

/* Make Idea edit mode use full available vertical space */
#idea-edit-mode {
    display: none;
    flex-direction: column;
    height: calc(100vh - 250px);
    min-height: 320px;
}
#idea-edit-mode .content-editor {
    flex: 1;
    min-height: 0;
    height: auto;
    resize: none;
}
#idea-edit-mode .editor-actions {
    position: sticky;
    bottom: 0;
    z-index: 2;
    margin-top: 0;
    padding: 10px 0 0;
    background: var(--vscode-editor-background);
    border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
}

/* ── Action buttons ──────────────────────────────────────────── */
.action-btn {
    background: transparent;
    border: 1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.15));
    color: var(--vscode-descriptionForeground);
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
}
.action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-editor-foreground);
}
.action-btn.primary {
    background: var(--vscode-button-background, #0e639c);
    border-color: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
}
.action-btn.primary:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
}
.action-btn.small {
    padding: 2px 7px;
    font-size: 10px;
}

/* ── Section toolbar ─────────────────────────────────────────── */
.section-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    justify-content: flex-end;
}

/* ── Content editor (textarea) ───────────────────────────────── */
.content-editor {
    width: 100%;
    min-height: 300px;
    background: var(--vscode-input-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15));
    border-radius: 4px;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    line-height: 1.6;
    padding: 10px 12px;
    resize: vertical;
    outline: none;
    display: block;
}
.content-editor:focus {
    border-color: var(--vscode-focusBorder, #4fc3f7);
}
.content-editor.small {
    min-height: 100px;
}

/* ── Editor actions row ──────────────────────────────────────── */
.editor-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}

/* ── Markdown content ────────────────────────────────────────── */
.md-content h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 8px;
    color: var(--vscode-editor-foreground);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
}
.md-content h2 {
    font-size: 13px;
    font-weight: 600;
    margin: 18px 0 6px;
    color: var(--vscode-editor-foreground);
    opacity: 0.9;
}
.md-content h3 {
    font-size: 12px;
    font-weight: 600;
    margin: 14px 0 4px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.06em;
}
.md-content p {
    margin: 0 0 10px;
    color: var(--vscode-editor-foreground);
    opacity: 0.9;
    line-height: 1.65;
}
.md-content ul, .md-content ol {
    margin: 0 0 10px;
    padding-left: 20px;
}
.md-content li {
    margin-bottom: 4px;
    color: var(--vscode-editor-foreground);
    opacity: 0.9;
    line-height: 1.5;
}
.md-content code {
    background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.08));
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
}
.md-content blockquote {
    border-left: 3px solid var(--vscode-focusBorder, #4fc3f7);
    margin: 0 0 10px;
    padding: 4px 12px;
    opacity: 0.7;
}
.md-content strong { font-weight: 600; }
.md-content em { font-style: italic; opacity: 0.85; }
.md-content hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    margin: 16px 0;
}
.md-content a { color: var(--vscode-textLink-foreground, #4fc3f7); text-decoration: none; }
.md-content a:hover { text-decoration: underline; }
.md-content table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 12px;
    font-size: 12px;
}
.md-content th, .md-content td {
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.14));
    padding: 6px 8px;
    text-align: left;
    vertical-align: top;
}
.md-content th {
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.05));
    font-weight: 600;
}

/* ── Meta sections (constraints, questions) ─────────────────── */
.meta-section {
    margin-top: 24px;
    padding: 16px;
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.03));
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
    border-radius: 6px;
}
.meta-section-title {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
}
.bullet-list {
    margin: 0;
    padding-left: 16px;
    list-style: disc;
}
.bullet-list li {
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    opacity: 0.85;
    margin-bottom: 5px;
    line-height: 1.5;
}
.shaping-content {
    font-size: 12px;
    opacity: 0.9;
}

/* ── Steps ───────────────────────────────────────────────────── */
.steps-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.step-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s;
    user-select: none;
}
.step-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    border-color: var(--vscode-panel-border, rgba(255,255,255,0.08));
}
.step-row.active {
    background: rgba(79, 195, 247, 0.06);
    border-color: rgba(79, 195, 247, 0.2);
}
.step-row.expanded {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom-color: transparent;
}
.step-indicator {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid;
    flex-shrink: 0;
    margin-top: 1px;
}
.step-body {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
}
.step-num {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
    min-width: 16px;
    flex-shrink: 0;
}
.step-title {
    font-size: 13px;
    color: var(--vscode-editor-foreground);
    flex: 1;
    min-width: 0;
}
.step-title.struck {
    text-decoration: line-through;
    opacity: 0.5;
}
.step-date {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    opacity: 0.7;
    flex-shrink: 0;
}
.step-chevron {
    font-size: 14px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.4;
    flex-shrink: 0;
    transition: transform 0.2s;
    margin-top: 1px;
}
.step-chevron.open {
    transform: rotate(90deg);
    opacity: 0.7;
}

/* Step content area */
.step-content-area {
    display: none;
    padding: 14px 16px 16px 50px;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
    border-top: none;
    border-radius: 0 0 6px 6px;
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.02));
    margin-bottom: 4px;
}
.step-content-area.visible { display: block; }
.step-content-loading {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    padding: 8px 0;
}
.step-content-body {
    font-size: 12px;
}

/* ── Evidence ─────────────────────────────────────────────────── */
.evidence-layout {
    display: grid;
    grid-template-columns: minmax(260px, 34%) 1fr;
    gap: 14px;
    min-height: 360px;
}
.evidence-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    border-radius: 6px;
    padding: 8px;
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.02));
    max-height: calc(100vh - 330px);
    overflow: auto;
}
.evidence-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    padding: 8px 9px;
    font-family: inherit;
    font-size: inherit;
}
.evidence-row:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    border-color: var(--vscode-panel-border, rgba(255,255,255,0.08));
}
.evidence-row.active {
    background: rgba(79, 195, 247, 0.08);
    border-color: rgba(79, 195, 247, 0.24);
}
.evidence-row.selected {
    background: rgba(79, 195, 247, 0.12);
    border-color: rgba(79, 195, 247, 0.28);
}
.evidence-row.removing {
    opacity: 0.45;
    pointer-events: none;
}
.evidence-row-icon {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin-top: 1px;
    flex-shrink: 0;
}
.evidence-row-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.evidence-row-name {
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    font-weight: 500;
    word-break: break-word;
}
.evidence-row-preview {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.75;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.evidence-row-size {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    margin-top: 2px;
    flex-shrink: 0;
}
.evidence-row-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    line-height: 1.3;
}
.evidence-row-id {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.75;
    font-family: var(--vscode-editor-font-family, monospace);
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.evidence-row-action {
    border: 1px solid transparent;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    border-radius: 4px;
    cursor: pointer;
    padding: 2px 6px;
    margin-top: 1px;
    flex-shrink: 0;
}
.evidence-row-action:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08));
    color: var(--vscode-editor-foreground);
    border-color: var(--vscode-panel-border, rgba(255,255,255,0.15));
}
.evidence-row-action.copied {
    color: #81c784;
    border-color: rgba(129, 199, 132, 0.3);
}
.evidence-detail {
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    border-radius: 6px;
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.02));
    padding: 14px;
    overflow: auto;
    max-height: calc(100vh - 330px);
}
.evidence-detail-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
}
.evidence-detail-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
    line-height: 1.35;
}
.evidence-detail-meta {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.75;
}
.evidence-detail-loading {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.8;
}
.evidence-context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 210px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(255,255,255,0.2)));
    border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.28);
    padding: 6px;
}
.evidence-context-item {
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
    font-family: inherit;
    font-size: 12px;
    padding: 7px 8px;
    border-radius: 4px;
    cursor: pointer;
}
.evidence-context-item:hover {
    background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08));
}
.evidence-context-item.danger {
    color: var(--vscode-errorForeground, #e57373);
}
.evidence-context-item.danger:hover {
    background: rgba(229, 115, 115, 0.14);
}
@media (max-width: 1100px) {
    .evidence-layout {
        grid-template-columns: 1fr;
        gap: 10px;
    }
    .evidence-list {
        max-height: 220px;
    }
    .evidence-detail {
        max-height: none;
        min-height: 240px;
    }
}

/* ── Evidence add form ───────────────────────────────────────── */
.evidence-form {
    padding: 16px;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.1));
    border-radius: 6px;
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.02));
    margin-bottom: 14px;
}
.form-field {
    margin-bottom: 10px;
}
.form-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
}
.form-input {
    width: 100%;
    background: var(--vscode-input-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.15));
    border-radius: 4px;
    color: var(--vscode-editor-foreground);
    font-family: inherit;
    font-size: 12px;
    padding: 5px 8px;
    outline: none;
}
.form-input:focus {
    border-color: var(--vscode-focusBorder, #4fc3f7);
}

/* ── History ─────────────────────────────────────────────────── */
.history-list {
    display: flex;
    flex-direction: column;
    position: relative;
}
.history-list::before {
    content: '';
    position: absolute;
    left: 7px;
    top: 12px;
    bottom: 12px;
    width: 1px;
    background: var(--vscode-panel-border, rgba(255,255,255,0.1));
}
.history-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 0;
    position: relative;
}
.history-dot {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 2px;
    position: relative;
    z-index: 1;
    box-shadow: 0 0 0 3px var(--vscode-editor-background);
}
.history-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.history-type {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}
.history-summary {
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    opacity: 0.8;
    line-height: 1.4;
}
.history-time {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 3px;
}

/* ── Overview grid ───────────────────────────────────────────── */
.overview-grid {
    display: flex;
    flex-direction: column;
    gap: 20px;
}
.overview-section {
    padding: 16px;
    background: var(--vscode-sideBar-background, rgba(255,255,255,0.03));
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
    border-radius: 6px;
}
.overview-section-title {
    margin: 0 0 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
}
.quick-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
}
.stat-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
}
.stat-value {
    font-size: 13px;
    color: var(--vscode-editor-foreground);
}
.empty-hint {
    font-size: 11px;
    opacity: 0.6;
    margin-top: 4px;
}

/* ── Shaping tab ─────────────────────────────────────────────── */
.shaping-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.selected-approach-banner {
    padding: 12px 16px;
    background: rgba(79, 195, 247, 0.08);
    border: 1px solid rgba(79, 195, 247, 0.2);
    border-radius: 6px;
    font-size: 13px;
    color: var(--vscode-editor-foreground);
}
.approach-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-right: 6px;
}

/* ── Empty states ────────────────────────────────────────────── */
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.5;
    text-align: center;
}
.empty-icon {
    font-size: 32px;
    margin-bottom: 10px;
    opacity: 0.4;
}
.empty-state p { margin: 0; font-size: 12px; }
</style>
</head>
<body>

<!-- ── Header ───────────────────────────────────────── -->
<div class="header">
  <div class="title-row">
    <h1 class="plan-title editable" id="plan-title-text" title="Click to rename plan">${name}</h1>
    <span class="badge" style="background:${stagePal.bg};color:${stagePal.text}">${this._esc(stage)}</span>
    ${planStatus !== stage ? `<span class="badge" style="background:${statusPal.bg};color:${statusPal.text}">${this._esc(planStatus)}</span>` : ''}
    <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
  </div>

  ${progress.total > 0 ? `
  <div class="progress-row">
    <div class="progress-bar has-progress">
      <div class="progress-fill" style="width:${pct}%"></div>
    </div>
    <span class="progress-label">${progress.completed} / ${progress.total} steps &nbsp;·&nbsp; ${Math.round(pct)}%</span>
  </div>` : ''}

  <div class="meta-row">
    ${code ? `<span class="meta-item"><span class="label">code:</span> ${code}<button id="copy-plan-id-btn" class="copy-inline-btn" title="Copy plan ID">⧉</button></span>` : ''}
    ${lastUpdated ? `<span class="meta-item"><span class="label">updated:</span> ${this._esc(lastUpdated)}</span>` : ''}
    ${status?.lastCompleted ? `<span class="meta-item"><span class="label">last step:</span> ${status.lastCompleted}</span>` : ''}
    <span class="meta-item" id="project-meta-item"${projectName ? '' : ' style="display:none"'}><span class="label">project:</span> <a href="#" id="open-project-entity-link" class="meta-link">${projectName}</a></span>
    <span class="meta-item" id="project-path-meta-item"${projectPath ? '' : ' style="display:none"'}><span class="label">project path:</span> <span class="mono" id="project-path-meta-value">${projectPath}</span></span>
    <span class="meta-item" id="repo-meta-item"${repoUrl ? '' : ' style="display:none"'}><span class="label">repo:</span> <a class="meta-link" id="repo-meta-link" href="${repoUrl}">${repoUrl}</a></span>
  </div>
</div>

<!-- ── Tabs ──────────────────────────────────────────── -->
<div class="tabs">
  <button class="tab-btn active" data-tab="overview">Overview</button>
  <button class="tab-btn" data-tab="idea">Idea</button>
  <button class="tab-btn" data-tab="evidence">${this._esc(evidTab)}</button>
  <button class="tab-btn" data-tab="shaping">Shaping</button>
  <button class="tab-btn" data-tab="steps">${this._esc(stepTab)}</button>
  <button class="tab-btn" data-tab="execution">Execution Plan</button>
  <button class="tab-btn" data-tab="history">${this._esc(histTab)}</button>
</div>

<!-- ── Overview tab ─────────────────────────────────── -->
<div id="pane-overview" class="pane active">
  <div class="overview-grid">
    <div class="overview-section">
      <h3 class="overview-section-title">Summary</h3>
      <div class="md-content" id="summary-md">${summaryContent ? '' : '<p class="empty-hint">No summary available</p>'}</div>
    </div>
    ${constraintsBlock}
    ${questionsBlock}
    ${shapingBlock}
    <div class="overview-section">
      <h3 class="overview-section-title">Quick Stats</h3>
      <div class="quick-stats">
        <div class="stat-item"><span class="stat-label">Stage</span><span class="stat-value">${this._esc(stage)}</span></div>
        <div class="stat-item"><span class="stat-label">Progress</span><span class="stat-value">${progress.completed}/${progress.total} steps (${Math.round(pct)}%)</span></div>
        ${steps.length > 0 ? `<div class="stat-item"><span class="stat-label">Current Step</span><span class="stat-value">${status?.currentStep || 'N/A'}</span></div>` : ''}
        ${selectedApproach ? `<div class="stat-item"><span class="stat-label">Approach</span><span class="stat-value">${this._esc(selectedApproach)}</span></div>` : ''}
      </div>
    </div>
  </div>
</div>

<!-- ── Idea tab ────────────────────────────────────── -->
<div id="pane-idea" class="pane">
  <div class="section-toolbar">
    <button class="action-btn" id="edit-idea-btn">✎ Edit Idea</button>
  </div>
  <!-- View mode -->
  <div id="idea-view">
    ${ideaContent
        ? `<div class="md-content" id="idea-md"></div>`
        : `<div class="empty-state"><span class="empty-icon">☆</span><p>No IDEA.md found — click Edit to create one</p></div>`
}
  </div>
  <!-- Edit mode -->
  <div id="idea-edit-mode" style="display:none">
    <textarea id="idea-textarea" class="content-editor" placeholder="Write your idea in Markdown..."></textarea>
    <div class="editor-actions">
      <button class="action-btn primary" id="save-idea-btn">Save</button>
      <button class="action-btn" id="cancel-idea-btn">Cancel</button>
    </div>
  </div>
</div>

<!-- ── Evidence tab ─────────────────────────────────── -->
<div id="pane-evidence" class="pane">
  <div class="section-toolbar">
    <button class="action-btn" id="add-evidence-toggle" onclick="toggleNewEvidenceForm()">+ Add Evidence</button>
  </div>
  <!-- New evidence form -->
  <div id="new-evidence-form" class="evidence-form" style="display:none">
    <div class="form-field">
      <label class="form-label">Description *</label>
      <input type="text" id="ev-description" class="form-input" placeholder="What does this evidence show?" />
    </div>
    <div class="form-field">
      <label class="form-label">Source</label>
      <input type="text" id="ev-source" class="form-input" placeholder="URL or file path..." />
    </div>
    <div class="form-field">
      <label class="form-label">Summary</label>
      <input type="text" id="ev-summary" class="form-input" placeholder="One-line summary..." />
    </div>
    <div class="form-field">
      <label class="form-label">Content</label>
      <textarea id="ev-content" class="content-editor small" placeholder="Evidence text (optional)..."></textarea>
    </div>
    <div class="editor-actions">
      <button class="action-btn primary" onclick="submitNewEvidence()">Add Evidence</button>
      <button class="action-btn" onclick="toggleNewEvidenceForm()">Cancel</button>
    </div>
  </div>
  <!-- Evidence list + detail -->
  ${evidenceFiles.length === 0 ? evidenceHtml : `
  <div class="evidence-layout">
    <div class="evidence-list">${evidenceHtml}</div>
    <div class="evidence-detail">
      <div id="evidence-detail-empty" class="empty-state" style="padding:28px 16px">
        <span class="empty-icon">◫</span>
        <p>Select an evidence entry to view details</p>
      </div>
      <div id="evidence-detail-content" style="display:none">
        <div class="evidence-detail-header">
          <h3 class="evidence-detail-title" id="evidence-detail-title"></h3>
          <span class="evidence-detail-meta" id="evidence-detail-size"></span>
        </div>
        <div class="evidence-detail-loading" id="evidence-detail-loading" style="display:none">Loading evidence…</div>
        <div class="md-content" id="evidence-detail-md"></div>
      </div>
    </div>
  </div>`}
  <div id="evidence-context-menu" class="evidence-context-menu" style="display:none">
    <button class="evidence-context-item" id="evidence-context-copy-url">Copy Evidence URL</button>
    <button class="evidence-context-item" id="evidence-context-copy-content">Copy Evidence Content</button>
    <button class="evidence-context-item danger" id="evidence-context-remove">Remove Evidence</button>
  </div>
</div>

<!-- ── Shaping tab ─────────────────────────────────── -->
<div id="pane-shaping" class="pane">
  ${shapingContent
        ? `<div class="shaping-container">
          ${selectedApproach ? `<div class="selected-approach-banner"><span class="approach-label">Selected Approach:</span> <strong>${this._esc(selectedApproach)}</strong></div>` : ''}
          <div class="md-content" id="shaping-full-md"></div>
        </div>`
        : `<div class="empty-state"><span class="empty-icon">◇</span><p>No shaping document found</p><p class="empty-hint">Use riotplan_shaping(action: "start") to begin comparing approaches</p></div>`
}
</div>

<!-- ── Steps tab ────────────────────────────────────── -->
<div id="pane-steps" class="pane">
  <div class="steps-list">${stepsHtml}</div>
</div>

<!-- ── Execution Plan tab ──────────────────────────── -->
<div id="pane-execution" class="pane">
  ${executionPlanContent
        ? `<div class="md-content" id="execution-plan-md"></div>`
        : `<div class="empty-state"><span class="empty-icon">▤</span><p>No execution plan found</p><p class="empty-hint">Use riotplan_build to generate an execution plan</p></div>`
}
</div>

<!-- ── History tab ──────────────────────────────────── -->
<div id="pane-history" class="pane">
  <div class="history-list">${historyHtml}</div>
</div>

<script>
// ── VSCode API + tab state + refresh ────────────────────────
var vscode = acquireVsCodeApi();
var webviewState = vscode.getState() || {};

function getActiveTab() {
    var activeBtn = document.querySelector('.tab-btn.active');
    if (!activeBtn) { return 'overview'; }
    var tab = activeBtn.getAttribute('data-tab');
    return tab || 'overview';
}

function activateTab(tab, persist) {
    var targetTab = tab || 'overview';
    document.querySelectorAll('.tab-btn').forEach(function(btn) {
        var isActive = btn.getAttribute('data-tab') === targetTab;
        btn.classList.toggle('active', isActive);
    });
    document.querySelectorAll('.pane').forEach(function(p) {
        p.classList.toggle('active', p.id === 'pane-' + targetTab);
    });
    if (persist) {
        webviewState.activeTab = targetTab;
        vscode.setState(webviewState);
    }
}

document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        activateTab(btn.dataset.tab || 'overview', true);
    });
});

var initialTab = typeof webviewState.activeTab === 'string' ? webviewState.activeTab : 'overview';
activateTab(initialTab, false);
if (!webviewState.activeTab) {
    webviewState.activeTab = initialTab;
    vscode.setState(webviewState);
}

function refresh() {
    vscode.postMessage({ command: 'refresh', activeTab: getActiveTab() });
}
function copyPlanId() { vscode.postMessage({ command: 'copyPlanId' }); }
function changePlanProject() { vscode.postMessage({ command: 'changePlanProject' }); }
function requestPlanRename() {
    var titleEl = document.getElementById('plan-title-text');
    var currentTitle = titleEl ? (titleEl.textContent || '').trim() : '';
    vscode.postMessage({ command: 'renamePlan', currentTitle: currentTitle });
}
function openProjectEntity() {
    vscode.postMessage({ command: 'openProjectEntity', project: projectEntity });
}

// ── Minimal markdown renderer ────────────────────────────────
function renderMarkdown(md) {
    if (md == null || typeof md !== 'string') { return ''; }
    var html = md;

    // Unescape HTML entities so we can re-process as markdown
    html = html
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');

    // Code blocks first (before inline code)
    html = html.replace(/\x60\x60\x60[\\w]*\\n([\\s\\S]*?)\x60\x60\x60/g, function(_, code) {
        return '<pre style="background:var(--vscode-textCodeBlock-background,rgba(255,255,255,0.06));padding:10px 12px;border-radius:5px;font-family:monospace;font-size:11px;overflow-x:auto;margin:8px 0"><code>' +
            escHtml(code.trim()) + '</code></pre>';
    });

    // Headers
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^#### (.+)$/gm, '<h3>$1</h3>');

    // Horizontal rule
    html = html.replace(/^---+$/gm, '<hr>');

    // Bold + italic
    html = html.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Only treat underscores as emphasis delimiters at word boundaries.
    // This preserves identifiers like riotplan_step.
    html = html.replace(/(^|[^\\w])_([^_\\n]+)_(?=[^\\w]|$)/g, function(_, prefix, text) {
        return prefix + '<em>' + text + '</em>';
    });

    // Inline code
    html = html.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');

    // Links
    html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>');

    // Pipe tables
    html = renderPipeTables(html);

    // Unordered lists
    html = html.replace(/((?:^[-*] .+$\\n?)+)/gm, function(match) {
        var items = match.trim().split('\\n')
            .map(function(line) { return line.replace(/^[-*] /, '').trim(); })
            .filter(Boolean)
            .map(function(item) { return '<li>' + item + '</li>'; }).join('');
        return '<ul>' + items + '</ul>';
    });

    // Ordered lists
    html = html.replace(/((?:^\\d+\\. .+$\\n?)+)/gm, function(match) {
        var items = match.trim().split('\\n')
            .map(function(line) { return line.replace(/^\\d+\\. /, '').trim(); })
            .filter(Boolean)
            .map(function(item) { return '<li>' + item + '</li>'; }).join('');
        return '<ol>' + items + '</ol>';
    });

    // Paragraphs
    var blockTags = /^<(h[1-6]|ul|ol|pre|hr|blockquote|table)/;
    html = html.split(/\\n\\n+/).map(function(block) {
        var trimmed = block.trim();
        if (!trimmed) { return ''; }
        if (blockTags.test(trimmed)) { return trimmed; }
        return '<p>' + trimmed.replace(/\\n/g, ' ') + '</p>';
    }).join('\\n');

    return html;
}

function renderPipeTables(md) {
    var lines = md.split('\\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
        var header = lines[i];
        var divider = lines[i + 1];
        if (isTableRow(header) && isTableDivider(divider)) {
            var headers = splitTableRow(header);
            var bodyRows = [];
            i += 2;
            while (i < lines.length && isTableRow(lines[i])) {
                bodyRows.push(splitTableRow(lines[i]));
                i += 1;
            }
            if (headers.length > 1) {
                var thead = '<thead><tr>' + headers.map(function(cell) { return '<th>' + cell + '</th>'; }).join('') + '</tr></thead>';
                var tbody = bodyRows.length
                    ? '<tbody>' + bodyRows.map(function(row) {
                        var cells = row.slice(0, headers.length);
                        while (cells.length < headers.length) { cells.push(''); }
                        return '<tr>' + cells.map(function(cell) { return '<td>' + cell + '</td>'; }).join('') + '</tr>';
                    }).join('') + '</tbody>'
                    : '';
                out.push('<table>' + thead + tbody + '</table>');
                continue;
            }
            out.push(header);
            if (divider != null) { out.push(divider); }
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    return out.join('\\n');
}

function splitTableRow(line) {
    var parts = line.split('|').map(function(part) { return part.trim(); });
    if (parts.length && parts[0] === '') { parts.shift(); }
    if (parts.length && parts[parts.length - 1] === '') { parts.pop(); }
    return parts;
}

function isTableRow(line) {
    if (typeof line !== 'string') { return false; }
    var cells = splitTableRow(line);
    return line.indexOf('|') !== -1 && cells.length > 1;
}

function isTableDivider(line) {
    if (typeof line !== 'string') { return false; }
    var cells = splitTableRow(line);
    if (cells.length < 2) { return false; }
    return cells.every(function(cell) { return /^:?-{3,}:?$/.test(cell); });
}

function escHtml(s) {
    if (s == null || typeof s !== 'string') { return ''; }
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Render initial markdown content ─────────────────────────
var ideaMd = ${ideaJson};
var shapingMd = ${shapingJson};
var summaryMd = ${summaryJson};
var executionPlanMd = ${executionPlanJson};
var evidenceEntries = ${evidenceFilesJson};
var projectEntity = ${projectJson};

function updateProjectMeta(project, projectPath, repoUrl) {
    projectEntity = project || null;

    var projectItem = document.getElementById('project-meta-item');
    var projectLink = document.getElementById('open-project-entity-link');
    var projectName = '';
    if (project && typeof project === 'object') {
        var rawName = project.name || project.id;
        if (typeof rawName === 'string') {
            projectName = rawName;
        }
    }
    if (projectItem) {
        projectItem.style.display = projectName ? '' : 'none';
    }
    if (projectLink) {
        projectLink.textContent = projectName;
    }

    var projectPathItem = document.getElementById('project-path-meta-item');
    var projectPathValueEl = document.getElementById('project-path-meta-value');
    var normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (projectPathItem) {
        projectPathItem.style.display = normalizedProjectPath ? '' : 'none';
    }
    if (projectPathValueEl) {
        projectPathValueEl.textContent = normalizedProjectPath;
    }

    var normalizedRepoUrl = typeof repoUrl === 'string' ? repoUrl.trim() : '';
    if (!normalizedRepoUrl && project && typeof project === 'object' && project.repo && typeof project.repo.url === 'string') {
        normalizedRepoUrl = project.repo.url.trim();
    }
    var repoItem = document.getElementById('repo-meta-item');
    var repoLink = document.getElementById('repo-meta-link');
    if (repoItem) {
        repoItem.style.display = normalizedRepoUrl ? '' : 'none';
    }
    if (repoLink) {
        repoLink.textContent = normalizedRepoUrl;
        repoLink.setAttribute('href', normalizedRepoUrl || '#');
    }
}

try {
    var ideaEl = document.getElementById('idea-md');
    if (ideaEl && ideaMd) { ideaEl.innerHTML = renderMarkdown(ideaMd); }
    var shapingEl = document.getElementById('shaping-full-md');
    if (shapingEl && shapingMd) { shapingEl.innerHTML = renderMarkdown(shapingMd); }
    var summaryEl = document.getElementById('summary-md');
    if (summaryEl && summaryMd) { summaryEl.innerHTML = renderMarkdown(summaryMd); }
    var executionPlanEl = document.getElementById('execution-plan-md');
    if (executionPlanEl && executionPlanMd) { executionPlanEl.innerHTML = renderMarkdown(executionPlanMd); }
} catch (e) {
    console.error('Markdown render error:', e);
}

// ── Idea editing ─────────────────────────────────────────────
function startEditIdea() {
    document.getElementById('idea-view').style.display = 'none';
    document.getElementById('idea-edit-mode').style.display = 'flex';
    document.getElementById('idea-textarea').value = ideaMd || '';
    document.getElementById('idea-textarea').focus();
}

function saveIdea() {
    var content = document.getElementById('idea-textarea').value;
    vscode.postMessage({ command: 'saveIdeaContent', content: content });
}

function cancelEditIdea() {
    document.getElementById('idea-edit-mode').style.display = 'none';
    document.getElementById('idea-view').style.display = 'block';
}

// Wire up idea edit buttons (avoids inline onclick + global scope issues)
var editIdeaBtn = document.getElementById('edit-idea-btn');
if (editIdeaBtn) { editIdeaBtn.addEventListener('click', startEditIdea); }
var saveIdeaBtn = document.getElementById('save-idea-btn');
if (saveIdeaBtn) { saveIdeaBtn.addEventListener('click', saveIdea); }
var cancelIdeaBtn = document.getElementById('cancel-idea-btn');
if (cancelIdeaBtn) { cancelIdeaBtn.addEventListener('click', cancelEditIdea); }
var copyPlanIdBtn = document.getElementById('copy-plan-id-btn');
if (copyPlanIdBtn) { copyPlanIdBtn.addEventListener('click', copyPlanId); }
var planTitleEl = document.getElementById('plan-title-text');
if (planTitleEl) {
    planTitleEl.addEventListener('click', function() {
        requestPlanRename();
    });
}
var openProjectEntityLink = document.getElementById('open-project-entity-link');
if (openProjectEntityLink) {
    openProjectEntityLink.addEventListener('click', function(event) {
        event.preventDefault();
        changePlanProject();
    });
}

// ── Step expansion ───────────────────────────────────────────
var stepLoaded = {};

function toggleStep(n) {
    var area = document.getElementById('step-content-' + n);
    var chevron = document.getElementById('step-chevron-' + n);
    var row = document.querySelector('[data-step="' + n + '"]');
    if (!area) { return; }

    if (area.classList.contains('visible')) {
        area.classList.remove('visible');
        if (chevron) { chevron.classList.remove('open'); }
        if (row) { row.classList.remove('expanded'); }
    } else {
        area.classList.add('visible');
        if (chevron) { chevron.classList.add('open'); }
        if (row) { row.classList.add('expanded'); }
        if (!stepLoaded[n]) {
            vscode.postMessage({ command: 'getStepContent', stepNumber: n });
        }
    }
}

// ── Evidence add form ────────────────────────────────────────
function toggleNewEvidenceForm() {
    var form = document.getElementById('new-evidence-form');
    var btn = document.getElementById('add-evidence-toggle');
    if (!form) { return; }
    if (form.style.display === 'none') {
        form.style.display = 'block';
        if (btn) { btn.textContent = '✕ Cancel'; }
        var descInput = document.getElementById('ev-description');
        if (descInput) { descInput.focus(); }
    } else {
        form.style.display = 'none';
        if (btn) { btn.textContent = '+ Add Evidence'; }
        // Clear fields
        ['ev-description','ev-source','ev-summary','ev-content'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) { el.value = ''; }
        });
    }
}

function submitNewEvidence() {
    var descEl = document.getElementById('ev-description');
    var desc = descEl ? descEl.value.trim() : '';
    if (!desc) {
        if (descEl) { descEl.focus(); descEl.style.borderColor = 'var(--vscode-inputValidation-errorBorder, #f44)'; }
        return;
    }
    var sourceEl = document.getElementById('ev-source');
    var summaryEl = document.getElementById('ev-summary');
    var contentEl = document.getElementById('ev-content');
    vscode.postMessage({
        command: 'addEvidence',
        description: desc,
        source: sourceEl ? sourceEl.value.trim() : '',
        summary: summaryEl ? summaryEl.value.trim() : '',
        content: contentEl ? contentEl.value.trim() : '',
    });
    toggleNewEvidenceForm();
}

// ── Evidence list/detail ─────────────────────────────────────
var evidencePendingIdx = {};
var evidenceLoaded = {};
var evidenceContentByIdx = {};
var evidenceRawContentByIdx = {};
var selectedEvidenceIdx = -1;
var evidenceContextIdx = -1;
var evidenceSelectedIdxs = [];
var evidenceSelectionAnchorIdx = -1;
var evidenceContextMenuWired = false;
var evidenceRemovalPendingByName = {};

function updateEvidenceTabLabel() {
    var evidenceTab = document.querySelector('.tab-btn[data-tab="evidence"]');
    if (!evidenceTab) { return; }
    var count = Array.isArray(evidenceEntries) ? evidenceEntries.length : 0;
    evidenceTab.textContent = count > 0 ? ('Evidence (' + count + ')') : 'Evidence';
}

function renderEvidenceRows() {
    var list = document.querySelector('#pane-evidence .evidence-list');
    if (!list) { return; }
    if (!Array.isArray(evidenceEntries) || evidenceEntries.length === 0) {
        list.innerHTML = '<div class="empty-state"><span class="empty-icon">◫</span><p>No evidence files attached</p></div>';
        return;
    }
    list.innerHTML = evidenceEntries.map(function(entry, idx) {
        var addedDate = entry && entry.createdAt ? new Date(entry.createdAt) : null;
        var addedLabel = addedDate && !Number.isNaN(addedDate.getTime())
            ? 'Added ' + addedDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Added date unknown';
        var sizeHtml = (entry && typeof entry.size === 'number' && entry.size > 0)
            ? '<span class="evidence-row-size">' + (entry.size / 1024).toFixed(1) + ' kb</span>'
            : '';
        return '<div class="evidence-row" role="button" tabindex="0" data-evidence-idx="' + idx + '" onclick="selectEvidence(' + idx + ', event)">' +
            '<span class="evidence-row-icon">◫</span>' +
            '<span class="evidence-row-body">' +
                '<span class="evidence-row-name">' + escHtml(getEvidenceTitle(entry)) + '</span>' +
                '<span class="evidence-row-id">ID: ' + escHtml(entry && entry.name ? entry.name : '') + '</span>' +
                '<span class="evidence-row-meta">' + escHtml(addedLabel) + '</span>' +
            '</span>' +
            sizeHtml +
            '<button class="evidence-row-action" id="evidence-copy-url-' + idx + '" onclick="copyEvidenceUrl(' + idx + ', event)" title="Copy Evidence URL">⧉</button>' +
        '</div>';
    }).join('');
}

function showEvidenceDetailEmptyState() {
    var empty = document.getElementById('evidence-detail-empty');
    var content = document.getElementById('evidence-detail-content');
    var loading = document.getElementById('evidence-detail-loading');
    var body = document.getElementById('evidence-detail-md');
    var title = document.getElementById('evidence-detail-title');
    var sizeEl = document.getElementById('evidence-detail-size');
    if (empty) { empty.style.display = 'block'; }
    if (content) { content.style.display = 'none'; }
    if (loading) { loading.style.display = 'none'; }
    if (body) { body.innerHTML = ''; }
    if (title) { title.textContent = ''; }
    if (sizeEl) { sizeEl.textContent = ''; }
}

function applyEvidenceRemoval(removedRefs) {
    if (!Array.isArray(removedRefs) || removedRefs.length === 0) { return; }
    var removedSet = {};
    removedRefs.forEach(function(ref) {
        if (typeof ref === 'string' && ref.trim()) {
            removedSet[ref.trim()] = true;
        }
    });
    evidenceEntries = (Array.isArray(evidenceEntries) ? evidenceEntries : []).filter(function(entry) {
        var key = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
        return key ? !removedSet[key] : true;
    });
    evidencePendingIdx = {};
    evidenceLoaded = {};
    evidenceContentByIdx = {};
    evidenceRawContentByIdx = {};
    selectedEvidenceIdx = -1;
    evidenceContextIdx = -1;
    evidenceSelectedIdxs = [];
    evidenceSelectionAnchorIdx = -1;
    evidenceRemovalPendingByName = {};
    hideEvidenceContextMenu();
    renderEvidenceRows();
    wireEvidenceRowContextMenu();
    updateEvidenceTabLabel();
    if (Array.isArray(evidenceEntries) && evidenceEntries.length > 0) {
        selectEvidence(0);
        return;
    }
    showEvidenceDetailEmptyState();
}

function setEvidenceRemovalPending(pending, filenames) {
    evidenceRemovalPendingByName = {};
    if (pending && Array.isArray(filenames)) {
        filenames.forEach(function(name) {
            if (typeof name === 'string' && name.trim()) {
                evidenceRemovalPendingByName[name.trim()] = true;
            }
        });
    }
    document.querySelectorAll('.evidence-row').forEach(function(row) {
        var idxStr = row.getAttribute('data-evidence-idx');
        var idx = idxStr ? parseInt(idxStr, 10) : -1;
        var entry = Array.isArray(evidenceEntries) ? evidenceEntries[idx] : undefined;
        var name = entry && typeof entry.name === 'string' ? entry.name.trim() : '';
        var isPending = !!(name && evidenceRemovalPendingByName[name]);
        row.classList.toggle('removing', isPending);
    });
    var removeBtn = document.getElementById('evidence-context-remove');
    if (removeBtn) {
        removeBtn.disabled = !!pending;
        removeBtn.textContent = pending ? 'Removing…' : 'Remove Evidence';
    }
}

function updateEvidenceSelectionStyles() {
    var selectedSet = {};
    evidenceSelectedIdxs.forEach(function(i) { selectedSet[i] = true; });
    document.querySelectorAll('.evidence-row').forEach(function(row) {
        var idxStr = row.getAttribute('data-evidence-idx');
        var idx = idxStr ? parseInt(idxStr, 10) : -1;
        row.classList.toggle('selected', !!selectedSet[idx]);
        row.classList.toggle('active', idx === selectedEvidenceIdx);
    });
}

function applyEvidenceSelection(idx, ev) {
    var hasModifier = !!(ev && (ev.metaKey || ev.ctrlKey));
    var isRangeSelection = !!(ev && ev.shiftKey);

    if (isRangeSelection && evidenceSelectionAnchorIdx >= 0) {
        var start = Math.min(evidenceSelectionAnchorIdx, idx);
        var end = Math.max(evidenceSelectionAnchorIdx, idx);
        var range = [];
        for (var i = start; i <= end; i += 1) {
            range.push(i);
        }
        evidenceSelectedIdxs = range;
    } else if (hasModifier) {
        var next = evidenceSelectedIdxs.slice();
        var existingPos = next.indexOf(idx);
        if (existingPos >= 0) {
            next.splice(existingPos, 1);
        } else {
            next.push(idx);
        }
        if (next.length === 0) {
            next.push(idx);
        }
        evidenceSelectedIdxs = next.sort(function(a, b) { return a - b; });
        evidenceSelectionAnchorIdx = idx;
    } else {
        evidenceSelectedIdxs = [idx];
        evidenceSelectionAnchorIdx = idx;
    }

    if (evidenceSelectedIdxs.indexOf(idx) < 0) {
        evidenceSelectedIdxs.push(idx);
        evidenceSelectedIdxs.sort(function(a, b) { return a - b; });
    }
    selectedEvidenceIdx = idx;
    updateEvidenceSelectionStyles();
}

function getEvidenceCopyTargets(preferredIdx) {
    var selected = evidenceSelectedIdxs
        .filter(function(i) { return Array.isArray(evidenceEntries) && !!evidenceEntries[i]; })
        .sort(function(a, b) { return a - b; });
    if (selected.length > 0) {
        return selected;
    }
    if (typeof preferredIdx === 'number' && preferredIdx >= 0 && Array.isArray(evidenceEntries) && evidenceEntries[preferredIdx]) {
        return [preferredIdx];
    }
    return [];
}

function selectEvidence(idx, ev) {
    if (!Array.isArray(evidenceEntries) || !evidenceEntries[idx]) { return; }
    var entry = evidenceEntries[idx];
    applyEvidenceSelection(idx, ev);

    var empty = document.getElementById('evidence-detail-empty');
    var content = document.getElementById('evidence-detail-content');
    var loading = document.getElementById('evidence-detail-loading');
    var body = document.getElementById('evidence-detail-md');
    var title = document.getElementById('evidence-detail-title');
    var sizeEl = document.getElementById('evidence-detail-size');

    if (empty) { empty.style.display = 'none'; }
    if (content) { content.style.display = 'block'; }
    if (title) { title.textContent = getEvidenceTitle(entry); }
    if (sizeEl) { sizeEl.textContent = formatEvidenceMeta(entry); }

    if (evidenceLoaded[idx]) {
        if (loading) { loading.style.display = 'none'; }
        if (body) { body.innerHTML = renderMarkdown(evidenceContentByIdx[idx] || ''); }
        return;
    }

    if (loading) { loading.style.display = 'block'; }
    if (body) { body.innerHTML = ''; }
    var filename = entry.name;
    evidencePendingIdx[filename] = idx;
    vscode.postMessage({ command: 'getEvidenceContent', filename: filename });
}

function copyEvidenceUrl(idx, ev) {
    if (ev) { ev.stopPropagation(); }
    if (!Array.isArray(evidenceEntries) || !evidenceEntries[idx]) { return; }
    var targetIdxs = getEvidenceCopyTargets(idx);
    var filenames = targetIdxs
        .map(function(i) { return evidenceEntries[i] ? evidenceEntries[i].name : ''; })
        .filter(function(name) { return typeof name === 'string' && name.length > 0; });
    if (filenames.length === 0) { return; }
    vscode.postMessage({
        command: 'copyEvidenceUrl',
        filename: filenames[0],
        filenames: filenames,
        idx: idx,
    });
}

function copyEvidenceContent(idx, ev) {
    if (ev) { ev.stopPropagation(); }
    if (!Array.isArray(evidenceEntries) || !evidenceEntries[idx]) { return; }
    var targetIdxs = getEvidenceCopyTargets(idx);
    var filenames = targetIdxs
        .map(function(i) { return evidenceEntries[i] ? evidenceEntries[i].name : ''; })
        .filter(function(name) { return typeof name === 'string' && name.length > 0; });
    if (filenames.length === 0) { return; }
    var contentsByFilename = {};
    targetIdxs.forEach(function(i) {
        if (!evidenceEntries[i]) { return; }
        var name = evidenceEntries[i].name;
        if (typeof name !== 'string' || !name) { return; }
        if (typeof evidenceRawContentByIdx[i] === 'string' && evidenceRawContentByIdx[i].length > 0) {
            contentsByFilename[name] = evidenceRawContentByIdx[i];
        }
    });
    vscode.postMessage({
        command: 'copyEvidenceContent',
        filename: filenames[0],
        filenames: filenames,
        content: evidenceRawContentByIdx[idx] || '',
        contentsByFilename: contentsByFilename,
        idx: idx,
    });
}

function removeEvidence(idx, ev) {
    if (ev) { ev.stopPropagation(); }
    if (!Array.isArray(evidenceEntries) || !evidenceEntries[idx]) { return; }
    var targetIdxs = getEvidenceCopyTargets(idx);
    var filenames = targetIdxs
        .map(function(i) { return evidenceEntries[i] ? evidenceEntries[i].name : ''; })
        .filter(function(name) { return typeof name === 'string' && name.length > 0; });
    if (filenames.length === 0) { return; }

    vscode.postMessage({
        command: 'removeEvidence',
        filename: filenames[0],
        filenames: filenames,
        idx: idx,
    });
}

function normalizeEvidenceContent(raw) {
    if (typeof raw !== 'string') { return ''; }
    var trimmed = raw.trim();
    if (!trimmed) { return ''; }

    if (trimmed[0] !== '{' && trimmed[0] !== '[') {
        return raw;
    }

    try {
        var parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return '**JSON**\\n\\n' + JSON.stringify(parsed, null, 2);
        }
        if (!parsed || typeof parsed !== 'object') {
            return raw;
        }

        var markdownBody = '';
        var candidates = ['content', 'markdown', 'md', 'body', 'text'];
        for (var i = 0; i < candidates.length; i += 1) {
            var key = candidates[i];
            if (typeof parsed[key] === 'string' && parsed[key].trim()) {
                markdownBody = parsed[key];
                break;
            }
        }
        if (!markdownBody) {
            markdownBody = '**JSON**\\n\\n' + JSON.stringify(parsed, null, 2);
        }

        var extras = [];
        if (typeof parsed.description === 'string' && parsed.description.trim()) {
            extras.push('**Description:** ' + parsed.description.trim());
        }
        if (typeof parsed.source === 'string' && parsed.source.trim()) {
            extras.push('**Source:** ' + parsed.source.trim());
        }
        if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
            extras.push('**Summary:** ' + parsed.summary.trim());
        }

        if (extras.length > 0) {
            return extras.join('\\n\\n') + '\\n\\n---\\n\\n' + markdownBody;
        }
        return markdownBody;
    } catch {
        return raw;
    }
}

function titleFromFilename(name) {
    if (typeof name !== 'string' || !name) { return 'Evidence'; }
    var lastPart = name.split('/').pop() || name;
    var withoutExt = lastPart.replace(/[.][^.]+$/, '');
    var normalized = withoutExt
        .replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-/, '')
        .replace(/[-_]+/g, ' ')
        .trim();
    if (!normalized) { return name; }
    return normalized
        .split(' ')
        .filter(Boolean)
        .map(function(token) { return token.charAt(0).toUpperCase() + token.slice(1); })
        .join(' ');
}

function getEvidenceTitle(entry) {
    if (entry && typeof entry.title === 'string' && entry.title.trim()) {
        return entry.title.trim();
    }
    if (entry && typeof entry.name === 'string' && entry.name.trim()) {
        return titleFromFilename(entry.name.trim());
    }
    return 'Evidence';
}

function formatEvidenceMeta(entry) {
    var sizeText = '';
    if (entry && typeof entry.size === 'number' && entry.size > 0) {
        sizeText = (entry.size / 1024).toFixed(1) + ' kb';
    }

    var dateText = '';
    if (entry && typeof entry.createdAt === 'string' && entry.createdAt.trim()) {
        var d = new Date(entry.createdAt);
        if (!Number.isNaN(d.getTime())) {
            dateText = 'Added ' + d.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
            });
        }
    }

    if (dateText && sizeText) {
        return dateText + ' · ' + sizeText;
    }
    return dateText || sizeText || 'Added date unknown';
}

function hideEvidenceContextMenu() {
    var menu = document.getElementById('evidence-context-menu');
    if (menu) { menu.style.display = 'none'; }
    evidenceContextIdx = -1;
}

function showEvidenceContextMenu(x, y, idx) {
    var menu = document.getElementById('evidence-context-menu');
    if (!menu) { return; }
    evidenceContextIdx = idx;
    menu.style.display = 'block';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
}

function wireEvidenceRowContextMenu() {
    if (!evidenceContextMenuWired) {
        var copyUrlBtn = document.getElementById('evidence-context-copy-url');
        if (copyUrlBtn) {
            copyUrlBtn.addEventListener('click', function() {
                if (evidenceContextIdx >= 0) { copyEvidenceUrl(evidenceContextIdx); }
                hideEvidenceContextMenu();
            });
        }

        var copyContentBtn = document.getElementById('evidence-context-copy-content');
        if (copyContentBtn) {
            copyContentBtn.addEventListener('click', function() {
                if (evidenceContextIdx >= 0) { copyEvidenceContent(evidenceContextIdx); }
                hideEvidenceContextMenu();
            });
        }
        var removeBtn = document.getElementById('evidence-context-remove');
        if (removeBtn) {
            removeBtn.addEventListener('click', function() {
                if (evidenceContextIdx >= 0) { removeEvidence(evidenceContextIdx); }
                hideEvidenceContextMenu();
            });
        }

        document.addEventListener('click', function() {
            hideEvidenceContextMenu();
        });
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') { hideEvidenceContextMenu(); }
        });
        evidenceContextMenuWired = true;
    }

    document.querySelectorAll('.evidence-row').forEach(function(row) {
        row.addEventListener('contextmenu', function(event) {
            event.preventDefault();
            var idxStr = row.getAttribute('data-evidence-idx');
            var idx = idxStr ? parseInt(idxStr, 10) : -1;
            if (idx >= 0) {
                if (evidenceSelectedIdxs.indexOf(idx) < 0) {
                    selectEvidence(idx);
                }
                showEvidenceContextMenu(event.clientX, event.clientY, idx);
            }
        });
        row.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                var idxStr = row.getAttribute('data-evidence-idx');
                var idx = idxStr ? parseInt(idxStr, 10) : -1;
                if (idx >= 0) { selectEvidence(idx, event); }
            }
        });
    });

}

function flashEvidenceCopyButton(idx) {
    var btn = document.getElementById('evidence-copy-url-' + idx);
    if (!btn) { return; }
    var original = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('copied');
    setTimeout(function() {
        btn.textContent = original || '⧉';
        btn.classList.remove('copied');
    }, 1100);
}

// ── Messages from extension ──────────────────────────────────
window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || !msg.command) { return; }

    if (msg.command === 'stepContent') {
        var n = msg.stepNumber;
        var loading = document.getElementById('step-loading-' + n);
        var body = document.getElementById('step-body-' + n);
        if (loading) { loading.style.display = 'none'; }
        if (body) { body.innerHTML = renderMarkdown(msg.content || ''); }
        stepLoaded[n] = true;
    }

    if (msg.command === 'evidenceContent') {
        var idx = evidencePendingIdx[msg.filename];
        if (idx === undefined) { return; }
        delete evidencePendingIdx[msg.filename];
        var loading = document.getElementById('evidence-detail-loading');
        var body = document.getElementById('evidence-detail-md');
        var raw = msg.content || '';
        var normalized = normalizeEvidenceContent(raw);
        evidenceLoaded[idx] = true;
        evidenceContentByIdx[idx] = normalized;
        evidenceRawContentByIdx[idx] = raw;
        if (loading) { loading.style.display = 'none'; }
        if (body && selectedEvidenceIdx === idx) {
            body.innerHTML = renderMarkdown(normalized);
        }
    }

    if (msg.command === 'saveError') {
        console.error('Save error:', msg.error);
    }

    if (msg.command === 'copyPlanIdResult') {
        var copyBtn = document.getElementById('copy-plan-id-btn');
        if (!copyBtn) { return; }
        var original = copyBtn.textContent;
        copyBtn.textContent = msg.ok ? '✓' : '!';
        setTimeout(function() {
            copyBtn.textContent = original || '⧉';
        }, 1200);
    }

    if (msg.command === 'copyEvidenceResult') {
        if (msg.ok && typeof msg.idx === 'number') {
            if (msg.kind === 'url') {
                flashEvidenceCopyButton(msg.idx);
            }
            return;
        }
        console.error('Evidence copy failed:', msg.kind);
    }

    if (msg.command === 'removeEvidenceResult') {
        if (msg.ok) {
            applyEvidenceRemoval(msg.removed);
            return;
        }
        if (!msg.ok && !msg.cancelled) {
            console.error('Evidence remove failed');
        }
    }

    if (msg.command === 'evidenceRemovalPending') {
        setEvidenceRemovalPending(!!msg.pending, msg.filenames || []);
    }

    if (msg.command === 'projectMetaUpdated') {
        updateProjectMeta(msg.project || null, msg.projectPath || '', msg.repoUrl || '');
    }

    if (msg.command === 'planTitleUpdated') {
        var titleText = typeof msg.title === 'string' ? msg.title.trim() : '';
        var titleEl = document.getElementById('plan-title-text');
        if (titleEl && titleText) {
            titleEl.textContent = titleText;
            titleEl.setAttribute('title', 'Click to rename plan');
        }
    }
});

wireEvidenceRowContextMenu();
if (Array.isArray(evidenceEntries) && evidenceEntries.length > 0) {
    selectEvidence(0);
}
</script>
</body>
</html>`;
    }
}
