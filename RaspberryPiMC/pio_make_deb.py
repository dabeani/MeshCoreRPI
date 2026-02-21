Import("env")

import os
import subprocess


def _detect_role(pio_env: str) -> str:
    if pio_env.endswith("_companion"):
        return "companion"
    return "repeater"


def _post_build_make_deb(source, target, env):
    if os.name != "posix" or os.uname().sysname != "Linux":
        print("[RaspberryPiMC] skip DEB packaging (non-Linux host)")
        return

    pio_env = env.get("PIOENV", "")
    role = _detect_role(pio_env)
    binary_path = str(target[0])

    repo_root = env.subst("$PROJECT_DIR")
    script_path = os.path.join(repo_root, "RaspberryPiMC", "build_deb.sh")

    if not os.path.exists(script_path):
        print(f"[RaspberryPiMC] DEB script missing: {script_path}")
        return

    print(f"[RaspberryPiMC] building DEB package for role={role}")
    subprocess.check_call(["bash", script_path, role, binary_path], cwd=repo_root)


env.AddPostAction("$PROGPATH", _post_build_make_deb)
