"""SetupImpa — DevOps telemetry and server metrics (CPU, RAM, Disk, Swarm, Containers)."""
from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from . import checks, registry

# Cache previous CPU times for non-blocking instantaneous CPU % calculation
_LAST_CPU_TIMES: tuple[float, float, float] | None = None  # (timestamp, total, idle)
_CACHED_PUBLIC_IP: str = ""
_CACHED_IP_TIME: float = 0.0


def _get_public_ip_cached() -> str:
    global _CACHED_PUBLIC_IP, _CACHED_IP_TIME
    now = time.time()
    if _CACHED_PUBLIC_IP and (now - _CACHED_IP_TIME) < 600:
        return _CACHED_PUBLIC_IP
    try:
        ip = checks.public_ip()
        if ip:
            _CACHED_PUBLIC_IP = ip
            _CACHED_IP_TIME = now
            return ip
    except Exception:
        pass
    return _CACHED_PUBLIC_IP or ""


def _get_raw_cpu_times() -> tuple[float, float] | None:
    proc_stat = Path("/proc/stat")
    if not proc_stat.exists():
        return None
    try:
        first_line = proc_stat.read_text().splitlines()[0]
        parts = [float(x) for x in first_line.split()[1:8]]
        # user, nice, system, idle, iowait, irq, softirq
        idle = parts[3] + parts[4]
        total = sum(parts)
        return total, idle
    except Exception:
        return None


def calculate_cpu_percent() -> float:
    global _LAST_CPU_TIMES
    now = time.time()
    current = _get_raw_cpu_times()
    if not current:
        return 0.0

    cur_total, cur_idle = current

    # If we have a cached reading from less than 15 seconds ago, use it
    if _LAST_CPU_TIMES is not None:
        last_time, last_total, last_idle = _LAST_CPU_TIMES
        diff_time = now - last_time
        diff_total = cur_total - last_total
        diff_idle = cur_idle - last_idle
        if 0.2 <= diff_time <= 15.0 and diff_total > 0:
            pct = (1.0 - (diff_idle / diff_total)) * 100.0
            _LAST_CPU_TIMES = (now, cur_total, cur_idle)
            return max(0.0, min(100.0, round(pct, 1)))

    # Fallback: short sample
    time.sleep(0.08)
    sample2 = _get_raw_cpu_times()
    if sample2 and sample2[0] > cur_total:
        diff_total = sample2[0] - cur_total
        diff_idle = sample2[1] - cur_idle
        pct = (1.0 - (diff_idle / diff_total)) * 100.0
        _LAST_CPU_TIMES = (time.time(), sample2[0], sample2[1])
        return max(0.0, min(100.0, round(pct, 1)))

    _LAST_CPU_TIMES = (now, cur_total, cur_idle)
    return 0.0


def get_cpu_model() -> str:
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        try:
            for line in cpuinfo.read_text().splitlines():
                if "model name" in line:
                    return line.split(":", 1)[1].strip()
        except Exception:
            pass
    return platform.processor() or "Processador Padrão"


