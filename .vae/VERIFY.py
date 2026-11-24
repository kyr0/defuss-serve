"""Project-local defuss-vae verification policy."""
CONFIG = {
    "coverage_min": 85,
    "lint_command": None,
    "test_command": None,
    "coverage_command": None,
    "integration_commands": [],
    "e2e_commands": [],
    "e2e_paths": [],
    "timeout_s": 600,
    "ci": None,
    "layout": True,
    "strict": True,
    "toolchain": True,
    "gitignore_exempt": [],
    "readme": {"exclude": []},
    "arch": {"exclude": []},
    "package": {"manager": "bun", "type": "module", "lint": "oxlint", "library_build": "pkgroll"},
    # AGENTS.md: the init-managed defuss-vae block uses VAE-DIALECT, where → is a defined sequence operator.
    "prose": {"allow": {"AGENTS.md": "→"}, "phrases": [], "html": []},
}
RULES = [
    {"id": "repo.policy", "kind": "command", "command": "python3 .vae/checks/policy.py", "claim": "Runtime dependency boundary and required verification commands are intact."},
    {"id": "tests.no-mocks", "kind": "not_regex", "glob": "tests/*.ts", "pattern": r"\b(?:vi|jest)\.(?:mock|fn|spyOn)\(|sinon\.", "claim": "Tests use real HTTP listeners and files."},
    {"id": "ci.verify", "kind": "contains", "path": ".github/workflows/verify.yml", "text": "run: make verify", "claim": "CI exercises the same verification verbs."},
    {"id": "bun.no-reuse-port", "kind": "contains", "path": "src/runtime/bun.ts", "text": "reusePort: false", "claim": "Bun 1.4 development:false implies SO_REUSEPORT; the listener must fail on an occupied port."},
    {"id": "e2e.artifact", "kind": "contains", "path": "scripts/e2e.ts", "text": "--pack-destination", "claim": "E2E exercises the packed artifact."},
]
