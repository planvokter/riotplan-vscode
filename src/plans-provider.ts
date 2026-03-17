/**
 * Plans Tree Provider
 *
 * Provides tree view of plans from RiotPlan HTTP MCP server
 */

import * as vscode from 'vscode';
import { HttpMcpClient } from './mcp-client';

export type PlanCategory = 'active' | 'done' | 'hold';
export type PlanSortOrder = 'name-asc' | 'name-desc' | 'stage-asc' | 'progress-desc' | 'progress-asc';
export const UNASSIGNED_PROJECT_FILTER = '__riotplan_unassigned__';
const TREE_MIME = 'application/vnd.code.tree.riotplan-plans';

export class PlanItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly category?: PlanCategory,
        public readonly dayKey?: string,
        public readonly path?: string,
        public readonly uuid?: string,
        public readonly planId?: string,
        public readonly stage?: string,
        public readonly progress?: { completed: number; total: number; percentage: number },
        public readonly project?: any,
        public readonly serverName?: string,
        public readonly itemCount?: number
    ) {
        super(label, collapsibleState);

        if (path || uuid || planId) {
            this.tooltip = serverName ? `${label} (${serverName})` : label;
            const projectLabel = project?.name || project?.id || 'Unassigned';
            const serverPrefix = serverName ? `${serverName} · ` : '';
            this.description = `${serverPrefix}${projectLabel}`;
            this.iconPath = stageThemeIcon(stage);
            this.contextValue = 'plan';
            this.command = {
                command: 'riotplan.openPlan',
                title: 'Open Plan',
                arguments: [this],
            };

            if (progress) {
                this.description = `${serverPrefix}${progress.percentage}% · ${projectLabel}`;
            }
        } else if (category && dayKey) {
            this.contextValue = 'plan-day-group';
            this.iconPath = new vscode.ThemeIcon('history');
            if (typeof itemCount === 'number' && itemCount > 0) {
                this.description = String(itemCount);
            }
        } else if (category) {
            this.contextValue = 'plan-category';
            if (typeof itemCount === 'number' && itemCount > 0) {
                this.description = String(itemCount);
            }
        }
    }
}

