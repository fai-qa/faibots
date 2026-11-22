"""Assemble a portable Windows preview from this checkout and its electron-builder win-unpacked output."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

SOURCE = Path(__file__).resolve().parents[1]
TOP = "faibots preview"
NOTICE_FILES = {
    "LICENSE": "LICENSE",
    "NOTICE.md": "NOTICE.md",
    "THIRD_PARTY_LICENSES/README.md": "THIRD_PARTY_LICENSES/README.md",
    "THIRD_PARTY_LICENSES/affectui-MIT.txt": "THIRD_PARTY_LICENSES/affectui-MIT.txt",
    "THIRD_PARTY_LICENSES/Inter.txt": "node_modules/@fontsource-variable/inter/LICENSE",
    "THIRD_PARTY_LICENSES/JetBrains-Mono.txt": "node_modules/@fontsource-variable/jetbrains-mono/LICENSE",
    "THIRD_PARTY_LICENSES/Codex-SDK.txt": "node_modules/@openai/codex-sdk/LICENSE",
    "THIRD_PARTY_LICENSES/Claude-Agent-SDK.txt": "node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md",
}
PDF_NOTICES = ("LICENSE_PDFJS", "LICENSE_JBIG2", "LICENSE_OPENJPEG", "LICENSE_PDFJS_JBIG2", "LICENSE_PDFJS_OPENJPEG")
GUIDE = """faibots desktop preview for Windows x64
Build {commit}

Extract the whole ZIP. Double-click Open faibots preview.cmd.
Keep the app folder next to the launcher. This local preview is unsigned.

Open Settings > Models & providers and test a provider you already use.
Choose its model in the profile for fai. Then try this in the fai chat:

Find someone on my team to edit this line: "We make tools for small teams."
If we need an editor, propose one. Bring me two versions here.

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
    required = [app / "faibots.exe", app / "resources/app.asar", pdf / "LICENSE"]
    required.extend(pdf / "dist/licenses" / name for name in PDF_NOTICES)
    for source in required:
        if not source.is_file() or not source.stat().st_size:
            raise ValueError(f"Missing required package file: {source.name}")

    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    trail = SOURCE / "src/renderer/src/components/ui/agent-trail-clean.tsx"
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
            for name, source in NOTICE_FILES.items():
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
