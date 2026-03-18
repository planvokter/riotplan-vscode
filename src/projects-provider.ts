import * as vscode from 'vscode';
import { HttpMcpClient, isUnauthorizedError } from './mcp-client';

interface ContextProject {
    id?: string;
    name?: string;
    active?: boolean;
    [key: string]: unknown;
}

export class ProjectItem extends vscode.TreeItem {
    constructor(public readonly project: ContextProject) {
        const label = String(project.name || project.id || 'Unnamed project');
        super(label, vscode.TreeItemCollapsibleState.None);
        const id = String(project.id || '').trim();
        const status = project.active === false ? 'Inactive' : 'Active';
        this.description = id && id !== label ? `${status} · ${id}` : status;
        this.tooltip = id ? `${label} (${id})` : label;
        this.contextValue = 'project';
        this.iconPath =
            project.active === false
                ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'))
                : new vscode.ThemeIcon('project', new vscode.ThemeColor('charts.blue'));
        this.command = {
            command: 'riotplan.openProjectEntity',
            title: 'Open Project Details',
            arguments: [project],
        };
    }
}

export class ProjectsTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ProjectItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private mcpClient: HttpMcpClient) {}

    updateClient(client: HttpMcpClient): void {
        this.mcpClient = client;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ProjectItem): vscode.TreeItem {
        return element;
    }

    async getChildren(): Promise<ProjectItem[]> {
        try {
            const projects = await this.mcpClient.listContextProjects(true);
            return [...projects]
                .sort((left: ContextProject, right: ContextProject) => {
                    const leftName = String(left?.name || left?.id || '').toLowerCase();
                    const rightName = String(right?.name || right?.id || '').toLowerCase();
                    return leftName.localeCompare(rightName);
                })
                .map((project: ContextProject) => new ProjectItem(project));
        } catch (error) {
            if (isUnauthorizedError(error)) {
                return [];
            }
            console.error('Failed to load projects:', error);
            return [];
        }
    }
}
