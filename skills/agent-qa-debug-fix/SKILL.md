---
name: agent-qa-debug-fix
description: Use after an agent-qa run has failed and you need to debug, patch, and verify the issue using MCP evidence, logs, artifacts, and local code changes instead of generated fix suggestions.
metadata:
  short-description: Debug and fix failed agent-qa runs
---

# agent-qa Debug Fix

## Workflow

1. Start with evidence collection:
   - `agent_qa_get_run`
   - `agent_qa_get_run_steps`
   - `agent_qa_get_run_artifact`
   - `agent_qa_get_run_logs`
   - `agent_qa_get_run_execution_logs`
2. Call `agent_qa_classify_failure` and treat its category as a hypothesis, not a verdict.
3. Identify the failing surface: test definition, hook, application under test, runtime infrastructure, or agent behavior.
4. Inspect the relevant local files directly. Do not infer patches from artifacts alone.
5. Apply the smallest code or YAML change that explains the evidence.
   - **Prerequisite Step Healing**: If a test failed because a step was unreachable or failed validation (e.g., button is disabled or plan cards are missing), collect the screenshot of the current page where it got stuck, inspect the website's current DOM/ARIA structure and form fields, analyze what steps were missed earlier (e.g., incomplete address lookup, missing continue click, unselected checkbox), and insert the missing prerequisite steps (or modify existing steps) to make the test flow smoothly again.
6. Re-run the narrowest affected agent-qa test, suite, hook, or unit test.
7. Report the root cause, changed files, verification command, and any remaining risk.

## Fix Rules

- Do not invent selectors, screen states, screenshots, logs, or source files.
- Do not rewrite a test just to make it pass if the artifact shows a product or runtime defect.
- Preserve canonical agent-qa IDs when editing tests, suites, hooks, or memory files.
- Prefer `agent_qa_validate_test`, `agent_qa_validate_suite`, and `agent_qa_validate_definition` before re-running edited YAML.
- When MCP is unavailable, use dashboard REST APIs or local `.agent-qa` artifacts and state that MCP evidence was unavailable.
