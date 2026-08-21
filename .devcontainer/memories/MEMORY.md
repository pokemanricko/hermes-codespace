User prefers concise practical responses, working artifacts over descriptions, honesty with caveats. Dislikes fabricated output - report blockers honestly.
§
CI/CD workflow: PR-to-main + merge gate; content-only changes (skills/**, *.sh, memories/**) → lint-check only (30s); infrastructure changes (boot scripts, devcontainer.json, workflows) → full build (15min). Must run ci-lint-check locally before pushing.
§
Merge gate: Must check GitHub CodeQL and Copilot review suggestions via github-pr-review skill before merging. Present findings for approval. No auto-merge.
§
Memory: Uses Mnemon (mnemon_remember/recall) as primary provider. Insights must be merged into .devcontainer/mnemon/seed.json for cross-spawn persistence. Validate with mnemon import --dry-run. Never edit .devcontainer/memories/USER.md or MEMORY.md without asking first.
§
Wiki vs Skill distinction: Wiki = reference knowledge (.devcontainer/wiki/), Skill = procedural (.devcontainer/skills/). They should stay in sync on same topic. Wiki naming convention: use 'wiki' not 'knowledge'.
§
Coding discipline: Karpathy guidelines - minimal surgical changes, think before coding, no drive-by refactoring, no speculative abstractions. Verify with real command output, not assertions.
§
Repo hygiene: Rejects vendoring heavy third-party skills with their CI/workflow noise. Prefers live install via one-shot installer and Hermes discovery from ~/.hermes/skills. Only persist user's own small config files + idempotent boot guards.
§
Naming: 'Pi-agent' (not 'PyAgent'). Version pinning for all tools (NODE_VERSION, OMNIROUTE_VERSION, PI_AGENT_VERSION, etc.) matching existing patterns in post-create-cmd.sh.
§
Infra invariants must be auto-verified in CI, not just documented. Proposals iterated in Lavish, not MD files. Self-check.sh validates symlinks (memories + skills) with 3-case guard logic.