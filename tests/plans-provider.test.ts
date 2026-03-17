import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => {
    class EventEmitter<T> {
        event = (_listener: T) => ({ dispose: () => {} });
        fire = () => {};
    }
    class TreeItem {
        label: string;
        collapsibleState: number;
        tooltip?: string;
        description?: string;
        contextValue?: string;
        command?: unknown;
        iconPath?: unknown;
        constructor(label: string, collapsibleState: number) {
            this.label = label;
            this.collapsibleState = collapsibleState;
        }
    }
    class ThemeColor {
        id: string;
        constructor(id: string) {
            this.id = id;
        }
    }
    class ThemeIcon {
        id: string;
        color?: ThemeColor;
        constructor(id: string, color?: ThemeColor) {
            this.id = id;
            this.color = color;
        }
    }
    class DataTransferItem {
        value: unknown;
        constructor(value: unknown) {
            this.value = value;
        }
        async asString() {
            return String(this.value ?? '');
        }
    }
    class DataTransfer {
        private store = new Map<string, DataTransferItem>();
        set(mime: string, item: DataTransferItem) {
            this.store.set(mime, item);
        }
        get(mime: string) {
            return this.store.get(mime);
        }
    }
    const window = {
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
    };
    return {
        EventEmitter,
        TreeItem,
        ThemeColor,
        ThemeIcon,
        DataTransferItem,
        DataTransfer,
        window,
        TreeItemCollapsibleState: {
            None: 0,
            Collapsed: 1,
            Expanded: 2,
        },
    };
});

import { PlanItem, PlansTreeProvider, UNASSIGNED_PROJECT_FILTER } from '../src/plans-provider';

