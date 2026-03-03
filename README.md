# RiotPlan VSCode Extension

VSCode extension for managing RiotPlan plans via HTTP MCP server.

## Features

- **Plans Tree View**: Browse plans organized by lifecycle stage (Active, Done, Hold)
- **Projects Tree View**: Browse context projects and click to open project details
- **Plan Status**: View plan details and progress
- **Project Details**: Inspect project metadata and click through associated plans
- **HTTP MCP Integration**: Connects to RiotPlan HTTP MCP server
- **Workspace Filter Persistence**: Persist selected `workspaceId` filter per VS Code workspace
- **Portable Plan Remap UX**: Map or create a project when transferred plans cannot be resolved locally

## Requirements

- RiotPlan HTTP MCP server running (default: http://127.0.0.1:3002)
- Start the server with: `riotplan-mcp-http --port 3002 --plans-dir /path/to/plans`

## Extension Settings

This extension contributes the following settings:

* `riotplan.serverUrl`: RiotPlan HTTP MCP server URL (default: `http://127.0.0.1:3002`)
* `riotplan.apiKey`: Optional API key used for secured RiotPlan servers. Sent as both:
  * `Authorization: Bearer <key>`
  * `X-API-Key: <key>`

### Example configuration (without security)

```json
{
  "riotplan.serverUrl": "http://127.0.0.1:3002"
}
```

### Example configuration (with security enabled)

```json
{
  "riotplan.serverUrl": "https://riotplan-mcp-xxxxx-uc.a.run.app",
  "riotplan.apiKey": "rp-REPLACE-WITH-YOUR-KEY"
}
```

## Usage

1. Start the RiotPlan HTTP MCP server
2. Open VSCode
3. The Plans view will appear in the Explorer sidebar
4. Browse plans by category (Active, Done, Hold)
5. Browse projects in the **Projects** view and click a project to open details
6. (Optional) Run **RiotPlan: Set Workspace Filter** to scope list results by `workspaceId`
7. Click on a plan to view its status

### Unresolved transferred plans (map-or-create)

When opening a transferred plan with inferred metadata that does not resolve locally:

1. The extension prompts to **Map to existing project**, **Create new project**, or **Skip**
2. Mapping uses existing `riotplan_context` project entities
3. Create flow writes a new `project` entity then binds the plan
4. Decisions are cached in `workspaceState` to prevent repeated prompts for the same unresolved binding

### End-to-end verification checklist

- [x] HTTP server supports `--context-dir` with fallback to `--plans-dir`
- [x] Portable plan binding resolves `explicit -> inferred -> none`
- [x] `workspaceId` filtering works for plan list queries
- [x] VS Code tree rows display status icon and workspace/project labels
- [x] Unresolved transferred plan prompts map/create and refreshes list on success
- [x] Prompt decisions are cached to avoid repeat prompts

## Development

```bash
npm install
npm run compile
```

### Debugging

1. **Start the RiotPlan MCP server** (in a separate terminal):
   ```bash
   riotplan-mcp-http --port 3002 --plans-dir /path/to/plans
   ```

2. **Open the extension folder** in VS Code:
   - For multi-root workspace (e.g. kjerneverk): Use **"Launch Extension"** from the Run and Debug view
   - For single folder: Open `riotplan-vscode` as the workspace root, then use **"Launch Extension (single folder)"**

3. **Press F5** or run **Debug: Start Debugging** from the Command Palette

4. A new **Extension Development Host** window opens with the extension loaded. Set breakpoints in `src/` and they will hit when the extension runs.

## Building

```bash
npm run package
```

This creates a `.vsix` file that can be installed in VSCode.

## Architecture

The extension uses:
- **HTTP MCP Client**: JSON-RPC 2.0 over HTTP POST
- **Tree Data Provider**: Displays plans in a hierarchical view
- **Session Management**: Maintains session with Mcp-Session-Id header

## License

Apache-2.0
