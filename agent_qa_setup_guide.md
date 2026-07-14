# agent-qa: Comprehensive Setup & Integration Guide

Welcome to the **agent-qa** setup guide. This document provides step-by-step instructions for setting up the monorepo from source, initializing a new test project, writing tests in natural language, configuring self-healing recovery, and using the developer dashboard.

---

## 1. Prerequisites

Before installing `agent-qa`, ensure the following dependencies are installed on your host system:

*   **Node.js**: Version `>= 24.0.0` is required.
*   **Package Managers**:
    *   **PNPM** (`>= 10.6.1` is recommended for monorepo development).
    *   **NPM** (comes pre-bundled with Node).
*   **Docker**: Required if you plan to run isolated lifecycle hooks (Node, Bun, Python, or Bash containers) during your test runs.
*   **Playwright / Appium Drivers**: Required for browser and mobile automation.

---

## 2. Building the Monorepo from Source

If you are contributing to or building `agent-qa` directly from the source repository:

1.  **Clone/Navigate to the Monorepo Root**:
    ```bash
    cd /path/to/agent-qa-main
    ```

2.  **Install Monorepo Dependencies**:
    Clean the environment and run `pnpm` to download and link workspaces:
    ```bash
    pnpm install
    ```

3.  **Compile the Workspace**:
    Compile all modules (core execution engine, CLI, dashboard UI, and MCP server) in the correct dependency order using Turborepo:
    ```bash
    pnpm build
    ```

4.  **Verify Setup with Unit Tests**:
    Ensure everything is green by running the vitest suite:
    ```bash
    pnpm test
    ```

---

## 3. Initializing a New Test Project (Using CLI)

To set up a new test automation project or integrate `agent-qa` into an existing repository:

1.  **Install the Package**:
    ```bash
    npm install -D agent-qa
    ```

2.  **Initialize the Project Workspace**:
    Create the boilerplate configuration (`agent-qa.config.yaml`), logs directory, and default folders:
    ```bash
    npx agent-qa init
    ```

3.  **Download Required Browser Binaries**:
    Ensure the browser binaries are installed for Playwright:
    ```bash
    npx agent-qa install-browsers --chromium
    ```

4.  **Install Mobile Driver Support (Optional)**:
    If testing iOS or Android apps, install the driver registry:
    ```bash
    npx agent-qa install-mobile-drivers --all
    ```

---

## 4. Configuration (`agent-qa.config.yaml`)

Define your test targets, directories, memory store, and LLM providers. Here is a recommended configuration:

```yaml
# agent-qa.config.yaml
workspace:
  testMatch:
    - tests/web/**/*.yaml
    - tests/mobile/**/*.yaml
  hooksFile: hooks.yaml
  agentRules: ./agent-rules.md
  envFile: .env
  secretsFile: .env.secrets.local

services:
  cache:
    dir: .agent-qa/cache
    ttl: 7d
  accessibility:
    enabled: true
    standard: wcag2aa
    runAfter: every-step
    failOnViolation: false
  memory:
    dir: agent-qa-memory

registry:
  llms:
    - name: custom-openai
      provider: openai-compatible
      model: gpt-5.4-mini
      baseURL: https://api.openai.com/v1
  targets:
    genesis-join:
      platform: web
      url: https://www.genesisenergy.co.nz/join

use:
  llm: custom-openai
  healing:
    maxAttempts: 3  # Enables the step-level self-healing recovery loop
```

### Environment Secrets (`.env` & `.env.secrets.local`)
Create a `.env` file to hold provider keys or local variables (e.g. `OPENAI_API_KEY=sk-...`). These variables are loaded into execution context and redacted in logs.

---

## 5. Writing Tests in YAML (Natural Language)

Tests are written in declarative natural language. Create a test file under `tests/web/genesis-join.yaml`:

```yaml
name: Genesis Join Flow - Recommended Energy Plan Selection
description: Test the residential energy plan selection flow.
target: genesis-join
steps:
  - Verify the plans page heading says "Which plan works for you?"
  - Verify the plans page shows the available electricity plan options
  - Click the "Select PowerHome plan" button
  - Verify the PowerHome plan is highlighted or otherwise marked as selected
  - Click the Continue button
  - Verify the chosen plan selection is preserved when proceeding
```

> [!TIP]
> **Playwright Timeout Assertions**: For applications with slow backend APIs (like Genesis Energy), increase navigation timeouts or add manual timeouts in your `agent-rules.md` to prevent flaky assertions.

---

## 6. Execution & Step-Level Self-Healing

Run your tests using the command-line interface:

```bash
# Headless run of a single test file
npx agent-qa run tests/web/genesis-join.yaml
```

### How the Step-Level Self-Healer Works
When a step fails, the harness does not fail immediately. It triggers the **Self-Healing Recovery Loop**:
1.  **Observe & Reflection**: It logs the execution error, captures the DOM state, and constructs a recovery instruction.
2.  **Autonomous Recovery Action**: It commands the LLM to perform repair sub-actions (e.g. click suggestions, clear error validation banners).
3.  **Step Retry**: Once the page state is healed, it retries the original failed step.
4.  **Status Override**: If the retried step passes, it is flagged as `'healed'`, allowing the pipeline to finish green.

---

## 7. Developer Dashboard

Manage your workspaces, view run results, inspect DOM traces, and analyze trends.

### Running the Dashboard
To start the dashboard server:

```bash
# Using local built CLI (Monorepo dev)
node packages/cli/dist/cli.js dashboard

# Using npm package CLI
npx agent-qa dashboard
```

Open `http://localhost:3470` in your browser.

### Inspecting Analytics and Metrics
Navigate to the **Insights** tab of a test run to inspect execution health:

*   **Total Runs**: Historical count of tests executed.
*   **Pass Rate**: Percentage of runs that passed.
*   **Flaky Score**: Rate of test runs that passed after retries or required healing.
*   **Heal Count & Heal Rate**: Number and percentage of runs where at least one step was successfully repaired.
*   **Retry Count & Retry Rate**: Tracked retry occurrences across runs.

---

## 8. Troubleshooting Spawning Issues (Windows)

On **Windows Environments**, Node may throw `EINVAL` or `DEP0190` shell spawn warnings when executing processes. 

To resolve this, the local CLI runs commands explicitly wrapped via `cmd.exe /c` (e.g., `cmd.exe /c cli.js dashboard`). Ensure that your environment path resolutions for Node are absolute and point directly to active `.js` or `.mjs` scripts when initiating processes.
