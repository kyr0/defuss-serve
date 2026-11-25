"""Deterministic repository contract; exits nonzero on invariant violation."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
pkg = json.loads((root / "package.json").read_text())
assert not pkg.get("dependencies"), "Core must have no external runtime dependencies"
assert pkg["type"] == "module" and pkg["packageManager"].startswith("bun@")
for name in (".", "./plugins"):
    for mode, suffix in (("import", ".mjs"), ("require", ".cjs")):
        entry = pkg["exports"][name][mode]
        assert entry["default"].endswith(suffix) and entry["types"].endswith(".d.mts" if mode == "import" else ".d.cts")
make = (root / "Makefile").read_text()
for verb in ("setup", "build", "lint", "test", "coverage", "e2e", "verify", "start", "clean"):
    assert f"{verb}:" in make, f"Missing {verb}"
assert "bun run test:bun" in make and "REQUIRE_BUN=1" in make
# Bun 1.4.3 on PATH failed the Bun WebSocket test the pinned 1.4.5 passes: every build checks the active Bun first.
assert "mise bin-paths" in make and "build: toolchain" in make, "Makefile must put the mise pins on PATH and check Bun before build"
assert "release-verify: lock-check" in make and "git ls-files --error-unmatch bun.lock" in make
assert all(not v.startswith(("^", "~", ">", "*")) for v in pkg["devDependencies"].values()), "Pin direct development versions"
assert "run: make verify" in (root / ".github/workflows/verify.yml").read_text()
for path in (root / "src").rglob("*.ts"):
    content = path.read_text()
    assert path.name == "ownership.ts" or "Symbol.for(" not in content, f"Process-global registry in {path}"
    assert not any(f"from '{name}" in content for name in ("express", "fastify", "hono", "defuss-rpc", "defuss-mcp", "defuss-o11y")), f"Protocol/framework import in {path}"
print("Repository policy PASS")