describe('PlansTreeProvider', () => {
    it('shows rolled-up counts on status categories', async () => {
        const listPlans = vi.fn(async (category: string) => {
            if (category === 'active') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                plans: [
                                    { id: 'a-1', name: 'Active One', category: 'active' },
                                    { id: 'a-2', name: 'Active Two', category: 'active' },
                                ],
                            }),
                        },
                    ],
                };
            }
            if (category === 'done') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                plans: [{ id: 'd-1', name: 'Done One', category: 'done' }],
                            }),
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ plans: [] }),
                    },
                ],
            };
        });
        const provider = new PlansTreeProvider({ listPlans } as any);

        const categories = await provider.getChildren();

        expect(categories).toHaveLength(3);
        expect(categories[0].label).toBe('Active');
        expect(categories[0].description).toBe('2');
        expect(categories[1].label).toBe('Done');
        expect(categories[1].description).toBe('1');
        expect(categories[2].label).toBe('Hold');
        expect(categories[2].description).toBeUndefined();
        expect(listPlans).toHaveBeenNthCalledWith(1, 'active');
        expect(listPlans).toHaveBeenNthCalledWith(2, 'done');
        expect(listPlans).toHaveBeenNthCalledWith(3, 'hold');
    });

    it('groups plans by modified day within a category', async () => {
        const listPlans = vi.fn(async () => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        plans: [
                            {
                                id: 'plan-1',
                                name: 'Plan 1',
                                category: 'active',
                                stage: 'executing',
                                updatedAt: '2026-02-23T10:15:00.000Z',
                            },
                        ],
                    }),
                },
            ],
        }));
        const provider = new PlansTreeProvider({ listPlans } as any);
        const dayGroups = await provider.getChildren(
            new PlanItem('Active', 1 as any, 'active')
        );
        const planChildren = await provider.getChildren(dayGroups[0]);

        expect(dayGroups).toHaveLength(1);
        expect(dayGroups[0].contextValue).toBe('plan-day-group');
        expect(planChildren).toHaveLength(1);
        expect(planChildren[0].label).toBe('Plan 1');
        expect(listPlans).toHaveBeenNthCalledWith(1, 'active');
        expect(listPlans).toHaveBeenNthCalledWith(2, 'active');
    });

    it('filters to unassigned plans when project filter is unassigned', async () => {
        const listPlans = vi.fn(async () => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        plans: [
                            {
                                id: 'assigned-plan',
                                name: 'Assigned Plan',
                                category: 'active',
                                updatedAt: '2026-02-23T10:15:00.000Z',
                                project: {
                                    id: 'project-1',
                                    name: 'Project 1',
                                },
                            },
                            {
                                id: 'unassigned-plan',
                                name: 'Unassigned Plan',
                                category: 'active',
                                updatedAt: '2026-02-23T09:15:00.000Z',
                            },
                        ],
                    }),
                },
            ],
        }));
        const provider = new PlansTreeProvider({ listPlans } as any);
        provider.setProjectFilter(UNASSIGNED_PROJECT_FILTER);

        const dayGroups = await provider.getChildren(new PlanItem('Active', 1 as any, 'active'));
        const planChildren = await provider.getChildren(dayGroups[0]);

        expect(planChildren).toHaveLength(1);
        expect(planChildren[0].label).toBe('Unassigned Plan');
    });

    it('sorts by progress descending when configured', async () => {
        const listPlans = vi.fn(async () => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        plans: [
                            {
                                id: 'low-progress',
                                name: 'Low Progress',
                                category: 'active',
                                updatedAt: '2026-02-23T08:00:00.000Z',
                                progress: { completed: 1, total: 10, percentage: 10 },
                            },
                            {
                                id: 'high-progress',
                                name: 'High Progress',
                                category: 'active',
                                updatedAt: '2026-02-23T08:00:00.000Z',
                                progress: { completed: 8, total: 10, percentage: 80 },
                            },
                        ],
                    }),
                },
            ],
        }));
        const provider = new PlansTreeProvider({ listPlans } as any);
        provider.setSortOrder('progress-desc');

        const dayGroups = await provider.getChildren(new PlanItem('Active', 1 as any, 'active'));
        const planChildren = await provider.getChildren(dayGroups[0]);

        expect(planChildren).toHaveLength(2);
        expect(planChildren[0].label).toBe('High Progress');
        expect(planChildren[1].label).toBe('Low Progress');
    });

    it('moves dragged plans to target category', async () => {
        const vscode = await import('vscode');
        const movePlan = vi.fn(async () => ({
            content: [{ type: 'text', text: JSON.stringify({ moved: true }) }],
        }));
        const provider = new PlansTreeProvider({ movePlan } as any);
        const dragData = new vscode.DataTransfer();
        const source = [
            new PlanItem(
                'Movable Plan',
                0 as any,
                'active',
                undefined,
                'active/my-plan',
                'plan-uuid-1',
                'plan-id-1'
            ),
        ];

        await provider.handleDrag(source, dragData);
        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), dragData);

        expect(movePlan).toHaveBeenCalledWith('active/my-plan', 'done');
    });

    it('filters root categories when status filter is narrowed', async () => {
        const listPlans = vi.fn(async () => ({
            content: [{ type: 'text', text: JSON.stringify({ plans: [] }) }],
        }));
        const provider = new PlansTreeProvider({ listPlans } as any);
        provider.setStatusFilter(['done']);

        const categories = await provider.getChildren();

        expect(categories).toHaveLength(1);
        expect(categories[0].label).toBe('Done');
        expect(listPlans).toHaveBeenCalledWith('done');
    });

    it('resolves category from label when category is missing on tree element', async () => {
        const listPlans = vi.fn(async (category: string) => ({
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        plans: [
                            { id: `${category}-plan`, name: 'Category Plan', path: `${category}/category-plan` },
                        ],
                    }),
                },
            ],
        }));
        const provider = new PlansTreeProvider({ listPlans } as any);

        const dayGroups = await provider.getChildren(new PlanItem('Hold', 1 as any));

        expect(dayGroups).toHaveLength(1);
        expect(listPlans).toHaveBeenCalledWith('hold');
    });

    it('skips moves when dropped to same category and reports info message', async () => {
        const vscode = await import('vscode');
        const movePlan = vi.fn();
        const provider = new PlansTreeProvider({ movePlan } as any);
        const dragData = new vscode.DataTransfer();

        dragData.set(
            'application/vnd.code.tree.riotplan-plans',
            new vscode.DataTransferItem(
                JSON.stringify([{ planId: 'plan-1', category: 'done', name: 'Done Plan' }])
            )
        );

        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), dragData);

        expect(movePlan).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            'Selected plans are already in that category.'
        );
    });

    it('reports error message when move fails for dropped plan', async () => {
        const vscode = await import('vscode');
        const movePlan = vi.fn(async () => {
            throw new Error('boom');
        });
        const provider = new PlansTreeProvider({ movePlan } as any);
        const dragData = new vscode.DataTransfer();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        dragData.set(
            'application/vnd.code.tree.riotplan-plans',
            new vscode.DataTransferItem(
                JSON.stringify([{ planId: 'plan-1', path: 'active/plan-1', category: 'active', name: 'Plan 1' }])
            )
        );

        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), dragData);

        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('accepts transfer items that only provide asString()', async () => {
        const movePlan = vi.fn(async () => ({
            content: [{ type: 'text', text: JSON.stringify({ moved: true }) }],
        }));
        const provider = new PlansTreeProvider({ movePlan } as any);
        const transfer = {
            get: () => ({
                get value() {
                    throw new Error('no direct value');
                },
                asString: async () =>
                    JSON.stringify([
                        { planId: 'plan-2', path: 'active/plan-2', category: 'active', name: 'Plan 2' },
                    ]),
            }),
        };

        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), transfer as any);

        expect(movePlan).toHaveBeenCalledWith('active/plan-2', 'done');
    });

    it('handles unreadable transfer data gracefully', async () => {
        const movePlan = vi.fn();
        const provider = new PlansTreeProvider({ movePlan } as any);
        const transfer = {
            get: () => ({
                get value() {
                    throw new Error('no value');
                },
                asString: async () => {
                    throw new Error('no string');
                },
            }),
        };

        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), transfer as any);

        expect(movePlan).not.toHaveBeenCalled();
    });

    it('reports error when all move candidates fail with missing plan', async () => {
        const vscode = await import('vscode');
        const movePlan = vi.fn(async () => {
            throw new Error('Could not find plan');
        });
        const provider = new PlansTreeProvider({ movePlan } as any);
        const dragData = new vscode.DataTransfer();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        dragData.set(
            'application/vnd.code.tree.riotplan-plans',
            new vscode.DataTransferItem(
                JSON.stringify([
                    {
                        planId: 'plan-3',
                        path: 'active/plan-3',
                        uuid: 'uuid-plan-3',
                        category: 'active',
                        name: 'Plan 3',
                    },
                ])
            )
        );

        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), dragData);

        expect(movePlan).toHaveBeenCalledTimes(3);
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('treats non-json text move responses as successful moves', async () => {
        const vscode = await import('vscode');
        const movePlan = vi.fn(async () => ({
            content: [{ type: 'text', text: 'Moved successfully.' }],
        }));
        const provider = new PlansTreeProvider({ movePlan } as any);
        const dragData = new vscode.DataTransfer();

        dragData.set(
            'application/vnd.code.tree.riotplan-plans',
            new vscode.DataTransferItem(
                JSON.stringify([{ planId: 'plan-4', path: 'active/plan-4', category: 'active', name: 'Plan 4' }])
            )
        );

        await provider.handleDrop(new PlanItem('Done', 1 as any, 'done'), dragData);

        expect(movePlan).toHaveBeenCalledWith('active/plan-4', 'done');
        expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    });
});

