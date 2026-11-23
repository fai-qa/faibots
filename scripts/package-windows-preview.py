"""Assemble a portable Windows preview from this checkout and its electron-builder win-unpacked output."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
TOP = "faibots preview"
NOTICES = json.loads((SOURCE / "scripts/windows-notices.json").read_text(encoding="utf-8"))
GUIDE = """faibots desktop preview for Windows x64
Build {commit}

Extract the whole ZIP. Double-click Open faibots preview.cmd.
Keep the app folder next to the launcher. This local preview is unsigned.

Open Settings > Models & providers and test a provider you already use.
Choose its model in the profile for fai. For a trial with fictional quotes,
create a project and give fai this job in chat.

Compare two quotes. Atlas costs QAR 920 and delivers in four days. Wadi costs
QAR 990 and delivers in two days. I need delivery in three days. Prepare a
short decision memo in a work brief for my review.

If the result meets your needs, choose Accept result, then Save to project.
Open the saved Page in the project's Space.

The launcher opens a separate preview profile. If you used the previous
Windows preview on this computer, quit that version first. This build opens
the same chats and retains the workspace folder saved in its settings.
"""

def assemble(app, target):
    if target.exists() or target.is_relative_to(app):
        raise ValueError("Choose a new ZIP path outside the packaged app.")
    if not target.parent.is_dir():
        raise ValueError("The ZIP destination folder must exist.")
    pdf = app / "resources/app.asar.unpacked/node_modules/unpdf"
    required = [app / "faibots.exe", app / "resources/app.asar"]
    required.extend(pdf / name for name in NOTICES["pdfFiles"])
    for source in required:
        if not source.is_file() or not source.stat().st_size:
            raise ValueError(f"Missing required package file: {source.name}")

    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    trail = SOURCE / NOTICES["proComponent"]
    pro = trail.read_text(encoding="utf-8").splitlines()[0].removeprefix("// ")
    if "affectUI Pro" not in pro:
        raise ValueError("Missing integrated component license notice.")
    blocked = {".git", ".env", "secrets.json", "faibots.db", "faibots.db-shm", "faibots.db-wal"}
    with tempfile.TemporaryDirectory(dir=target.parent) as staging:
        temporary = Path(staging) / "preview.zip"
        with zipfile.ZipFile(temporary, "x", zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
            guide = GUIDE.format(commit=commit).replace("\n", "\r\n")
            archive.writestr(f"{TOP}/Read me.txt", guide.encode("utf-8"))
            archive.writestr(f"{TOP}/THIRD_PARTY_LICENSES/affectui-Pro.txt", (pro + "\n").encode("utf-8"))
            launcher_name = "Open faibots preview.cmd"
            launcher = (SOURCE / "scripts" / launcher_name).read_text(encoding="utf-8").replace("\n", "\r\n")
            archive.writestr(f"{TOP}/{launcher_name}", launcher.encode("utf-8"))
            for name, source in NOTICES["files"].items():
                archive.write(SOURCE / source, f"{TOP}/{name}")
            for path in sorted(app.rglob("*")):
                if path.is_symlink() or path.is_junction() or path.name.casefold() in blocked or path.name.casefold().startswith(".env."):
                    raise ValueError(f"Unexpected file in packaged app: {path.name}")
                if path.is_file():
                    archive.write(path, f"{TOP}/app/{path.relative_to(app).as_posix()}")
        with temporary.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        # Publish the finished file only if no other build has taken its destination.
        os.link(temporary, target)
    print(f"{digest}  {target.name}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, help="Path to the built win-unpacked folder")
    parser.add_argument("zip", type=Path, help="New ZIP file on the local NTFS volume")
    args = parser.parse_args()
    assemble(args.app.resolve(strict=True), args.zip.resolve())
