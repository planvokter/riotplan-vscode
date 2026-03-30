# RiotPlan VSCode Extension - Infrastructure

This document describes the project infrastructure that matches the standards used across other Kjerneverk packages.

## Project Files

### Configuration Files

- **`.gitignore`** - Git ignore patterns for build artifacts, dependencies, and IDE files
- **`.npmignore`** - NPM publish ignore patterns (excludes source, tests, config files)
- **`.npmrc`** - NPM configuration with provenance enabled
- **`.vscodeignore`** - VSCode extension packaging ignore patterns
- **`tsconfig.json`** - TypeScript compiler configuration
- **`package.json`** - Package metadata, scripts, and dependencies
- **`LICENSE`** - Apache 2.0 license

### GitHub Workflows

Located in `.github/workflows/`:

#### `test.yml`
- Runs on push to main, working, release/*, feature/*, dependabot/* branches
- Runs on pull requests to main
- Concurrency control to cancel in-progress runs
- Steps:
  1. Checkout code
  2. Setup Node.js 24
  3. Install dependencies with retry logic (handles npm registry propagation delays)
  4. Compile TypeScript

#### `publish-vsce.yml`
- Runs on release creation and pushes to working branch
- Handles both production and pre-release versions
- Pre-release versions get timestamped: `1.0.0-dev.20260217105030.abc1234`
- Production versions only publish on release events
- Steps:
  1. Determine publish strategy based on version
  2. Install dependencies and VSCE CLI
  3. Update version for pre-releases
  4. Compile TypeScript
  5. Package extension (.vsix)
  6. Publish to VSCode Marketplace (on release only)

## Version Strategy

### Development Versions
- Format: `X.Y.Z-dev.TIMESTAMP.SHA`
- Example: `1.0.0-dev.20260217105030.abc1234`
- Published to VSCode Marketplace with pre-release tag
- Automatically published on push to `working` branch

### Production Versions
- Format: `X.Y.Z`
- Example: `1.0.0`
- Only published when a GitHub release is created
- Published to VSCode Marketplace as stable release

## Scripts

From `package.json`:

```json
{
  "vscode:prepublish": "npm run compile",
  "compile": "tsc -p ./",
  "watch": "tsc -watch -p ./",
  "package": "vsce package",
  "lint": "echo 'No linting configured yet'",
  "test": "echo 'No tests configured yet'"
}
```

## Dependencies

### Runtime Dependencies
- None (extension uses native Node.js HTTP)

### Development Dependencies
- `@types/node` - Node.js type definitions
- `@types/vscode` - VSCode API type definitions
- `@vscode/vsce` - VSCode extension packaging tool
- `typescript` - TypeScript compiler

## Publishing

### Manual Publishing
```bash
# Package extension
npm run package

# This creates a .vsix file that can be installed in VSCode
```

### Automated Publishing
- Push to `working` branch → Pre-release version published automatically
- Create GitHub release → Production version published automatically

### VSCode Marketplace
Requires `VSCE_PAT` secret in GitHub repository settings:
- Personal Access Token from Azure DevOps
- Used for publishing to VSCode Marketplace

## Infrastructure Consistency

This infrastructure matches the patterns used in:
- `@planvokter/riotplan-format`
- `@planvokter/riotplan`
- Other Kjerneverk packages

Key consistency points:
- Same `.gitignore` patterns
- Same `.npmignore` structure
- Same `.npmrc` configuration (provenance enabled)
- Similar GitHub workflow structure
- Same versioning strategy for dev/production
- Same retry logic for npm install
- Same Node.js version (24)
- Same license (Apache 2.0)
