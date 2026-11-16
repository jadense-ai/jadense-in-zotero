"""为完整包生成可复核的解压大小和文件树摘要；暂存恢复以前者预检、以后者鉴别字节。"""
import argparse
import hashlib
import re
import subprocess
import json
from pathlib import Path
import sys
import zipfile


def inventory(archive):
    tree = hashlib.sha256()
    with zipfile.ZipFile(archive) as bundle:
        files = sorted((item for item in bundle.infolist() if not item.is_dir()), key=lambda item: item.filename)
        for item in files:
            with bundle.open(item) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            tree.update(f"{digest}  {item.filename}\n".encode())
        return {"unpackedBytes": sum(item.file_size for item in files), "treeSha256": tree.hexdigest()}


def msvc_version(value):
    """仅接收发布者已从工具链和独立系统验证的四段版本，不设推测的默认值。"""
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", value):
        raise argparse.ArgumentTypeError("Expected a validated four-part MSVC runtime version")
    return value


def build_requirements(archive, python, packages, minimum):
    """版本取自真正进入 ZIP 的解释器和发行包；不读取系统开发环境。"""
    query = "import json,sys,importlib.metadata as m;print(json.dumps(dict(python=sys.version.split()[0],packages={n:m.version(n) for n in sys.argv[1:]})))"
    versions = json.loads(subprocess.check_output([str(python), "-I", "-c", query, *packages], text=True))
    return {**inventory(archive), **versions, **({"msvcMinVersion": minimum} if minimum else {})}


if __name__ == "__main__":
    print(json.dumps(inventory(Path(sys.argv[1]))))
