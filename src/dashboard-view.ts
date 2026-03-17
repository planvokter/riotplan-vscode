/**
 * Dashboard View Provider
 *
 * A WebviewPanel that shows all RiotPlan plans in a color-coded table
 * grouped by lifecycle stage (Idea, Shaping, Built, Executing, Done).
 * Inspired by Protokoll's dashboard design.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { HttpMcpClient } from './mcp-client';
import { UNASSIGNED_PROJECT_FILTER, type PlanSortOrder } from './plans-provider';

type PlanCategory = 'active' | 'done' | 'hold';

interface WebviewMessage {
    type: string;
    planRef?: string;
}

interface PlanSummary {
    ref: string;
    uuid?: string;
    id?: string;
    path: string;
    code: string;
    name: string;
    stage: string;
    status: string;
    progress?: { completed: number; total: number; percentage: number };
    lastUpdated?: string;
    category?: PlanCategory;
    project?: { id?: string; name?: string };
}

interface DashboardFilterState {
    projectFilter?: string;
    statuses: PlanCategory[];
    sortOrder: PlanSortOrder;
}

export class DashboardViewProvider {
    public static readonly viewType = 'riotplan.dashboard';

    private _panel: vscode.WebviewPanel | null = null;
    private _mcpClient: Pick<HttpMcpClient, 'listPlans'> | null = null;
    private _unsubscribeNotification?: () => void;
    private _watchdogTimer?: ReturnType<typeof setInterval>;
    private _debounceTimer?: ReturnType<typeof setTimeout>;
    private _filters: DashboardFilterState = {
        statuses: ['active', 'done', 'hold'],
        sortOrder: 'name-asc',
    };

    constructor(private readonly _extensionUri: vscode.Uri) {}

    setClient(client: HttpMcpClient | Pick<HttpMcpClient, 'listPlans'>): void {
        this._unregisterHandlers();
        this._mcpClient = client;
        const notificationCapableClient = client as HttpMcpClient;
        if (typeof notificationCapableClient.onNotification === 'function') {
            this._unsubscribeNotification = notificationCapableClient.onNotification(
                'notifications/resource_changed',
                () => {
                    if (this._panel?.visible) {
                        this._scheduleDebouncedRefresh();
                        this._startWatchdog();
                    }
                }
            );
        }
    }

    async show(): Promise<void> {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
        } else {
            this._panel = vscode.window.createWebviewPanel(
                DashboardViewProvider.viewType,
                'RiotPlan Dashboard',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this._extensionUri],
                }
            );
            this._panel.iconPath = new vscode.ThemeIcon('project');

            this._panel.webview.html = this._getHtml();

            this._panel.webview.onDidReceiveMessage(
                async (message: WebviewMessage) => {
                    await this._handleWebviewMessage(message);
                },
                null
            );

            this._panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.visible) {
                    this._scheduleDebouncedRefresh();
                    this._startWatchdog();
                } else {
                    this._clearWatchdog();
                }
            });

            this._panel.onDidDispose(() => {
                this._clearAllTimers();
                this._unregisterHandlers();
                this._panel = null;
            });
        }

        await this._refreshData();
        this._startWatchdog();
    }

    postMessage(message: unknown): void {
        this._panel?.webview.postMessage(message);
    }

    async refreshData(): Promise<void> {
        await this._refreshData();
    }

    setFilters(next: DashboardFilterState): void {
        this._filters = {
            projectFilter: next.projectFilter?.trim().toLowerCase() || undefined,
            statuses: next.statuses.length > 0 ? [...next.statuses] : ['active', 'done', 'hold'],
            sortOrder: next.sortOrder,
        };
        if (this._panel?.visible) {
            void this._refreshData();
        }
    }

    private _startWatchdog(): void {
        this._clearWatchdog();
        this._watchdogTimer = setInterval(() => {
            if (this._panel?.visible) {
                void this._refreshData();
            }
        }, 120_000);
    }

    private _clearWatchdog(): void {
        if (this._watchdogTimer) {
            clearInterval(this._watchdogTimer);
            this._watchdogTimer = undefined;
        }
    }

    private _clearAllTimers(): void {
        this._clearWatchdog();
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = undefined;
        }
    }

    private _scheduleDebouncedRefresh(): void {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(async () => {
            this._debounceTimer = undefined;
            await this._refreshData();
        }, 500);
    }

    private _unregisterHandlers(): void {
        this._unsubscribeNotification?.();
        this._unsubscribeNotification = undefined;
    }

    private async _refreshData(): Promise<void> {
        if (!this._mcpClient || !this._panel) {
            return;
        }

        try {
            const plans = await this._fetchPlans();
            this.postMessage({ type: 'update-plans', data: plans });
        } catch (err) {
            console.error('RiotPlan: [DASHBOARD] Failed to refresh data:', err);
        }
    }

    private async _fetchPlans(): Promise<{
        totalCount: number;
        dateGroups: Array<{ dayKey: string; label: string; plans: PlanSummary[]; sortValue: number }>;
    }> {
        if (!this._mcpClient) {
            return { totalCount: 0, dateGroups: [] };
        }

        try {
            const result = await this._mcpClient.listPlans('all');
            const plansData = result?.content?.[0]?.text;
            if (!plansData) {
                return { totalCount: 0, dateGroups: [] };
            }

            const parsed = JSON.parse(plansData);
            const plans: PlanSummary[] = (parsed.plans || []).map((p: any) => ({
                ref: p.uuid || p.id || p.path || p.code || p.name || '',
                uuid: p.uuid,
                id: p.id,
                path: p.path || p.code,
                code: toSafePlanCode(p),
                name: resolvePlanTitle(p),
                stage: normalizeStage(p.stage),
                status: normalizeStatus(p.status, p.stage),
                progress: p.progress,
                lastUpdated: p.lastUpdated || p.updatedAt || p.createdAt,
                category: getPlanCategory(p),
                project: p.project,
            }))
                .filter((plan: PlanSummary) => this._matchesProjectFilter(plan))
                .filter((plan: PlanSummary) => this._filters.statuses.includes(plan.category || 'active'));

            const sorted = [...plans].sort((a, b) => this._comparePlans(a, b));
            const grouped = groupPlansByDay(sorted);

            return { totalCount: plans.length, dateGroups: grouped };
        } catch (err) {
            console.error('RiotPlan: [DASHBOARD] Failed to fetch plans:', err);
            return { totalCount: 0, dateGroups: [] };
        }
    }

    private async _handleWebviewMessage(message: WebviewMessage): Promise<void> {
        switch (message.type) {
            case 'refresh':
                await this._refreshData();
                break;

            case 'open-plan':
                if (message.planRef) {
                    await vscode.commands.executeCommand('riotplan.openPlan', message.planRef);
                }
                break;

            case 'create-plan':
                await vscode.commands.executeCommand('riotplan.addPlan');
                break;

            case 'filter':
                await vscode.commands.executeCommand('riotplan.filterPlansByProject');
                break;

            case 'filter-status':
                await vscode.commands.executeCommand('riotplan.filterPlansByStatus');
                break;
        }
    }

    private _matchesProjectFilter(plan: PlanSummary): boolean {
        if (!this._filters.projectFilter) {
            return true;
        }
        if (this._filters.projectFilter === UNASSIGNED_PROJECT_FILTER) {
            return !hasAssignedProject(plan);
        }
        const needle = this._filters.projectFilter;
        const projectId = String(plan.project?.id || '').toLowerCase();
        const projectName = String(plan.project?.name || '').toLowerCase();
        return projectId.includes(needle) || projectName.includes(needle);
    }

    private _comparePlans(left: PlanSummary, right: PlanSummary): number {
        const leftName = String(left?.name || '').toLowerCase();
        const rightName = String(right?.name || '').toLowerCase();
        const leftStage = String(left?.stage || '').toLowerCase();
        const rightStage = String(right?.stage || '').toLowerCase();
        const leftProgress = Number(left?.progress?.percentage ?? 0);
        const rightProgress = Number(right?.progress?.percentage ?? 0);

        switch (this._filters.sortOrder) {
            case 'name-desc':
                return rightName.localeCompare(leftName);
            case 'stage-asc':
                return leftStage.localeCompare(rightStage) || leftName.localeCompare(rightName);
            case 'progress-desc':
                return rightProgress - leftProgress || leftName.localeCompare(rightName);
            case 'progress-asc':
                return leftProgress - rightProgress || leftName.localeCompare(rightName);
            case 'name-asc':
            default:
                return leftName.localeCompare(rightName);
        }
    }

    private _getHtml(): string {
        const nonce = randomUUID().replace(/-/g, '');

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'nonce-${nonce}';
                 style-src 'unsafe-inline';">
  <title>RiotPlan Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      padding: 20px 28px;
    }

    #app { max-width: 1200px; }

    .dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    }

    .dashboard-header h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -.3px;
    }

    .header-actions { display: flex; gap: 8px; align-items: center; }

    .btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 5px 12px;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }

    .btn-secondary {
      background: transparent;
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    }
    .btn-secondary:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1));
    }

    .total-badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 10px;
      border-radius: 10px;
      font-size: 12px;
      margin-left: 12px;
    }

    .date-section {
      margin-bottom: 24px;
    }

    .date-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12));
    }

    .date-header h2 {
      font-size: 14px;
      font-weight: 600;
      margin: 0;
    }

    .date-count {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .plans-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .plans-table th {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-widget-border);
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .plans-table td {
      padding: 10px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }

    .plan-row {
      cursor: pointer;
      transition: background 0.1s;
    }

    .plan-row:hover td {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }

    .plan-name {
      font-weight: 500;
      color: var(--vscode-editor-foreground);
    }

    .progress-bar {
      width: 100px;
      height: 6px;
      background: var(--vscode-progressBar-background, rgba(255,255,255,0.1));
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .progress-idea { background: #4fc3f7; }
    .progress-shaping { background: #ce93d8; }
    .progress-built { background: #ffb74d; }
    .progress-executing { background: #fff176; }
    .progress-done { background: #81c784; }

    .progress-text {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .stage-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 500;
      text-transform: capitalize;
      color: var(--vscode-editor-foreground);
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--vscode-descriptionForeground);
    }

    .empty-icon {
      font-size: 48px;
      opacity: 0.3;
      margin-bottom: 16px;
    }

    .placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 24px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="app">
    <header class="dashboard-header">
      <div style="display:flex;align-items:center">
        <h1>RiotPlan Dashboard</h1>
        <span class="total-badge" id="total-count">0 plans</span>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary" id="filter-btn" title="Filter by project">⛃ Filter</button>
        <button class="btn btn-secondary" id="filter-status-btn" title="Filter by status">☰ Status</button>
        <button class="btn btn-secondary" id="refresh-btn" title="Refresh data">↺ Refresh</button>
        <button class="btn" id="create-btn" title="Create a new plan">+ New Plan</button>
      </div>
    </header>

    <div id="plans-container">
      <div class="placeholder">Loading plans…</div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('refresh-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    document.getElementById('filter-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'filter' });
    });
    document.getElementById('filter-status-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'filter-status' });
    });

    document.getElementById('create-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'create-plan' });
    });

    const STAGE_COLORS = {
      'idea': '#4fc3f7',
      'shaping': '#ce93d8',
      'built': '#ffb74d',
      'executing': '#fff176',
      'done': '#81c784',
      'cancelled': '#e57373'
    };

    function formatTime(iso) {
      if (!iso) return '—';
      try {
        const diffMs = Date.now() - new Date(iso).getTime();
        if (isNaN(diffMs)) return iso;
        const diffMin = Math.round(diffMs / 60000);
        if (diffMin < 2) return 'just now';
        if (diffMin < 60) return diffMin + ' min ago';
        const diffHrs = Math.round(diffMin / 60);
        if (diffHrs < 24) return diffHrs + ' hr' + (diffHrs === 1 ? '' : 's') + ' ago';
        const diffDays = Math.round(diffHrs / 24);
        if (diffDays < 7) return diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' ago';
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      } catch {
        return iso;
      }
    }

    function openPlan(planRef) {
      vscode.postMessage({ type: 'open-plan', planRef: planRef });
    }

    function renderPlans(data) {
      const container = document.getElementById('plans-container');
      const totalBadge = document.getElementById('total-count');

      if (!data || data.totalCount === 0) {
        totalBadge.textContent = '0 plans';
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">☆</div><p>No plans found</p><p style="margin-top:8px;font-size:12px">Create your first plan to get started</p></div>';
        return;
      }

      totalBadge.textContent = data.totalCount + ' plan' + (data.totalCount === 1 ? '' : 's');

      let html = '';
      const dateGroups = Array.isArray(data.dateGroups) ? data.dateGroups : [];
      for (const dayGroup of dateGroups) {
        const plans = Array.isArray(dayGroup.plans) ? dayGroup.plans : [];

        html += '<div class="date-section">';
        html += '<div class="date-header">';
        html += '<h2>' + escapeHtml(dayGroup.label || 'Unknown date') + '</h2>';
        html += '<span class="date-count">' + plans.length + '</span>';
        html += '</div>';

        html += '<table class="plans-table">';
        html += '<thead><tr><th>Plan</th><th>Stage</th><th>Progress</th><th>Updated</th></tr></thead>';
        html += '<tbody>';

        for (const plan of plans) {
          const planRef = plan.ref || plan.uuid || plan.id || plan.path || plan.code || plan.name || '';
          const pct = plan.progress ? plan.progress.percentage : 0;
          const normalizedStage = String(plan.stage || '').toLowerCase();
          const progressClass = 'progress-' + normalizedStage;
          const stageColor = STAGE_COLORS[normalizedStage] || '#9e9e9e';

          html += '<tr class="plan-row"';
          if (planRef) {
            html += ' data-plan-ref="' + escapeAttr(planRef) + '"';
          }
          html += '>';

          html += '<td>';
          html += '<div class="plan-name">' + escapeHtml(plan.name) + '</div>';
          html += '</td>';

          html += '<td><span class="stage-pill" style="background:' + escapeAttr(stageColor + '33') + ';border:1px solid ' + escapeAttr(stageColor + '80') + ';">' + escapeHtml(plan.stage || 'unknown') + '</span></td>';

          html += '<td>';
          if (plan.progress && plan.progress.total > 0) {
            html += '<div class="progress-bar"><div class="progress-fill ' + progressClass + '" style="width:' + pct + '%"></div></div>';
            html += '<div class="progress-text">' + plan.progress.completed + '/' + plan.progress.total + ' steps</div>';
          } else {
            html += '<span class="time">' + escapeHtml(plan.status || '—') + '</span>';
          }
          html += '</td>';

          html += '<td class="time">' + formatTime(plan.lastUpdated) + '</td>';
          html += '</tr>';
        }

        html += '</tbody></table></div>';
      }

      container.innerHTML = html;
      container.querySelectorAll('tr.plan-row[data-plan-ref]').forEach((row) => {
        row.addEventListener('click', () => {
          const planRef = row.getAttribute('data-plan-ref');
          if (planRef) {
            openPlan(planRef);
          }
        });
      });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update-plans') {
        renderPlans(msg.data);
      }
    });
  </script>
</body>
</html>`;
    }
}

function resolvePlanTitle(plan: any): string {
    const direct = firstNonEmptyString(plan?.title, plan?.name);
    if (direct) {
        return stripUuidPrefix(direct);
    }
    const fallback = firstNonEmptyString(plan?.code, plan?.id, plan?.path);
    if (fallback) {
        return stripUuidPrefix(basename(fallback));
    }
    return 'Untitled Plan';
}

function toSafePlanCode(plan: any): string {
    const raw = firstNonEmptyString(plan?.code, plan?.id, plan?.path);
    if (!raw) {
        return 'plan';
    }
    return stripUuidPrefix(basename(raw));
}

function groupPlansByDay(
    plans: PlanSummary[]
): Array<{ dayKey: string; label: string; plans: PlanSummary[]; sortValue: number }> {
    const groups = new Map<string, { dayKey: string; label: string; plans: PlanSummary[]; sortValue: number }>();

    for (const plan of plans) {
        const modifiedAt = parsePlanModifiedDate(plan.lastUpdated);
        const dayKey = modifiedAt ? toLocalDayKey(modifiedAt) : 'unknown';
        const label = modifiedAt ? formatDayLabel(modifiedAt) : 'Unknown date';
        const sortValue = modifiedAt ? toDaySortValue(modifiedAt) : Number.NEGATIVE_INFINITY;
        const current = groups.get(dayKey) || { dayKey, label, plans: [], sortValue };
        current.plans.push(plan);
        current.sortValue = Math.max(current.sortValue, sortValue);
        groups.set(dayKey, current);
    }

    return [...groups.values()].sort((left, right) => right.sortValue - left.sortValue);
}

function parsePlanModifiedDate(value: unknown): Date | undefined {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toLocalDayKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function toDaySortValue(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatDayLabel(date: Date): string {
    return new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    }).format(date);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

function basename(value: string): string {
    const parts = value.split(/[\\/]+/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : value;
}

function stripUuidPrefix(value: string): string {
    return value.replace(/^[0-9a-f]{8,}-/i, '').trim() || value;
}

function normalizeStage(stage: unknown): string {
    if (typeof stage !== 'string' || !stage.trim()) {
        return 'unknown';
    }
    const normalized = stage.toLowerCase();
    if (normalized === 'completed') {
        return 'done';
    }
    return normalized;
}

function normalizeStatus(status: unknown, stage: unknown): string {
    if (typeof status === 'string' && status.trim()) {
        return status;
    }
    if (typeof stage === 'string' && stage.trim()) {
        return stage;
    }
    return 'unknown';
}

function getPlanCategory(plan: any): PlanCategory {
    const explicitCategory = typeof plan?.category === 'string' ? plan.category.toLowerCase() : '';
    if (explicitCategory === 'done' || explicitCategory === 'hold' || explicitCategory === 'active') {
        return explicitCategory;
    }
    const planPath = typeof plan?.path === 'string' ? plan.path : '';
    const parts = planPath.split(/[\\/]+/).map((segment: string) => segment.toLowerCase());
    if (parts.includes('done')) {
        return 'done';
    }
    if (parts.includes('hold')) {
        return 'hold';
    }
    return 'active';
}

function hasAssignedProject(plan: PlanSummary): boolean {
    const projectId = String(plan.project?.id || '').trim();
    const projectName = String(plan.project?.name || '').trim();
    return projectId.length > 0 || projectName.length > 0;
}
