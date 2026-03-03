import * as vscode from 'vscode';
import { HttpMcpClient } from './mcp-client';

interface ProjectLike {
    id?: string;
    name?: string;
    active?: boolean;
    repo?: {
        provider?: string;
        owner?: string;
        name?: string;
        url?: string;
    };
    [key: string]: unknown;
}

interface ProjectMatchInput {
    id?: string;
    name?: string;
    repo?: {
        provider?: string;
        owner?: string;
        name?: string;
        url?: string;
    };
}

interface PlanLike {
    id?: string;
    uuid?: string;
    code?: string;
    name?: string;
    stage?: string;
    status?: string;
    project?: ProjectMatchInput;
    path?: string;
    [key: string]: unknown;
}

export function getPlanNavigationRef(plan: PlanLike): string {
    const candidates = [plan.path, plan.id, plan.code, plan.uuid];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return '';
}

function normalize(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : undefined;
}

function buildRepoKey(provider: string, owner: string, repoName: string): string {
    return `${provider}:${owner}/${repoName}`;
}

function extractRepoMatchKeys(repo?: ProjectMatchInput['repo']): Set<string> {
    const keys = new Set<string>();
    if (!repo) {
        return keys;
    }

    const provider = normalize(repo.provider) || 'github';
    const owner = normalize(repo.owner);
    const repoName = normalize(repo.name);
    if (owner && repoName) {
        keys.add(`${owner}/${repoName}`);
        keys.add(buildRepoKey(provider, owner, repoName));
    }

    const url = normalize(repo.url);
    if (url) {
        const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
        if (sshMatch) {
            const hostProvider = normalize(sshMatch[1]?.includes('github') ? 'github' : sshMatch[1]) || provider;
            const sshOwner = normalize(sshMatch[2]);
            const sshRepo = normalize(sshMatch[3]);
            if (sshOwner && sshRepo) {
                keys.add(`${sshOwner}/${sshRepo}`);
                keys.add(buildRepoKey(hostProvider, sshOwner, sshRepo));
            }
        }

        const httpMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
        if (httpMatch) {
            const hostProvider = normalize(httpMatch[1]?.includes('github') ? 'github' : httpMatch[1]) || provider;
            const httpOwner = normalize(httpMatch[2]);
            const httpRepo = normalize(httpMatch[3]);
            if (httpOwner && httpRepo) {
                keys.add(`${httpOwner}/${httpRepo}`);
                keys.add(buildRepoKey(hostProvider, httpOwner, httpRepo));
            }
        }
    }

    return keys;
}

function extractProjectMatchKeys(project: ProjectMatchInput | undefined, fallbackId?: string): Set<string> {
    const keys = new Set<string>();
    const fallback = normalize(fallbackId);
    if (fallback) {
        keys.add(fallback);
    }
    const id = normalize(project?.id);
    if (id) {
        keys.add(id);
    }
    const name = normalize(project?.name);
    if (name) {
        keys.add(name);
    }
    for (const key of extractRepoMatchKeys(project?.repo)) {
        keys.add(key);
    }
    return keys;
}

export function projectMatchesPlan(project: ProjectLike | null | undefined, fallbackProjectId: string, plan: PlanLike): boolean {
    const projectKeys = extractProjectMatchKeys(project || undefined, fallbackProjectId);
    if (projectKeys.size === 0) {
        return false;
    }
    const planKeys = extractProjectMatchKeys(plan.project);
    if (planKeys.size === 0) {
        return false;
    }
    for (const key of planKeys) {
        if (projectKeys.has(key)) {
            return true;
        }
    }
    return false;
}

export class ProjectDetailPanel {
    private static readonly viewType = 'riotplan.projectDetail';
    private static readonly panels = new Map<string, ProjectDetailPanel>();

