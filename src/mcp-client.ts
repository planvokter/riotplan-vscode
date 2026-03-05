/**
 * HTTP MCP Client for RiotPlan
 *
 * Implements JSON-RPC 2.0 over HTTP POST to communicate with RiotPlan HTTP MCP server
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { getProxyAgent } from './proxyUtils';

interface McpRequest {
    jsonrpc: '2.0';
    id: string | number | null;
    method: string;
    params?: any;
}

interface McpResponse {
    jsonrpc: '2.0';
    id: string | number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

function getToolErrorText(result: any): string | null {
    if (!result || !result.isError) {
        return null;
    }
    const first = result.content?.[0];
    if (first?.type === 'text' && typeof first.text === 'string' && first.text.trim()) {
        return first.text;
    }
    return 'MCP tool returned an error';
}

export class HttpMcpClient {
    private sessionId?: string;
    private initialized = false;
    private sseConnection: http.ClientRequest | null = null;
    private notificationHandlers: Map<string, Array<(data: unknown) => void>> = new Map();
    private recoveringSession = false;
    private onSessionRecoveredCallbacks: Array<() => void | Promise<void>> = [];

    constructor(
        private serverUrl: string,
        private apiKey?: string,
        private proxyBypass = false
    ) {}

    get baseUrl(): string {
        return this.serverUrl;
    }

    setApiKey(apiKey?: string): void {
        this.apiKey = apiKey?.trim() || undefined;
    }

    onSessionRecovered(callback: () => void | Promise<void>): () => void {
        this.onSessionRecoveredCallbacks.push(callback);
        return () => {
            const idx = this.onSessionRecoveredCallbacks.indexOf(callback);
            if (idx >= 0) {
                this.onSessionRecoveredCallbacks.splice(idx, 1);
            }
        };
    }

    async sendRequest(method: string, params?: any): Promise<any> {
        return this.sendRequestInternal(method, params, true);
    }

    private async sendRequestInternal(method: string, params: any, retryOnSessionError: boolean): Promise<any> {
        // MCP protocol requires initialize handshake before any other requests
        if (!this.initialized && method !== 'initialize') {
            await this.initialize();
        }

        const request: McpRequest = {
            jsonrpc: '2.0',
            id: Math.random().toString(36).substring(2),
            method,
            params,
        };

        try {
            const response = await this.httpPost('/mcp', request);

            // Update session ID from response headers
            if (response.headers['mcp-session-id']) {
                const newSessionId = response.headers['mcp-session-id'] as string;
                if (!this.sessionId) {
                    this.sessionId = newSessionId;
                    this.startSSEConnection();
                } else {
                    this.sessionId = newSessionId;
                }
            }

            if (response.data.error) {
                if (retryOnSessionError && this.isSessionError(undefined, response.data.error.message || '')) {
                    await this.recoverSession();
                    return this.sendRequestInternal(method, params, false);
                }
                throw new Error(response.data.error.message || 'MCP request failed');
            }

            const toolError = getToolErrorText(response.data.result);
            if (toolError) {
                throw new Error(toolError);
            }

            return response.data.result;
        } catch (error) {
            if (retryOnSessionError && this.isSessionError(error)) {
                await this.recoverSession();
                return this.sendRequestInternal(method, params, false);
            }
            throw error;
        }
    }

    private async initialize(): Promise<void> {
        const request: McpRequest = {
            jsonrpc: '2.0',
            id: 'init-1',
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'riotplan-vscode', version: '1.0.0' },
            },
        };

        const response = await this.httpPost('/mcp', request);

        if (response.headers['mcp-session-id']) {
            this.sessionId = response.headers['mcp-session-id'];
            this.startSSEConnection();
        }

        if (response.data.error) {
            throw new Error(`MCP initialization failed: ${response.data.error.message}`);
        }

        this.initialized = true;
        await this.sendNotification('notifications/initialized', {});
    }

    private parseSSEResponse(sseText: string): McpResponse {
        const dataLines: string[] = [];
        for (const line of sseText.split('\n')) {
            if (line.startsWith('data:')) {
                dataLines.push(line.substring(5).trim());
            }
        }
        if (dataLines.length === 0) {
            throw new Error(`No data lines found in SSE response: ${sseText.substring(0, 200)}`);
        }
        return JSON.parse(dataLines.join(''));
    }

    private async httpPost(path: string, body: any): Promise<{ data: McpResponse; headers: any }> {
        return new Promise((resolve, reject) => {
            const url = new URL(this.serverUrl + path);
            const isHttps = url.protocol === 'https:';
            const client = isHttps ? https : http;

            const postData = JSON.stringify(body);
            const proxyAgent = getProxyAgent(url.toString(), this.proxyBypass);

            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Both required by MCP Streamable HTTP transport spec
                    'Accept': 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(postData),
                    ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
                    ...this.getAuthHeaders(),
                },
                ...(proxyAgent ? { agent: proxyAgent } : {}),
            };

            const req = client.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode === 202) {
                            resolve({ data: { jsonrpc: '2.0', id: body.id, result: {} }, headers: res.headers });
                            return;
                        }
                        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                            return;
                        }
                        const contentType = String(res.headers['content-type'] || '');
                        const parsed = contentType.includes('text/event-stream')
                            ? this.parseSSEResponse(data)
                            : JSON.parse(data);
                        resolve({ data: parsed, headers: res.headers });
                    } catch (error) {
                        reject(new Error(`Failed to parse response: ${error}`));
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.write(postData);
            req.end();
        });
    }

    private async httpRequestRaw(
        method: 'GET' | 'POST',
        path: string,
        options?: {
            headers?: Record<string, string | number>;
            body?: Buffer;
            timeoutMs?: number;
        }
    ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
        return new Promise((resolve, reject) => {
            const url = new URL(this.serverUrl + path);
            const isHttps = url.protocol === 'https:';
            const client = isHttps ? https : http;
            const proxyAgent = getProxyAgent(url.toString(), this.proxyBypass);
            const req = client.request(
                {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname + url.search,
                    method,
                    headers: {
                        ...this.getAuthHeaders(),
                        ...(options?.headers || {}),
                    },
                    ...(proxyAgent ? { agent: proxyAgent } : {}),
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks);
                        const statusCode = res.statusCode || 0;
                        if (statusCode < 200 || statusCode >= 300) {
                            reject(new Error(`HTTP ${statusCode}: ${body.toString('utf8')}`));
                            return;
                        }
                        resolve({ statusCode, headers: res.headers, body });
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(options?.timeoutMs ?? 30000, () => {
                req.destroy(new Error(`HTTP ${method} ${path} timed out`));
            });
            if (options?.body) {
                req.write(options.body);
            }
            req.end();
        });
    }

    private isSessionError(error?: unknown, message?: string): boolean {
        if (error instanceof Error && error.message.includes('HTTP 404')) {
            return true;
        }
        const msg = (message || '').toLowerCase();
        return msg.includes('session not found');
    }

    private async recoverSession(): Promise<void> {
        if (this.recoveringSession) {
            return;
        }
        this.recoveringSession = true;
        try {
            this.sessionId = undefined;
            this.initialized = false;
            this.stopSSEConnection();
            await this.initialize();
            for (const cb of this.onSessionRecoveredCallbacks) {
                await cb();
            }
        } finally {
            this.recoveringSession = false;
        }
    }

    private async sendNotification(method: string, params?: unknown): Promise<void> {
        const request: McpRequest = {
            jsonrpc: '2.0',
            id: null,
            method,
            params,
        };
        await this.httpPost('/mcp', request);
    }

    async listPlans(filter?: 'all' | 'active' | 'done' | 'hold'): Promise<any> {
        return await this.listPlansWithWorkspace(filter, undefined);
    }

    async listPlansWithWorkspace(
        filter?: 'all' | 'active' | 'done' | 'hold',
        workspaceId?: string
    ): Promise<any> {
        const args = {
            ...(filter ? { filter } : {}),
            ...(workspaceId ? { workspaceId } : {}),
        };
        try {
            return await this.sendRequest('tools/call', {
                name: 'riotplan_list_plans',
                arguments: args,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isUnknownListTool = message.toLowerCase().includes('unknown tool')
                && message.toLowerCase().includes('riotplan_list_plans');
            if (!isUnknownListTool) {
                throw error;
            }

            // Compatibility fallback for old RiotPlan servers.
            try {
                return await this.sendRequest('tools/call', {
                    name: 'riotplan_plan',
                    arguments: { action: 'list', ...args },
                });
            } catch {
                const toolNames = await this.listAvailableToolNamesSafe();
                throw new Error(
                    `Connected MCP server at ${this.baseUrl} does not expose RiotPlan plan-list tools. ` +
                        `Expected 'riotplan_list_plans'. ` +
                        `Available tools: ${toolNames.length > 0 ? toolNames.slice(0, 10).join(', ') : '(none)'}`
                );
            }
        }
    }

    async listPlansFiltered(
        filter?: 'all' | 'active' | 'done' | 'hold',
        workspaceId?: string
    ): Promise<any> {
        return this.listPlansWithWorkspace(filter, workspaceId);
    }

    async movePlan(
        planId: string,
        target: 'active' | 'done' | 'hold'
    ): Promise<any> {
        return await this.sendRequest('tools/call', {
            name: 'riotplan_plan',
            arguments: { action: 'move', planId, target },
        });
    }

    async createPlan(args: {
        code: string;
        description: string;
        name?: string;
        steps?: number;
    }): Promise<any> {
        const result = await this.sendRequest('tools/call', {
            name: 'riotplan_plan',
            arguments: {
                action: 'create',
                code: args.code,
                description: args.description,
                ...(args.name ? { name: args.name } : {}),
                ...(typeof args.steps === 'number' ? { steps: args.steps } : {}),
            },
        });
        if (result?.content?.[0]?.type === 'text') {
            try {
                return JSON.parse(result.content[0].text);
            } catch {
                return result.content[0].text;
            }
        }
        return result;
    }

    async downloadPlanFile(planId: string): Promise<{ filename: string; content: Buffer }> {
        const response = await this.httpRequestRaw('GET', `/plan/${encodeURIComponent(planId)}`, {
            headers: { Accept: 'application/octet-stream' },
            timeoutMs: 120000,
        });
        const disposition = String(response.headers['content-disposition'] || '');
        const match = disposition.match(/filename="?([^";]+)"?/i);
        const filename = match?.[1] || `${planId}.plan`;
        return { filename, content: response.body };
    }

    async uploadPlanFile(filename: string, content: Buffer): Promise<any> {
        const boundary = `----riotplan-vscode-${Date.now().toString(16)}`;
        const preamble = Buffer.from(
            `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="plan"; filename="${filename}"\r\n` +
                `Content-Type: application/octet-stream\r\n\r\n`,
            'utf8'
        );
        const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
        const body = Buffer.concat([preamble, content, epilogue]);

        const response = await this.httpRequestRaw('POST', '/plan/upload', {
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': body.byteLength,
                Accept: 'application/json',
            },
            body,
            timeoutMs: 120000,
        });

        const text = response.body.toString('utf8');
        try {
            return JSON.parse(text);
        } catch {
            return { success: true, raw: text };
        }
    }

    private async callToolWithArgFallback(
        name: string,
        primaryArgs: Record<string, unknown>,
        fallbackArgs: Record<string, unknown>
    ): Promise<any> {
        try {
            return await this.sendRequest('tools/call', {
                name,
                arguments: primaryArgs,
            });
        } catch (primaryError) {
            try {
                return await this.sendRequest('tools/call', {
                    name,
                    arguments: fallbackArgs,
                });
            } catch {
                throw primaryError;
            }
        }
    }

    async getPlanStatus(planPathOrId: string): Promise<any> {
        const result = await this.callToolWithArgFallback(
            'riotplan_status',
            { planId: planPathOrId, verbose: true },
            { path: planPathOrId, verbose: true }
        );
        if (result?.content?.[0]?.type === 'text') {
            return JSON.parse(result.content[0].text);
        }
        return result;
    }

    async bindProject(planId: string, project: Record<string, unknown>): Promise<any> {
        return await this.sendRequest('tools/call', {
            name: 'riotplan_bind_project',
            arguments: { planId, project },
        });
    }

    async getProjectBinding(planId: string): Promise<any> {
        const result = await this.sendRequest('tools/call', {
            name: 'riotplan_get_project_binding',
            arguments: { planId },
        });
        if (result?.content?.[0]?.type === 'text') {
            return JSON.parse(result.content[0].text);
        }
        return result;
    }

    async resolveProjectContext(planId: string, cwd?: string): Promise<any> {
        const result = await this.sendRequest('tools/call', {
            name: 'riotplan_resolve_project_context',
            arguments: {
                planId,
                ...(cwd ? { cwd } : {}),
            },
        });
        if (result?.content?.[0]?.type === 'text') {
            return JSON.parse(result.content[0].text);
        }
        return result;
    }

    async listContextProjects(includeInactive = true): Promise<any[]> {
        const result = await this.sendRequest('tools/call', {
            name: 'riotplan_context',
            arguments: {
                action: 'list',
                entityType: 'project',
                includeInactive,
            },
        });
        if (result?.content?.[0]?.type === 'text') {
            const data = JSON.parse(result.content[0].text);
            if (Array.isArray(data?.entities)) {
                return data.entities;
            }
            // Backward/variant compatibility: some builds return projects directly or nested in data.
            if (Array.isArray(data?.projects)) {
                return data.projects;
            }
            if (Array.isArray(data?.data?.entities)) {
                return data.data.entities;
            }
            if (Array.isArray(data?.data?.projects)) {
                return data.data.projects;
            }
            if (Array.isArray(data)) {
                return data;
            }
            return [];
        }
        return [];
    }

    async createContextProject(entity: Record<string, unknown>): Promise<any> {
        const result = await this.sendRequest('tools/call', {
            name: 'riotplan_context',
            arguments: {
                action: 'create',
                entityType: 'project',
                entity,
            },
        });
        if (result?.content?.[0]?.type === 'text') {
            return JSON.parse(result.content[0].text);
        }
        return result;
    }

    async getContextProject(id: string): Promise<any | null> {
        const result = await this.sendRequest('tools/call', {
            name: 'riotplan_context',
            arguments: {
                action: 'get',
                entityType: 'project',
                id,
            },
        });
        if (result?.content?.[0]?.type === 'text') {
            const data = JSON.parse(result.content[0].text);
            if (data?.entity) {
                return data.entity;
            }
            if (data?.data?.entity) {
                return data.data.entity;
            }
            return null;
        }
        return null;
    }

    async readContext(planPath: string): Promise<any> {
        const result = await this.callToolWithArgFallback(
            'riotplan_read_context',
            { planId: planPath, depth: 'full' },
            { path: planPath, depth: 'full' }
        );
        if (result?.content?.[0]?.type === 'text') {
            return JSON.parse(result.content[0].text);
        }
        return result;
    }

    async listSteps(planPathOrId: string): Promise<Array<{
        number: number;
        title: string;
        status: string;
        file?: string;
        startedAt?: string;
        completedAt?: string;
    }>> {
        try {
            const resource = await this.readResource(`riotplan://steps/${planPathOrId}`);
            const parsed = JSON.parse(resource);
            const rawSteps = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.steps)
                    ? parsed.steps
                    : [];

            return rawSteps
                .map((step: any) => ({
                    number: Number(step?.number ?? 0),
                    title: String(step?.title ?? ''),
                    status: String(step?.status ?? 'pending'),
                    file: typeof step?.file === 'string' ? step.file : undefined,
                    startedAt: typeof step?.startedAt === 'string' ? step.startedAt : undefined,
                    completedAt: typeof step?.completedAt === 'string' ? step.completedAt : undefined,
                }))
                .filter((step: { number: number; title: string }) => Number.isFinite(step.number) && step.number > 0 && step.title.length > 0);
        } catch {
            return [];
        }
    }

    async updateStep(planId: string, step: number, status: string): Promise<any> {
        return await this.sendRequest('tools/call', {
            name: 'riotplan_step_update',
            arguments: { planId, step, status },
        });
    }

    async readResource(uri: string): Promise<string> {
        const result = await this.sendRequest('resources/read', { uri });
        if (result?.contents?.[0]?.text) {
            return result.contents[0].text;
        }
        return '';
    }

    async getPlanResource(planPathOrId: string): Promise<any | null> {
        try {
            const content = await this.readResource(`riotplan://plan/${planPathOrId}`);
            if (!content) {
                return null;
            }
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    async addEvidence(
        planPath: string,
        description: string,
        source: string,
        summary: string,
        content: string
    ): Promise<any> {
        const args: any = { planId: planPath, description, gatheringMethod: 'manual' };
        if (source) { args.source = source; }
        if (summary) { args.summary = summary; }
        if (content) { args.content = content; }
        const result = await this.callToolWithArgFallback(
            'riotplan_idea',
            { action: 'add_evidence', ...args },
            { action: 'add_evidence', ...args, path: planPath, planId: undefined }
        );
        if (result?.content?.[0]?.type === 'text') {
            try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
        }
        return result;
    }

    private parseToolTextResult(result: any): any {
        if (result?.content?.[0]?.type === 'text') {
            try {
                return JSON.parse(result.content[0].text);
            } catch {
                return result.content[0].text;
            }
        }
        return result;
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private isTransientEvidenceDeleteError(error: unknown): boolean {
        const message = String(error || '').toLowerCase();
        const isSyncIndexTmpRace =
            message.includes('enoent')
            && message.includes('sync-index')
            && message.includes('.tmp');
        return isSyncIndexTmpRace
            || message.includes('sqlite_busy')
            || message.includes('database is locked')
            || message.includes('resource temporarily unavailable');
    }

    async removeEvidence(planPathOrId: string, evidenceRefValue: string): Promise<any> {
        const trimmedRef = typeof evidenceRefValue === 'string' ? evidenceRefValue.trim() : '';
        if (!trimmedRef) {
            throw new Error('Missing evidence reference');
        }

        const deleteAttempts: Array<Record<string, unknown>> = [
            { evidenceRef: { file: trimmedRef } },
            { evidenceRef: { file: `evidence/${trimmedRef}` } },
            { evidenceRef: { evidenceId: trimmedRef } },
        ];

        let lastError: unknown;
        for (const attempt of deleteAttempts) {
            for (let retry = 0; retry < 3; retry += 1) {
                try {
                    const result = await this.callToolWithArgFallback(
                        'riotplan_evidence',
                        {
                            action: 'delete',
                            planId: planPathOrId,
                            ...attempt,
                            confirm: true,
                        },
                        {
                            action: 'delete',
                            path: planPathOrId,
                            ...attempt,
                            confirm: true,
                        }
                    );
                    return this.parseToolTextResult(result);
                } catch (error) {
                    lastError = error;
                    const shouldRetry = this.isTransientEvidenceDeleteError(error) && retry < 2;
                    if (!shouldRetry) {
                        break;
                    }
                    await this.sleep(200 * (retry + 1));
                }
            }
        }

        throw lastError ?? new Error(`Failed to remove evidence: ${trimmedRef}`);
    }

    async renamePlan(planId: string, name: string): Promise<any> {
        const trimmedPlanId = typeof planId === 'string' ? planId.trim() : '';
        const trimmedName = typeof name === 'string' ? name.trim() : '';
        if (!trimmedPlanId) {
            throw new Error('Missing plan identifier');
        }
        if (!trimmedName) {
            throw new Error('Plan name cannot be empty');
        }

        const attempts: Array<{ tool: string; args: Record<string, unknown> }> = [
            { tool: 'riotplan_plan', args: { action: 'rename', planId: trimmedPlanId, name: trimmedName } },
            { tool: 'riotplan_plan', args: { action: 'update', planId: trimmedPlanId, name: trimmedName } },
            { tool: 'riotplan_plan', args: { action: 'set_name', planId: trimmedPlanId, name: trimmedName } },
            { tool: 'riotplan_rename_plan', args: { planId: trimmedPlanId, name: trimmedName } },
            { tool: 'riotplan_update_plan', args: { planId: trimmedPlanId, name: trimmedName } },
        ];

        let firstError: unknown;
        for (const attempt of attempts) {
            try {
                const result = await this.sendRequest('tools/call', {
                    name: attempt.tool,
                    arguments: attempt.args,
                });
                return this.parseToolTextResult(result);
            } catch (error) {
                if (firstError === undefined) {
                    firstError = error;
                }
            }
        }

        void firstError;
        throw new Error('Renaming plans is not supported by the connected RiotPlan server yet.');
    }

    async setIdeaContent(planPathOrId: string, content: string): Promise<any> {
        const result = await this.callToolWithArgFallback(
            'riotplan_idea',
            { action: 'set_content', planId: planPathOrId, content },
            { action: 'set_content', path: planPathOrId, content }
        );
        if (result?.content?.[0]?.type === 'text') {
            try {
                return JSON.parse(result.content[0].text);
            } catch {
                return result.content[0].text;
            }
        }
        return result;
    }

    async healthCheck(): Promise<boolean> {
        try {
            const url = new URL(this.serverUrl + '/health');
            const isHttps = url.protocol === 'https:';
            const client = isHttps ? https : http;
            const proxyAgent = getProxyAgent(url.toString(), this.proxyBypass);

            return new Promise((resolve) => {
                const req = client.get(url, {
                    headers: this.getAuthHeaders(),
                    ...(proxyAgent ? { agent: proxyAgent } : {}),
                }, (res) => {
                    resolve(res.statusCode === 200);
                });

                req.on('error', () => {
                    resolve(false);
                });

                req.setTimeout(5000, () => {
                    req.destroy();
                    resolve(false);
                });
            });
        } catch {
            return false;
        }
    }

    async verifyRiotPlanServer(): Promise<{ ok: boolean; reason?: string }> {
        const healthy = await this.healthCheck();
        if (!healthy) {
            return { ok: false, reason: 'server_unreachable' };
        }
        const tools = await this.listAvailableToolNamesSafe();
        const hasRiotPlanTool = tools.some((name) => name.startsWith('riotplan_'));
        if (!hasRiotPlanTool) {
            return { ok: false, reason: 'missing_riotplan_tools' };
        }
        return { ok: true };
    }

    private async listAvailableToolNamesSafe(): Promise<string[]> {
        try {
            const result = await this.sendRequest('tools/list');
            const rawTools = Array.isArray(result?.tools) ? result.tools : [];
            return rawTools
                .map((tool: any) => (typeof tool?.name === 'string' ? tool.name : ''))
                .filter((name: string) => Boolean(name));
        } catch {
            return [];
        }
    }

    async getStepContent(planPathOrId: string, stepNumber: number): Promise<string> {
        const resource = await this.readResource(`riotplan://step/${planPathOrId}?number=${stepNumber}`);
        try {
            const parsed = JSON.parse(resource);
            return parsed.content || '';
        } catch {
            return resource;
        }
    }

    async getEvidenceContent(planPathOrId: string, filename: string): Promise<string> {
        const resource = await this.readResource(`riotplan://evidence-file/${planPathOrId}?file=${encodeURIComponent(filename)}`);
        try {
            const parsed = JSON.parse(resource);
            return parsed.content || '';
        } catch {
            return resource;
        }
    }

    async getArtifact(planPathOrId: string, type: string): Promise<{ type: string; filename: string; content: string | null; updatedAt?: string }> {
        const resource = await this.readResource(`riotplan://artifact/${planPathOrId}?type=${encodeURIComponent(type)}`);
        try {
            return JSON.parse(resource);
        } catch {
            return { type, filename: `${type.toUpperCase()}.md`, content: null };
        }
    }

    async getShaping(planPathOrId: string): Promise<any> {
        const resource = await this.readResource(`riotplan://shaping/${planPathOrId}`);
        try {
            return JSON.parse(resource);
        } catch {
            return { content: null };
        }
    }

    async getExecutionPlan(planPathOrId: string): Promise<{ type: string; filename: string; content: string | null; updatedAt?: string }> {
        return this.getArtifact(planPathOrId, 'execution_plan');
    }

    async getHistory(planPathOrId: string): Promise<any> {
        const resource = await this.readResource(`riotplan://history/${planPathOrId}`);
        try {
            return JSON.parse(resource);
        } catch {
            return { events: [] };
        }
    }

    onNotification(method: string, handler: (data: unknown) => void): () => void {
        if (!this.notificationHandlers.has(method)) {
            this.notificationHandlers.set(method, []);
        }
        this.notificationHandlers.get(method)!.push(handler);
        return () => {
            const handlers = this.notificationHandlers.get(method);
            if (!handlers) {
                return;
            }
            const idx = handlers.indexOf(handler);
            if (idx >= 0) {
                handlers.splice(idx, 1);
            }
        };
    }

    async subscribeToResource(uri: string): Promise<void> {
        await this.sendRequest('resources/subscribe', { uri });
    }

    async unsubscribeFromResource(uri: string): Promise<void> {
        await this.sendRequest('resources/unsubscribe', { uri });
    }

    private startSSEConnection(): void {
        if (!this.sessionId) {
            return;
        }
        this.stopSSEConnection();
        const url = new URL(`${this.serverUrl}/mcp`);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;
        const proxyAgent = getProxyAgent(url.toString(), this.proxyBypass);
        const req = client.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'GET',
                headers: {
                    Accept: 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Mcp-Session-Id': this.sessionId,
                    ...this.getAuthHeaders(),
                },
                ...(proxyAgent ? { agent: proxyAgent } : {}),
            },
            (res) => {
                if (res.statusCode !== 200) {
                    if (res.statusCode === 404) {
                        void this.recoverSession();
                    }
                    return;
                }
                let buffer = '';
                res.on('data', (chunk: Buffer) => {
                    buffer += chunk.toString();
                    while (buffer.includes('\n\n')) {
                        const eventEnd = buffer.indexOf('\n\n');
                        const eventText = buffer.substring(0, eventEnd);
                        buffer = buffer.substring(eventEnd + 2);
                        this.handleSSEEvent(eventText);
                    }
                });
                res.on('end', () => {
                    this.sseConnection = null;
                    setTimeout(() => {
                        if (this.sessionId) {
                            this.startSSEConnection();
                        }
                    }, 3000);
                });
            }
        );
        req.on('error', () => {
            this.sseConnection = null;
        });
        req.end();
        this.sseConnection = req;
    }

    private stopSSEConnection(): void {
        if (this.sseConnection) {
            this.sseConnection.destroy();
            this.sseConnection = null;
        }
    }

    private handleSSEEvent(eventText: string): void {
        let dataPayload = '';
        for (const line of eventText.split('\n')) {
            if (line.startsWith('data:')) {
                dataPayload += line.substring(5).trim();
            }
        }
        if (!dataPayload) {
            return;
        }
        try {
            const notification = JSON.parse(dataPayload);
            const method = notification.method;
            if (!method) {
                return;
            }
            const handlers = this.notificationHandlers.get(method) || [];
            for (const handler of handlers) {
                handler(notification.params || {});
            }
        } catch {
            // Ignore non-JSON ping/comment payloads
        }
    }

    private getAuthHeaders(): Record<string, string> {
        if (!this.apiKey) {
            return {};
        }
        return {
            Authorization: `Bearer ${this.apiKey}`,
            'X-API-Key': this.apiKey,
        };
    }

    dispose(): void {
        this.stopSSEConnection();
        this.notificationHandlers.clear();
    }
}
