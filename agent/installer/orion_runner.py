"""SetupOrion Headless Runner — Subprocess bridge for running SetupOrion bash functions directly."""
from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any

if os.name != "nt":
    try:
        import pty
    except ImportError:
        pty = None
else:
    pty = None

log = logging.getLogger("setupimpa.orion_runner")

ORION_MAIN_PATH = Path("/root/setuporion_main.sh")
LOCAL_ORION_PATH = Path(__file__).resolve().parent.parent.parent.parent / "scripts" / "setuporion_main.sh"


def get_orion_script_path() -> Path | None:
    if ORION_MAIN_PATH.exists():
        return ORION_MAIN_PATH
    if LOCAL_ORION_PATH.exists():
        return LOCAL_ORION_PATH
    return None


def run_orion_func(func_name: str, inputs: list[str], timeout: int = 300) -> dict[str, Any]:
    """Execute a function from setuporion_main.sh by piping input line-by-line."""
    script = get_orion_script_path()
    if not script:
        return {"ok": False, "error": "setuporion_main.sh não encontrado no servidor"}

    # Prepare inline wrapper script that sources setuporion_main.sh and calls the function
    # Mock clear and sleep to avoid long terminal waits
    wrapper = f"""
source "{script.as_posix()}"
clear() {{ :; }}
sleep() {{ :; }}
{func_name}
"""
    input_data = "\n".join(inputs) + "\n"

    try:
        proc = subprocess.run(
            ["bash", "-c", wrapper],
            input=input_data,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Execução de {func_name} expirou após {timeout}s"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
