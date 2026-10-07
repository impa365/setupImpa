"""Startup API contract self-check.

Guards against installer drift: app modules are written against a moving set
of helper APIs (checks, portainer_client, registry, validate). When a helper is
renamed or removed the install blows up only at runtime — after a user pressed
"Install". This module statically walks the installer sources, resolves the
``module.attr`` references against the module actually imported in each file
(honouring ``from x import y as z`` aliases), and reports missing attributes.

It is import-aware and conservative: only ``Name.attr`` where ``Name`` resolves
to a known helper module is inspected, so local variables that happen to be
named ``auth``/``checks`` are ignored.
"""
from __future__ import annotations

import ast
import importlib
import logging
from pathlib import Path

log = logging.getLogger("setupimpa.contract")

# canonical helper modules, addressed by their full dotted path
HELPER_MODULES = (
    "installer.checks",
    "installer.portainer_client",
    "installer.registry",
    "installer.validate",
    "installer.cloudflare",
    "installer.base",
    "installer.devops",
    "installer.metrics_history",
    "installer.panel_domain",
    "installer.auth",
    "installer.orion_engine",
    "installer.apps.postgres",
    "installer.apps.evolution",
    "installer.apps.getfy",
    "installer.apps.hermes",
    "installer.apps.ninerouter",
    "installer.apps.omniroute",
    "mcp.auth",
    "mcp.security",
    "mcp.tools",
)

_MOD_CACHE: dict[str, object] = {}


def _module(dotted: str) -> object | None:
    if dotted not in _MOD_CACHE:
        try:
            _MOD_CACHE[dotted] = importlib.import_module(dotted)
        except Exception:
            _MOD_CACHE[dotted] = None
    return _MOD_CACHE[dotted]


def _import_aliases(tree: ast.Module) -> dict[str, str]:
    """Map local alias -> dotted module path declared via import statements."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for a in node.names:
                # ``from installer import checks`` -> checks -> installer.checks
                aliases[a.asname or a.name] = f"{node.module}.{a.name}"
        elif isinstance(node, ast.Import):
            for a in node.names:
                aliases[(a.asname or a.name).split(".")[0]] = a.name
    return aliases


def find_undefined_calls(root: Path | None = None) -> list[tuple[str, int, str]]:
    """Return (file, lineno, ``alias.attr``) for undefined helper calls."""
    root = root or Path(__file__).resolve().parent
    helper_set = set(HELPER_MODULES)
    problems: list[tuple[str, int, str]] = []

    for f in sorted(root.rglob("*.py")):
        if "__pycache__" in f.parts or f.name == "contract.py":
            continue
        src = f.read_text(encoding="utf-8")
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue

        aliases = _import_aliases(tree)
        # keep only aliases that resolve to a known helper module
        helpers = {a: m for a, m in aliases.items() if m in helper_set}

        for node in ast.walk(tree):
            if not isinstance(node, ast.Attribute):
                continue
            base = node.value
            if not isinstance(base, ast.Name):
                continue
            dotted = helpers.get(base.id)
            if not dotted:
                continue
            mod = _module(dotted)
            if mod is not None and not hasattr(mod, node.attr):
                try:
                    rel = f.relative_to(root.parent)
                except ValueError:
                    rel = f
                problems.append((str(rel), node.lineno, f"{base.id}.{node.attr}"))

    # de-duplicate (same file/line/call seen once)
    return sorted(set(problems))


def verify_or_log() -> bool:
    """Run the contract check, logging a loud error when drift is found."""
    problems = find_undefined_calls()
    if problems:
        log.error(
            "INSTALLER API CONTRACT DRIFT: %d undefined helper call(s) detected. "
            "Installs may fail at runtime. Fix before shipping.",
            len(problems),
        )
        for path, line, call in problems:
            log.error("  %s:%s -> %s", path, line, call)
        return False
    log.info("Installer API contract OK (no undefined helper calls)")
    return True


if __name__ == "__main__":  # pragma: no cover
    import sys

    bad = find_undefined_calls()
    if bad:
        print(f"UNDEFINED CALLS: {len(bad)}")
        for path, line, call in bad:
            print(f"  {path}:{line} -> {call}")
        sys.exit(1)
    print("OK: no undefined helper calls")