export class PlansTreeProvider implements vscode.TreeDataProvider<PlanItem>, vscode.TreeDragAndDropController<PlanItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<PlanItem | undefined | null | void> =
        new vscode.EventEmitter<PlanItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PlanItem | undefined | null | void> =
        this._onDidChangeTreeData.event;
    readonly dragMimeTypes = [TREE_MIME];
    readonly dropMimeTypes = [TREE_MIME];
    private projectFilter: string | undefined;
    private visibleCategories: Set<PlanCategory> = new Set(['active', 'done', 'hold']);
    private sortOrder: PlanSortOrder = 'name-asc';

    constructor(private mcpClient: HttpMcpClient) {}

    updateClient(client: HttpMcpClient): void {
        this.mcpClient = client;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setProjectFilter(value: string | undefined): void {
        this.projectFilter = value?.trim().toLowerCase() || undefined;
        this.refresh();
    }

    setStatusFilter(categories: PlanCategory[]): void {
        if (categories.length === 0) {
            this.visibleCategories = new Set(['active', 'done', 'hold']);
        } else {
            this.visibleCategories = new Set(categories);
        }
        this.refresh();
    }

    setSortOrder(order: PlanSortOrder): void {
        this.sortOrder = order;
        this.refresh();
    }

    getProjectFilter(): string | undefined {
        return this.projectFilter;
    }

    getStatusFilter(): PlanCategory[] {
        return [...this.visibleCategories];
    }

    getSortOrder(): PlanSortOrder {
        return this.sortOrder;
    }

    getTreeItem(element: PlanItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PlanItem): Promise<PlanItem[]> {
        if (!element) {
            // Root level - show categories based on status filter.
            const categories: Array<{ label: string; category: PlanCategory }> = [
                { label: 'Active', category: 'active' },
                { label: 'Done', category: 'done' },
                { label: 'Hold', category: 'hold' },
            ];
            const visible = categories.filter((entry) => this.visibleCategories.has(entry.category));
            if (visible.length === 0) {
                return [];
            }
            const categoryCounts = await Promise.all(
                visible.map(async (entry) => ({
                    ...entry,
                    count: (await this.fetchPlans(entry.category)).length,
                }))
            );
            return categoryCounts.map(
                (entry, index) =>
                    new PlanItem(
                        entry.label,
                        index === 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                        entry.category,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        entry.count
                    )
            );
        }

        // Day-group level - show plans for the selected day bucket.
        if (element.contextValue === 'plan-day-group' && element.category && element.dayKey) {
            try {
                const category = element.category;
                const plans = await this.fetchPlans(category);
                const groups = this.groupPlansByDay(plans);
                const group = groups.find((entry) => entry.dayKey === element.dayKey);
                if (!group) {
                    return [];
                }
                return group.plans.map((plan: any) => this.toPlanItem(plan, category));
            } catch (error) {
                console.error('Failed to load plans:', error);
                return [];
            }
        }

        // Category level - show day groups.
        const category = element.category || this.resolveCategoryFromLabel(element.label);

        try {
            const plans = await this.fetchPlans(category);

            const groups = this.groupPlansByDay(plans);
            return groups.map(
                (group, index) =>
                    new PlanItem(
                        group.label,
                        index === 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
                        category,
                        group.dayKey,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        group.plans.length
                    )
            );
        } catch (error) {
            console.error('Failed to load plans:', error);
            return [];
        }
    }

    async handleDrag(
        source: readonly PlanItem[],
        dataTransfer: vscode.DataTransfer
    ): Promise<void> {
        const draggable = source
            .filter((item) => item.contextValue === 'plan' && item.path)
            .map((item) => ({
                path: item.path!,
                uuid: item.uuid,
                planId: item.uuid || item.planId || item.path!,
                category: item.category || 'active',
                name: item.label,
            }));
        if (draggable.length === 0) {
            return;
        }
        dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(JSON.stringify(draggable)));
    }

    async handleDrop(
        target: PlanItem | undefined,
        dataTransfer: vscode.DataTransfer
    ): Promise<void> {
        const targetCategory = this.resolveDropCategory(target);
        if (!targetCategory) {
            return;
        }

        const transferItem = dataTransfer.get(TREE_MIME);
        if (!transferItem) {
            return;
        }

        const rawText = await this.readTransferText(transferItem);
        if (!rawText) {
            return;
        }
        let dragged: Array<{
            path?: string;
            uuid?: string;
            planId: string;
            category: PlanCategory;
            name: string;
        }> = [];
        try {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed)) {
                dragged = parsed;
            }
        } catch {
            return;
        }

        const moved: string[] = [];
        const skipped: string[] = [];
        const errors: string[] = [];

        for (const item of dragged) {
            if (!item?.planId) {
                continue;
            }
            if (item.category === targetCategory) {
                skipped.push(item.name || item.planId);
                continue;
            }
            try {
                await this.movePlanViaMcp(item, targetCategory);
                moved.push(item.name || item.planId);
            } catch (error) {
                const errText = error instanceof Error ? error.message : String(error);
                errors.push(`${item.name || item.planId}: ${errText}`);
            }
        }

        if (moved.length > 0) {
            const categoryName =
                targetCategory === 'done' ? 'Done' : targetCategory === 'hold' ? 'Hold' : 'Active';
            vscode.window.showInformationMessage(
                `Moved ${moved.length} plan${moved.length === 1 ? '' : 's'} to ${categoryName}.`
            );
            this.refresh();
        }
        if (skipped.length > 0 && moved.length === 0 && errors.length === 0) {
            vscode.window.showInformationMessage('Selected plans are already in that category.');
        }
        if (errors.length > 0) {
            const summary = errors.length === 1
                ? errors[0]
                : `${errors.length} plan(s) failed: ${errors.join('; ')}`;
            vscode.window.showErrorMessage(`Failed to move: ${summary}`);
            console.error('Failed to move plans:', errors);
        }
    }

    private async fetchPlans(category: PlanCategory): Promise<any[]> {
        const response = await this.mcpClient.listPlans(category);
        if (!response?.content?.length) {
            return [];
        }
        const content = response.content[0];
        if (content.type !== 'text') {
            return [];
        }
        const data = JSON.parse(content.text);
        const plans = data.plans || [];
        return plans
            .filter((plan: any) => this.getPlanCategory(plan) === category)
            .filter((plan: any) => this.matchesProjectFilter(plan))
            .sort((left: any, right: any) => this.comparePlans(left, right));
    }

    private matchesProjectFilter(plan: any): boolean {
        if (!this.projectFilter) {
            return true;
        }
        if (this.projectFilter === UNASSIGNED_PROJECT_FILTER) {
            return !hasAssignedProject(plan);
        }
        const projectId = String(plan?.project?.id || '').toLowerCase();
        const projectName = String(plan?.project?.name || '').toLowerCase();
        return projectId.includes(this.projectFilter) || projectName.includes(this.projectFilter);
    }

    private comparePlans(left: any, right: any): number {
        const leftName = this.resolvePlanTitle(left).toLowerCase();
        const rightName = this.resolvePlanTitle(right).toLowerCase();
        const leftStage = String(left?.stage || '').toLowerCase();
        const rightStage = String(right?.stage || '').toLowerCase();
        const leftProgress = Number(left?.progress?.percentage ?? 0);
        const rightProgress = Number(right?.progress?.percentage ?? 0);

        switch (this.sortOrder) {
            case 'name-desc':
                return rightName.localeCompare(leftName);
            case 'stage-asc': {
                const stageOrder = leftStage.localeCompare(rightStage);
                return stageOrder !== 0 ? stageOrder : leftName.localeCompare(rightName);
            }
            case 'progress-desc':
                return rightProgress - leftProgress || leftName.localeCompare(rightName);
            case 'progress-asc':
                return leftProgress - rightProgress || leftName.localeCompare(rightName);
            case 'name-asc':
            default:
                return leftName.localeCompare(rightName);
        }
    }

    private toPlanItem(plan: any, category: PlanCategory): PlanItem {
        return new PlanItem(
            this.resolvePlanTitle(plan),
            vscode.TreeItemCollapsibleState.None,
            category,
            undefined,
            plan.path,
            plan.uuid,
            plan.planId || plan.id,
            plan.stage,
            plan.progress,
            plan.project,
            plan.serverName
        );
    }

    private resolvePlanTitle(plan: any): string {
        const direct = this.firstNonEmptyString(plan?.title, plan?.name);
        if (direct) {
            return this.stripUuidPrefix(direct);
        }
        const fallback = this.firstNonEmptyString(plan?.code, plan?.id, plan?.path);
        if (fallback) {
            return this.stripUuidPrefix(this.basename(fallback));
        }
        return 'Untitled Plan';
    }

    private firstNonEmptyString(...values: unknown[]): string | undefined {
        for (const value of values) {
            if (typeof value === 'string' && value.trim()) {
                return value.trim();
            }
        }
        return undefined;
    }

    private basename(value: string): string {
        const parts = value.split(/[\\/]+/).filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : value;
    }

    private stripUuidPrefix(value: string): string {
        // Common RiotPlan filename format: "094f50cc-plan-title"
        return value.replace(/^[0-9a-f]{8,}-/i, '').trim() || value;
    }

    private groupPlansByDay(
        plans: any[]
    ): Array<{ dayKey: string; label: string; plans: any[]; sortValue: number }> {
        const groups = new Map<string, { dayKey: string; label: string; plans: any[]; sortValue: number }>();

        for (const plan of plans) {
            const modifiedDate = this.getPlanModifiedDate(plan);
            const dayKey = modifiedDate ? this.toLocalDayKey(modifiedDate) : 'unknown';
            const label = modifiedDate ? this.formatDayLabel(modifiedDate) : 'Unknown date';
            const sortValue = modifiedDate ? this.toDaySortValue(modifiedDate) : Number.NEGATIVE_INFINITY;

            const current = groups.get(dayKey) || {
                dayKey,
                label,
                plans: [],
                sortValue,
            };

            current.plans.push(plan);
            current.sortValue = Math.max(current.sortValue, sortValue);
            groups.set(dayKey, current);
        }

        return [...groups.values()].sort((left, right) => right.sortValue - left.sortValue);
    }

    private getPlanModifiedDate(plan: any): Date | undefined {
        const candidates = [plan?.lastUpdated, plan?.updatedAt, plan?.modifiedAt, plan?.mtime, plan?.createdAt];
        for (const candidate of candidates) {
            if (typeof candidate !== 'string' || !candidate.trim()) {
                continue;
            }
            const parsed = new Date(candidate);
            if (!Number.isNaN(parsed.getTime())) {
                return parsed;
            }
        }
        return undefined;
    }

    private toLocalDayKey(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    private toDaySortValue(date: Date): number {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    }

    private formatDayLabel(date: Date): string {
        return new Intl.DateTimeFormat(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        }).format(date);
    }

    private resolveCategoryFromLabel(label: string): PlanCategory {
        const normalized = label.toLowerCase();
        if (normalized === 'done') {
            return 'done';
        }
        if (normalized === 'hold') {
            return 'hold';
        }
        return 'active';
    }

    private getPlanCategory(plan: any): PlanCategory {
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

    private resolveDropCategory(target: PlanItem | undefined): PlanCategory | undefined {
        if (!target?.category) {
            return undefined;
        }
        if (target.category === 'active' || target.category === 'done' || target.category === 'hold') {
            return target.category;
        }
        return undefined;
    }

    private async movePlanViaMcp(
        item: { path?: string; uuid?: string; planId: string },
        destinationCategory: PlanCategory
    ): Promise<void> {
        const candidates = [item.path, item.uuid, item.planId].filter(
            (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0
        );
        const uniqueCandidates = [...new Set(candidates)];
        let lastError: Error | undefined;

        for (const candidate of uniqueCandidates) {
            try {
                const response = await this.mcpClient.movePlan(candidate, destinationCategory);
                if (response?.isError) {
                    const errorText = response?.content?.[0]?.text || 'MCP move tool returned an error.';
                    throw new Error(errorText);
                }
                const content = response?.content?.[0];
                if (content?.type !== 'text') {
                    return;
                }
                try {
                    const parsed = JSON.parse(content.text);
                    if (parsed?.moved === false || parsed?.moved === true) {
                        return;
                    }
                } catch {
                    // Non-JSON text is treated as a successful message from MCP.
                    return;
                }
            } catch (error) {
                const errText = error instanceof Error ? error.message : String(error);
                lastError = error instanceof Error ? error : new Error(errText);
                const missingPlan = /could not find plan/i.test(errText);
                if (!missingPlan) {
                    throw lastError;
                }
            }
        }

        if (lastError) {
            throw lastError;
        }
    }

    private async readTransferText(transferItem: vscode.DataTransferItem): Promise<string | undefined> {
        try {
            const raw = transferItem.value;
            if (typeof raw === 'string' && raw.length > 0) {
                return raw;
            }
        } catch {
            // Some VS Code versions/sources only expose data through asString().
        }

        try {
            const text = await transferItem.asString();
            return typeof text === 'string' && text.length > 0 ? text : undefined;
        } catch {
            return undefined;
        }
    }
}

function hasAssignedProject(plan: any): boolean {
    const projectId = String(plan?.project?.id || '').trim();
    const projectName = String(plan?.project?.name || '').trim();
    return projectId.length > 0 || projectName.length > 0;
}

function stageThemeIcon(stage?: string): vscode.ThemeIcon {
    const normalized = (stage || '').toLowerCase();
    switch (normalized) {
        case 'completed':
        case 'done':
            return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
        case 'executing':
            return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.blue'));
        case 'built':
            return new vscode.ThemeIcon('tools', new vscode.ThemeColor('charts.green'));
        case 'shaping':
            return new vscode.ThemeIcon('graph', new vscode.ThemeColor('charts.yellow'));
        case 'cancelled':
            return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
        case 'idea':
        default:
            return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('descriptionForeground'));
    }
}
