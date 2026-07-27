# agent-qa Setup & Installation Guide

This guide documents the proven setup steps to install dependencies and Chromium browser support for `agent-qa`, including workarounds for corporate SSL proxy restrictions and PowerShell script execution policies.

---

## 1. Node Package Installation (SSL Restriction Workaround)

If you encounter `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` errors when downloading packages via `npx` or `npm`:

### Step 1: Disable Strict SSL in npm Config
Configure `npm` to bypass strict SSL verification:

```powershell
npm config set strict-ssl false
```

> **Note**: To re-enable strict SSL in the future, run:
> ```powershell
> npm config set strict-ssl true
> ```

### Step 2: Install Dependencies
Run the installation command using `npx`:

```powershell
npx --yes pnpm install
```

---

## 2. Chromium Browser Installation

To install the Chromium browser support required by `agent-qa`:

### Running from a Subdirectory (e.g. `demo-project`)

```powershell
node ../packages/cli/dist/cli.js install-browsers --chromium
```

### Running from Monorepo Root

```powershell
node packages/cli/dist/cli.js install-browsers --chromium
```

---

## Summary of Commands

| Purpose | Command |
| :--- | :--- |
| **Disable Strict SSL** | `npm config set strict-ssl false` |
| **Install Dependencies** | `npx --yes pnpm install` |
| **Install Chromium (Subfolder)** | `node ../packages/cli/dist/cli.js install-browsers --chromium` |
| **Install Chromium (Root)** | `node packages/cli/dist/cli.js install-browsers --chromium` |
| **Re-enable Strict SSL** | `npm config set strict-ssl true` |
