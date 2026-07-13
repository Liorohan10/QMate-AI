---
name: agent-qa-test-planner
description: Use when you need to create a comprehensive agent-qa YAML test plan or test suite for a web application or website by analyzing requirements and page structure.
metadata:
  short-description: Design and create agent-qa YAML test plans
---

# agent-qa Test Planner

## Workflow

1. **Inspect Target Configuration**
   - Use `agent_qa_get_config` to read the active target configurations (e.g. `genesis-join`).
   - Identify the starting target URL context.

2. **Understand Requirements & Structure**
   - Gather Normalized Requirement JSON (from Jira/Confluence).
   - Identify the User Story, Acceptance Criteria, and Business Rules.
   - Inspect the website's pages and DOM structure. If dynamic browser crawling is available, read the page layout context (headings, buttons, inputs).

3. **Design Granular Test Scenarios**
   - Create detailed YAML test scenarios covering both happy paths and negative/validation flows.
   - **Granularity Rule**: Keep steps atomic. Split compound actions into single distinct inputs/clicks (e.g., separate typing an address from clicking "Next").
   - **Funnels & Wizards**: For multi-step checkout or join funnels (like Genesis Energy Join), do not assume sub-steps are directly accessible. Start from the entry point (`url: https://www.genesisenergy.co.nz/join`) and guide the agent step-by-step through prerequisites before making final assertions.

4. **Structure agent-qa Test Definitions (YAML)**
   Every test file must be structured as valid `agent-qa` YAML:
   - `name`: Clear, descriptive name of the test.
   - `test-id`: A canonical test ID generated using `agent_qa_generate_id` (fallback: `agent-qa ids generate test`). Never hand-write these.
   - `url`: Starting URL (e.g. `https://www.genesisenergy.co.nz/join`).
   - `meta`: (Optional) labels, description, or custom timeout/retry fields.
   - `steps`: A list of granular instructions.

5. **Generate and Save Plans**
   - Generate test IDs dynamically.
   - Format the test plan in markdown/YAML.
   - Use `agent_qa_create_test` to save and register the new test cases in the configured test directory (e.g., `tests/web/US-101-join-flow/`).
   - Validate the generated definition with `agent_qa_validate_test`.

## Required ID Contracts

- Test IDs: `t_` + 10 id-agent words (e.g. `t_hotel-mist-fred-repair-rhein-clean-cor-encode-fresh-their`). Always use the generator tools.

## Do Not

- Do not write TypeScript or Playwright spec code (`.spec.ts`); always write `agent-qa` YAML definitions (`.yaml`).
- Do not create compound or vague test steps.
- Do not hand-write IDs.
