# Prompt: Add Proxy Bypass Support to riotplan-vscode Extension

## Problem

The riotplan-vscode extension cannot connect to remote RiotPlan servers (e.g. `https://riotplan.getfjell.com`) when running behind a corporate proxy. The extension uses Node.js built-in `http`/`https` modules directly, which inherit the system proxy configuration. On macOS, Cursor/VSCode reads the system proxy via `scutil --proxy`, and Node's `http.request`/`https.request` will route through it.

In this specific environment:
- macOS system proxy is `sysproxy.wal-mart.com:8080` (configured via PAC file)
- McAfee sets local relay env vars (`HTTP_PROXY=http://127.0.0.1:62365`)
- The corporate proxy blocks or interferes with connections to `riotplan.getfjell.com`
- Direct connections (bypassing proxy) work fine

The Cursor MCP connection was fixed separately by using `mcp-remote` as a stdio bridge with per-process `env` overrides in `~/.cursor/mcp.json`. But the VSCode **extension** itself also makes HTTP calls via `HttpMcpClient` in `src/mcp-client.ts`, and those still go through the proxy.

## What Needs to Change

The `HttpMcpClient` class in `src/mcp-client.ts` uses Node's `http.request()` and `https.request()` directly in these methods:

1. **`httpPost()`** (line ~162 in compiled JS) - All MCP JSON-RPC calls
2. **`httpRequestRaw()`** (line ~215) - Plan upload/download
3. **`healthCheck()`** (line ~597) - Server health check via `http.get()`
4. **`startSSEConnection()`** (line ~715) - SSE notification stream

All four create requests using `http.request()` / `https.request()` / `http.get()` which will use the system proxy.

## Proposed Solution

Add a VSCode setting `riotplan.proxyBypass` (boolean, default `false`) that, when enabled, forces the extension to connect **directly** to the configured `riotplan.serverUrl`, bypassing any system or environment proxy.

### Implementation approach

When `proxyBypass` is `true`, pass a custom `agent` to all `http.request()` / `https.request()` / `http.get()` calls that explicitly sets `proxy: false` or equivalent. The cleanest way in Node.js:

```typescript
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

// Create agents that don't use any proxy
const directHttpAgent = new HttpAgent();
const directHttpsAgent = new HttpsAgent();
```

Then in each request call, add `agent: isHttps ? directHttpsAgent : directHttpAgent` to the options. This overrides any proxy that Node might pick up from environment variables or system config.

**However**, VSCode/Cursor's Node.js runtime patches the global `http`/`https` modules to inject proxy support via its own agent. Simply creating a new `Agent()` may not be enough if VSCode's patching intercepts at a lower level. If that's the case, a more robust approach is:

1. Use `undici` (already a pattern in the kjerneverk monorepo — see `PROXY-SUPPORT-SUMMARY.md` in the parent) to make HTTP requests that bypass VSCode's patched `http` module entirely.
2. Or, set the `agent` option explicitly AND ensure the agent has no proxy configuration.

### Recommended approach: Custom agent with explicit no-proxy

The simplest change that should work:

```typescript
// In HttpMcpClient constructor or as a private method:
private getAgent(isHttps: boolean): HttpAgent | HttpsAgent {
    if (!this.proxyBypass) {
        return undefined; // Use default (system proxy)
    }
    // Explicit agent with no proxy — bypasses VSCode's proxy injection
    return isHttps 
        ? new HttpsAgent({ keepAlive: true })
        : new HttpAgent({ keepAlive: true });
}
```

Then in `httpPost`, `httpRequestRaw`, `healthCheck`, and `startSSEConnection`, add `agent: this.getAgent(isHttps)` to the request options.

### Configuration

Add to `package.json` contributes.configuration:

```json
"riotplan.proxyBypass": {
    "type": "boolean",
    "default": false,
    "description": "Bypass system/corporate proxy when connecting to the RiotPlan server. Enable this if your RiotPlan server is accessible directly but blocked by a corporate proxy."
}
```

Pass the setting into `HttpMcpClient`:

```typescript
// In extension.ts where HttpMcpClient is constructed:
const proxyBypass = vscode.workspace.getConfiguration('riotplan').get<boolean>('proxyBypass', false);
mcpClient = new HttpMcpClient(currentServerUrl, currentApiKey, proxyBypass);
```

And watch for config changes (already handled in the `onDidChangeConfiguration` listener — just add `riotplan.proxyBypass` to the check).

### If the simple agent approach doesn't work

VSCode deeply patches Node's HTTP stack. If the custom agent approach still routes through the proxy, the fallback is to use `globalThis.fetch()` or the `undici` library directly (which has its own HTTP implementation independent of Node's `http` module). The kjerneverk monorepo already uses `undici.ProxyAgent` in other packages for the reverse case (forcing proxy usage). Here you'd use `undici.fetch()` with no proxy agent to bypass it.

## Files to Modify

- `src/mcp-client.ts` — Add `proxyBypass` constructor param, create direct agents, pass to all 4 request methods
- `src/extension.ts` — Read `riotplan.proxyBypass` setting, pass to `HttpMcpClient`, handle config changes
- `package.json` — Add `riotplan.proxyBypass` configuration property

## Testing

1. Set `riotplan.serverUrl` to `https://riotplan.getfjell.com`
2. Set `riotplan.proxyBypass` to `true`
3. The Connection Status view should show "connected"
4. Plans should load in the sidebar
5. With `proxyBypass: false` (default), existing proxy-dependent setups should continue working

## Context

- See `~/PROXY_CURSOR_CONFIG.md` for the full proxy diagnosis on this machine
- See `/Users/tobrien/gitw/kjerneverk/PROXY-SUPPORT-SUMMARY.md` for how other kjerneverk packages handle proxy
- The MCP connection (separate from the extension) was fixed via `mcp-remote` stdio bridge in `~/.cursor/mcp.json`