def get_uptime() -> dict[str, Any]:
    uptime_path = Path("/proc/uptime")
    if uptime_path.exists():
        try:
            total_secs = float(uptime_path.read_text().split()[0])
            days = int(total_secs // 86400)
            hours = int((total_secs % 86400) // 3600)
            mins = int((total_secs % 3600) // 60)
            if days > 0:
                human = f"{days}d {hours}h {mins}m"
            elif hours > 0:
                human = f"{hours}h {mins}m"
            else:
                human = f"{mins}m"
            return {"seconds": int(total_secs), "human": human}
        except Exception:
            pass
    return {"seconds": 0, "human": "Indisponível"}


def get_memory_stats() -> dict[str, Any]:
    mem: dict[str, int] = {}
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        try:
            for line in meminfo.read_text().splitlines():
                parts = line.split(":")
                if len(parts) == 2:
                    k, v = parts[0].strip(), parts[1].strip().split()[0]
                    if v.isdigit():
                        mem[k] = int(v) // 1024  # convert to MB
        except Exception:
            pass

    total = mem.get("MemTotal", 0)
    available = mem.get("MemAvailable", mem.get("MemFree", 0))
    free = mem.get("MemFree", 0)
    buffers = mem.get("Buffers", 0)
    cached = mem.get("Cached", 0)
    used = total - available if total > available else 0
    percent = round((used / total) * 100, 1) if total > 0 else 0.0

    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)
    swap_used = swap_total - swap_free if swap_total > swap_free else 0
    swap_percent = round((swap_used / swap_total) * 100, 1) if swap_total > 0 else 0.0

    return {
        "total_mb": total,
        "used_mb": used,
        "free_mb": free,
        "available_mb": available,
        "cached_mb": cached + buffers,
        "percent": percent,
        "swap_total_mb": swap_total,
        "swap_used_mb": swap_used,
        "swap_percent": swap_percent,
    }


def get_disk_stats() -> dict[str, Any]:
    try:
        usage = shutil.disk_usage("/")
        total_gb = round(usage.total / (1024**3), 1)
        used_gb = round(usage.used / (1024**3), 1)
        free_gb = round(usage.free / (1024**3), 1)
        percent = round((usage.used / usage.total) * 100, 1) if usage.total else 0.0
        return {
            "total_gb": total_gb,
            "used_gb": used_gb,
            "free_gb": free_gb,
            "percent": percent,
            "mount": "/",
        }
    except Exception:
        return {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0.0, "mount": "/"}


def get_container_telemetry() -> list[dict[str, Any]]:
    stats_map: dict[str, dict[str, Any]] = {}

    # 1. Fetch live container CPU/Mem stats from docker stats
    try:
        out = subprocess.check_output(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}"],
            text=True,
            timeout=3,
            stderr=subprocess.DEVNULL,
        )
        for line in out.strip().splitlines():
            parts = line.split("\t")
            if len(parts) >= 4:
                cname = parts[0].strip()
                cpu_str = parts[1].strip()
                mem_str = parts[2].strip()
                mem_pct_str = parts[3].strip()
                net_str = parts[4].strip() if len(parts) > 4 else "-"

                # Parse float percentages
                cpu_val = float(cpu_str.replace("%", "").strip() or 0.0)
                mem_pct_val = float(mem_pct_str.replace("%", "").strip() or 0.0)

                stats_map[cname] = {
                    "cpu_pct": cpu_val,
                    "cpu_str": cpu_str,
                    "mem_str": mem_str,
                    "mem_pct": mem_pct_val,
                    "net_str": net_str,
                }
    except Exception:
        pass

    # 2. Query docker inspect / containers list for metadata
    containers: list[dict[str, Any]] = []
    try:
        import docker
        client = docker.DockerClient(base_url="unix://var/run/docker.sock")
        raw_containers = client.containers.list(all=False)

        for c in raw_containers:
            labels = c.labels or {}
            stack = (
                labels.get("com.docker.stack.namespace")
                or labels.get("com.docker.compose.project")
                or "standalone"
            )
            name = c.name

            # Clean name for readable UI (e.g. postgres_postgres.1.xxx -> postgres)
            clean_name = name
            if "." in clean_name:
                clean_name = clean_name.split(".")[0]
            if "_" in clean_name and not clean_name.startswith("setupimpa"):
                clean_name = clean_name.replace("_", " → ")

            img_name = c.image.tags[0] if c.image.tags else (c.image.id[:12] if c.image else "unknown")

            st = stats_map.get(name, {})

            containers.append({
                "id": c.short_id,
                "name": name,
                "clean_name": clean_name,
                "stack": stack,
                "image": img_name,
                "status": c.status,
                "cpu_pct": st.get("cpu_pct", 0.0),
                "cpu_str": st.get("cpu_str", "0.0%"),
                "mem_str": st.get("mem_str", "-"),
                "mem_pct": st.get("mem_pct", 0.0),
                "net_str": st.get("net_str", "-"),
            })
    except Exception:
        # Fallback to docker ps
        try:
            out = subprocess.check_output(
                ["docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"],
                text=True,
                timeout=3,
                stderr=subprocess.DEVNULL,
            )
            for line in out.strip().splitlines():
                parts = line.split("\t")
                if parts:
                    name = parts[0].strip()
                    img = parts[1].strip() if len(parts) > 1 else ""
                    status = parts[2].strip() if len(parts) > 2 else "running"
                    st = stats_map.get(name, {})
                    containers.append({
                        "id": name[:10],
                        "name": name,
                        "clean_name": name,
                        "stack": "docker",
                        "image": img,
                        "status": status,
                        "cpu_pct": st.get("cpu_pct", 0.0),
                        "cpu_str": st.get("cpu_str", "0.0%"),
                        "mem_str": st.get("mem_str", "-"),
                        "mem_pct": st.get("mem_pct", 0.0),
                        "net_str": st.get("net_str", "-"),
                    })
        except Exception:
            pass

    # Sort by CPU usage descending, then Memory
    containers.sort(key=lambda x: (x.get("cpu_pct", 0), x.get("mem_pct", 0)), reverse=True)
    return containers


def collect_devops_stats() -> dict[str, Any]:
    """Collect complete DevOps server telemetry."""
    cpu_cores = os.cpu_count() or 1
    cpu_percent = calculate_cpu_percent()
    cpu_model = get_cpu_model()

    load1, load5, load15 = (0.0, 0.0, 0.0)
    if hasattr(os, "getloadavg"):
        try:
            l = os.getloadavg()
            load1, load5, load15 = round(l[0], 2), round(l[1], 2), round(l[2], 2)
        except Exception:
            pass

    mem_stats = get_memory_stats()
    disk_stats = get_disk_stats()
    uptime_info = get_uptime()

    osr = checks._read_os_release()
    distro_name = osr.get("PRETTY_NAME", f"{osr.get('NAME', 'Linux')} {osr.get('VERSION', '')}").strip()

    pub_ip = _get_public_ip_cached()
    swarm_active = checks.swarm_active()

    # Active stacks
    active_stacks = []
    try:
        out = subprocess.check_output(["docker", "stack", "ls", "--format", "{{.Name}}\t{{.Services}}"], text=True, timeout=2)
        for line in out.strip().splitlines():
            p = line.split("\t")
            if p and p[0].strip():
                active_stacks.append({
                    "name": p[0].strip(),
                    "services": p[1].strip() if len(p) > 1 else "1",
                })
    except Exception:
        pass

    containers = get_container_telemetry()

    warnings: list[str] = []
    if mem_stats["percent"] > 88:
        warnings.append(f"RAM Alta: {mem_stats['percent']}% ({mem_stats['used_mb']}/{mem_stats['total_mb']} MB)")
    if disk_stats["percent"] > 85:
        warnings.append(f"Disco Quase Cheio: {disk_stats['percent']}% ({disk_stats['used_gb']}/{disk_stats['total_gb']} GB)")
    if not swarm_active:
        warnings.append("Cluster Docker Swarm inativo")

    health_status = "HEALTHY"
    if warnings:
        health_status = "WARNING" if len(warnings) == 1 else "CRITICAL"

    return {
        "ok": True,
        "health": health_status,
        "warnings": warnings,
        "system": {
            "hostname": socket.gethostname(),
            "distro": distro_name,
            "kernel": platform.release(),
            "arch": platform.machine(),
            "uptime": uptime_info,
            "public_ip": pub_ip,
            "server_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
        "cpu": {
            "model": cpu_model,
            "cores": cpu_cores,
            "percent": cpu_percent,
            "load_average": {"1m": load1, "5m": load5, "15m": load15},
        },
        "memory": mem_stats,
        "disk": disk_stats,
        "swarm": {
            "active": swarm_active,
            "total_stacks": len(active_stacks),
            "stacks": active_stacks,
            "total_containers": len(containers),
        },
        "containers": containers,
    }