describe('PlanItem', () => {
    it('renders project label only in plan description', () => {
        const item = new PlanItem(
            'Example Plan',
            0,
            'active',
            undefined,
            '/tmp/example.plan',
            'uuid-1',
            'plan-1',
            'executing',
            { completed: 1, total: 4, percentage: 25 },
            {
                id: 'project-1',
            }
        );

        expect(item.description).not.toContain('executing');
        expect(item.description).not.toContain('ws:');
        expect(item.description).toContain('project-1');
        expect(item.description).not.toContain('project:');
        expect(item.iconPath).toBeDefined();
    });

    it('covers additional stage icon and grouping branches', () => {
        const dayGroup = new PlanItem('Yesterday', 1 as any, 'active', '2026-02-23');
        const completed = new PlanItem(
            'Complete Plan',
            0,
            'done',
            undefined,
            '/tmp/complete.plan',
            'uuid-complete',
            'plan-complete',
            'completed'
        );
        const built = new PlanItem(
            'Built Plan',
            0,
            'active',
            undefined,
            '/tmp/built.plan',
            'uuid-built',
            'plan-built',
            'built'
        );
        const shaping = new PlanItem(
            'Shaping Plan',
            0,
            'active',
            undefined,
            '/tmp/shaping.plan',
            'uuid-shaping',
            'plan-shaping',
            'shaping'
        );
        const cancelled = new PlanItem(
            'Cancelled Plan',
            0,
            'hold',
            undefined,
            '/tmp/cancelled.plan',
            'uuid-cancelled',
            'plan-cancelled',
            'cancelled'
        );

        expect(dayGroup.contextValue).toBe('plan-day-group');
        expect((completed.iconPath as any)?.id).toBe('check');
        expect((built.iconPath as any)?.id).toBe('tools');
        expect((shaping.iconPath as any)?.id).toBe('graph');
        expect((cancelled.iconPath as any)?.id).toBe('error');
    });

    it('includes server attribution in description and tooltip', () => {
        const item = new PlanItem(
            'Remote Plan',
            0,
            'active',
            undefined,
            '/tmp/remote.plan',
            'uuid-remote',
            'plan-remote',
            'idea',
            undefined,
            { id: 'project-remote' },
            'Remote Server'
        );

        expect(item.description).toContain('Remote Server');
        expect(item.description).toContain('project-remote');
        expect(String(item.tooltip)).toContain('Remote Server');
    });
});