    static createOrShow(projectId: string, client: HttpMcpClient, initialProject?: ProjectLike): void {
        const existing = this.panels.get(projectId);
        if (existing) {
            existing.updateClient(client);
            existing.panel.reveal(vscode.ViewColumn.Beside);
            void existing.refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            this.viewType,
            initialProject?.name || projectId,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        const instance = new ProjectDetailPanel(panel, projectId, client, initialProject);
        this.panels.set(projectId, instance);
    }

    static updateClientForAll(client: HttpMcpClient): void {
        for (const panel of this.panels.values()) {
            panel.updateClient(client);
        }
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly projectId: string,
        private client: HttpMcpClient,
        private initialProject?: ProjectLike
    ) {
        this.panel.onDidDispose(() => {
            ProjectDetailPanel.panels.delete(this.projectId);
        });
        this.panel.webview.onDidReceiveMessage(async (message: { type?: string; planRef?: string }) => {
            if (message.type === 'refresh') {
                await this.refresh();
                return;
            }
            if (message.type === 'open-plan' && message.planRef) {
                await vscode.commands.executeCommand('riotplan.openPlan', message.planRef);
            }
        });
        void this.refresh();
    }

    private updateClient(client: HttpMcpClient): void {
        this.client = client;
    }

    private async refresh(): Promise<void> {
        this.panel.webview.html = this.getLoadingHtml();
        try {
            const project = await this.loadProject();
            const plans = await this.loadRelatedPlans(project);
            const displayName = project?.name || project?.id || this.projectId;
            this.panel.title = `Project: ${displayName}`;
            this.panel.webview.html = this.getHtml(project, plans);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.panel.webview.html = this.getErrorHtml(msg);
        }
    }

    private async loadProject(): Promise<ProjectLike | null> {
        const project = await this.client.getContextProject(this.projectId);
        if (project) {
            this.initialProject = project;
            return project;
        }
        return this.initialProject || { id: this.projectId, name: this.projectId };
    }

    private async loadRelatedPlans(project: ProjectLike | null): Promise<PlanLike[]> {
        const result = await this.client.listPlans('all');
        const content = result?.content?.[0];
        if (content?.type !== 'text') {
            return [];
        }
        const parsed = JSON.parse(content.text);
        const plans = Array.isArray(parsed?.plans) ? parsed.plans : [];
        const filtered = plans.filter((plan: PlanLike) => {
            return projectMatchesPlan(project, this.projectId, plan);
        });
        return filtered.sort((a: PlanLike, b: PlanLike) => {
            const aName = String(a.name || a.code || a.id || a.uuid || '').toLowerCase();
            const bName = String(b.name || b.code || b.id || b.uuid || '').toLowerCase();
            return aName.localeCompare(bName);
        });
    }

    private esc(value: unknown): string {
        if (typeof value !== 'string') {
            return '';
        }
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 20px;">Loading project…</body></html>`;
    }

    private getErrorHtml(error: string): string {
        return `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-errorForeground); background: var(--vscode-editor-background); padding: 20px;">Failed to load project: ${this.esc(error)}</body></html>`;
    }

    private getHtml(project: ProjectLike | null, plans: PlanLike[]): string {
        const projectName = this.esc(project?.name || project?.id || this.projectId);
        const projectId = this.esc(project?.id || this.projectId);
        const active = project?.active === false ? 'Inactive' : 'Active';
        const repoUrl = typeof project?.repo?.url === 'string' ? project.repo.url : '';
        const repoLabel = repoUrl ? this.esc(repoUrl) : '—';

        const rows = plans
            .map((plan) => {
                const ref = getPlanNavigationRef(plan);
                const name = this.esc(plan.name || plan.code || plan.id || plan.uuid || 'Untitled Plan');
                const code = this.esc(plan.code || plan.id || plan.uuid || '');
                const stage = this.esc(plan.stage || plan.status || 'unknown');
                const refEsc = this.esc(ref);
                return `<tr class="row" data-plan-ref="${refEsc}"><td>${name}<div class="code">${code}</div></td><td>${stage}</td></tr>`;
            })
            .join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); margin: 0; padding: 18px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .btn { border: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-editor-foreground); border-radius: 4px; padding: 4px 9px; cursor: pointer; }
    .meta { margin-bottom: 16px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .meta-row { margin-bottom: 5px; }
    .meta-row a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .meta-row a:hover { text-decoration: underline; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--vscode-widget-border); padding: 8px 6px; }
    th { font-size: 11px; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .row { cursor: pointer; }
    .row:hover td { background: var(--vscode-list-hoverBackground); }
    .code { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 8px 0; }
  </style>
</head>
<body>
  <div class="header">
    <h2 style="margin:0">${projectName}</h2>
    <button class="btn" id="refresh">Refresh</button>
  </div>
  <div class="meta">
    <div class="meta-row">ID: <strong>${projectId}</strong></div>
    <div class="meta-row">Status: ${active}</div>
    <div class="meta-row">Repo: ${repoUrl ? `<a href="${this.esc(repoUrl)}">${repoLabel}</a>` : repoLabel}</div>
  </div>
  <h3 style="margin: 0 0 8px 0; font-size: 13px;">Related Plans (${plans.length})</h3>
  ${
    plans.length > 0
        ? `<table><thead><tr><th>Plan</th><th>Stage</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="empty">No plans are bound to this project.</div>`
}
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    document.querySelectorAll('tr.row[data-plan-ref]').forEach((row) => {
      row.addEventListener('click', () => {
        const ref = row.getAttribute('data-plan-ref');
        if (ref) vscode.postMessage({ type: 'open-plan', planRef: ref });
      });
    });
  </script>
</body>
</html>`;
    }
}
