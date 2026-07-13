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

3. **Normalize Requirement Content**
   - Before writing any steps, parse and clean the requirement content:
     - Strip HTML/XML tags from Confluence storage format (they contain no useful test information).
     - Identify the distinct sections: User Story, Acceptance Criteria, Business Rules, and Out of Scope.
     - If multiple acceptance criteria are listed, each one may become a separate test scenario.

4. **Design Granular Test Scenarios**
   - Create detailed YAML test scenarios covering both happy paths and negative/validation flows.
   - **Granularity Rule**: Keep steps atomic. Split compound actions into single distinct inputs/clicks (e.g., separate typing an address from clicking "Next").
   - **Funnels & Wizards**: For multi-step checkout or join funnels (like Genesis Energy Join), do not assume sub-steps are directly accessible. Start from the entry point (`url: https://www.genesisenergy.co.nz/join`) and guide the agent step-by-step through prerequisites before making final assertions.
   - **Detailed Context Block**: Provide a multi-line `context` description outlining prerequisites, login status, credential sources (e.g., `{{env:VARIABLE_NAME}}`), and starting views to make it easier for the execution agent to complete the test.
   - **Use Crawl History**: If a web crawl was performed (via the dashboard Generate from Rovo MCP feature), use the ordered crawl history as the blueprint for step ordering. Every screen discovered in the crawl must contribute at least 2-4 steps.

5. **Structure agent-qa Test Definitions (YAML)**
   Every test file must be structured as valid `agent-qa` YAML:
   - `name`: Clear, descriptive name of the test.
   - `test-id`: A canonical test ID generated using `agent_qa_generate_id` (fallback: `agent-qa ids generate test`). Never hand-write these.
   - `target`: The target environment name from configurations (e.g. `genesis-join`).
   - `use`: Browser and timeout settings block:
     ```yaml
     use:
       browser:
         name: chromium
         headless: true
       timeout:
         step: 3m
         test: 30m
     ```
   - `context`: A rich multi-line context block detailing starting URL, user auth state, required test data, and key preconditions.
   - `steps`: A list of granular, natural-language-only instructions. No Playwright code, CSS selectors, or XPath.

6. **Generate and Save Plans**
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
- Do not include Playwright selectors, CSS, XPath, or code snippets inside step instructions.
- Do not skip wizard steps — always start from the flow entry point and include all prerequisite steps in order.