describe('PlansTreeProvider private branches', () => {
    it('covers private helper branches directly', async () => {
        const provider = new PlansTreeProvider({ movePlan: vi.fn() } as any);

        expect((provider as any).resolveDropCategory(undefined)).toBeUndefined();
        expect((provider as any).resolveDropCategory({ category: 'custom' })).toBeUndefined();
        expect((provider as any).resolveDropCategory({ category: 'hold' })).toBe('hold');

        expect((provider as any).getPlanCategory({ category: 'done' })).toBe('done');
        expect((provider as any).getPlanCategory({ path: 'a/b/hold/c' })).toBe('hold');
        expect((provider as any).getPlanCategory({ path: 'x/y/unknown' })).toBe('active');

        expect((provider as any).resolvePlanTitle({})).toBe('Untitled Plan');
        expect((provider as any).resolvePlanTitle({ id: 'folder/abcd1234-plan-name' })).toBe('plan-name');

        const groups = (provider as any).groupPlansByDay([
            { id: 'a', updatedAt: '2026-02-23T10:00:00.000Z' },
            { id: 'b' },
        ]);
        expect(groups.some((g: any) => g.dayKey === 'unknown')).toBe(true);
        expect(groups.some((g: any) => g.dayKey !== 'unknown')).toBe(true);

        expect((provider as any).resolveCategoryFromLabel('Done')).toBe('done');
        expect((provider as any).resolveCategoryFromLabel('Hold')).toBe('hold');
        expect((provider as any).resolveCategoryFromLabel('Anything')).toBe('active');
        expect((provider as any).getPlanCategory({ path: 'active/done/plan' })).toBe('done');
    });

    it('covers movePlanViaMcp error and early-return branches', async () => {
        const movePlan = vi
            .fn()
            .mockResolvedValueOnce({ isError: true, content: [] })
            .mockResolvedValueOnce({ content: [{ type: 'binary' }] });
        const provider = new PlansTreeProvider({ movePlan } as any);

        await expect(
            (provider as any).movePlanViaMcp(
                { planId: 'p-1', path: 'active/p-1', uuid: 'uuid-p-1' },
                'done'
            )
        ).rejects.toThrow('MCP move tool returned an error.');

        await (provider as any).movePlanViaMcp({ planId: 'p-2', path: 'active/p-2' }, 'done');
        expect(movePlan).toHaveBeenCalled();
    });

    it('covers readTransferText empty asString branch', async () => {
        const provider = new PlansTreeProvider({ movePlan: vi.fn() } as any);
        const value = await (provider as any).readTransferText({
            get value() {
                return 42;
            },
            asString: async () => '',
        });

        expect(value).toBeUndefined();
    });
});
