"""Smoke tests for the SetupImpa installer.

Runs offline checks (syntax, API contract, compose rendering, registry schema)
without touching the VPS. Exit non-zero on any failure.
"""
import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
AGENT = ROOT / "agent"
sys.path.insert(0, str(AGENT))

fails: list[str] = []


def check(name, fn):
    try:
        fn()
        print(f"  PASS  {name}")
    except Exception as e:
        fails.append(name)
        print(f"  FAIL  {name}: {type(e).__name__}: {e}")


# 1. every python file parses
def test_syntax():
    for f in AGENT.rglob("*.py"):
        if "__pycache__" in f.parts:
            continue
        ast.parse(f.read_text(encoding="utf-8"))


# 2. API contract — no undefined helper calls
def test_contract():
    import contract

    bad = contract.find_undefined_calls()
    assert not bad, f"undefined helper calls: {bad}"


# 3. every official app module exposes meta() with an id and install()
def test_app_modules():
    import importlib

    for name in ("postgres", "evolution", "getfy", "hermes", "ninerouter", "omniroute"):
        mod = importlib.import_module(f"installer.apps.{name}")
        m = mod.meta()
        assert m.get("id"), f"{name}.meta() missing id"
        assert callable(getattr(mod, "install", None)), f"{name} missing install()"


# 4. registry round-trip with a temp file
def test_registry_roundtrip(tmp_path=None):
    import tempfile
    import installer.registry as reg

    orig = reg.REGISTRY_PATH
    try:
        reg.REGISTRY_PATH = pathlib.Path(tempfile.mktemp(suffix=".json"))
        iid, num = reg.next_instance_id("unittest")
        assert (iid, num) == ("unittest", 1)
        reg.register("unittest", iid, num, stack_name=iid, domain="x.test",
                     credentials={"password": "s3cr3t"}, params={})
        got = reg.get("unittest")
        assert got and got["credentials"]["password"] == "s3cr3t"
        iid2, num2 = reg.next_instance_id("unittest")
        assert (iid2, num2) == ("unittest_2", 2), (iid2, num2)
        assert reg.unregister("unittest")
    finally:
        reg.REGISTRY_PATH = orig


# 5. orion engine: render a compose for every catalog app that has a template
def test_orion_render():
    import installer.orion_engine as oe

    apps = oe.list_apps()
    assert apps, "catalog is empty"
    rendered = 0
    for app in apps:
        if not app.get("yaml_template"):
            continue
        try:
            yaml_text, secrets_ = oe.render_compose(app["id"], {"domain": "test.example.com"}, app["id"], 1)
            assert yaml_text.strip(), f"{app['id']} rendered empty"
            # no unsubstituted variable tokens; numeric $1 backreferences are fine
            leftover = re.findall(r"\$\{?[a-zA-Z_][a-zA-Z0-9_]*", yaml_text)
            assert not leftover, f"{app['id']} has leftover vars: {sorted(set(leftover))[:5]}"
            rendered += 1
        except Exception as e:
            raise AssertionError(f"render failed for {app['id']}: {e}") from e
    assert rendered > 0, "no templates rendered"


# 6. orion engine functions referenced by install() exist and are callable
def test_orion_api():
    import installer.orion_engine as oe
    import installer.portainer_client as pc
    import installer.validate as v

    assert callable(pc.create_swarm_stack), "portainer_client.create_swarm_stack missing"
    assert callable(v.wait_stack), "validate.wait_stack missing"
    assert callable(oe.get_ui_fields), "orion_engine.get_ui_fields missing"
    fields = oe.get_ui_fields("n8n") if oe.get_app("n8n") else []
    assert isinstance(fields, list)


print("=" * 68)
print("SetupImpa installer smoke tests")
print("=" * 68)
check("syntax: all python parses", test_syntax)
check("contract: no undefined helper calls", test_contract)
check("app modules expose meta()+install()", test_app_modules)
check("registry: round-trip + multi-instance", test_registry_roundtrip)
check("orion: renders every catalog template", test_orion_render)
check("orion: helper API present", test_orion_api)
print("=" * 68)
if fails:
    print(f"FAILED: {len(fails)} -> {fails}")
    sys.exit(1)
print("ALL TESTS PASSED")
