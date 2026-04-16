---
name: analyze
description: Deep analysis and investigation
---

# Deep Analysis Mode

[ANALYSIS MODE ACTIVATED]

## Objective

Conduct thorough analysis of the specified target (code, architecture, issue, bug, performance bottleneck, security concern).

## Approach

1. **Gather Context**
   - Read relevant files
   - Check git history if relevant
   - Review related issues/PRs if applicable

2. **Analyze Systematically**
   - Identify patterns and antipatterns
   - Trace execution flows
   - Map dependencies and relationships
   - Check for edge cases

   **For Debugging/Bug Analysis (4-Phase Protocol)**

   When analyzing bugs or issues, follow systematic debugging:

   - **Root Cause First** - Never skip to fixes
     - Read ALL error messages
     - Reproduce consistently
     - Document hypothesis before looking at code

   - **Pattern Analysis** - Find working vs broken
     - Compare with working similar code
     - Identify the specific delta

   - **3-Failure Circuit Breaker** - If stuck:
     - After 3 failed hypotheses, question the architecture
     - The bug may be elsewhere entirely

3. **Synthesize Findings**
   - Root cause (for bugs)
   - Design decisions and tradeoffs (for architecture)
   - Bottlenecks and hotspots (for performance)
   - Vulnerabilities and risks (for security)

4. **Provide Recommendations**
   - Concrete, actionable next steps
   - Prioritized by impact
   - Consider maintainability and technical debt

## Output Format

Present findings clearly:
- **Summary** (2-3 sentences)
- **Key Findings** (bulleted list)
- **Analysis** (detailed explanation)
- **Recommendations** (prioritized)

Stay objective. Cite file paths and line numbers. No speculation without evidence.

## External Model Consultation (Preferred)

During deep analysis, you SHOULD consult Codex for validation.

### Protocol
1. **Form your OWN analysis FIRST** - Complete analysis independently
2. **Consult for validation** - Cross-check findings
3. **Critically evaluate** - Never blindly adopt external conclusions
4. **Graceful fallback** - Never block if tools unavailable

### When to Consult
- Root cause analysis for complex bugs
- Architectural pattern analysis
- Performance bottleneck identification
- Security vulnerability assessment

### When to Skip
- Simple code analysis
- Well-understood patterns
- Time-critical debugging
- Straightforward investigations

### Tool Usage
Use `mcp__x__ask_codex` with:
- `agent_role: "architect"` for architectural analysis
- `agent_role: "analyst"` for requirements/root cause analysis
