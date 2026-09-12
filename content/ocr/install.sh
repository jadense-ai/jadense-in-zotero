#!/bin/sh
# 本机独立环境；不执行远程安装脚本、不修改全局 Python。
set -eu
runtime=$1
mkdir -p "$runtime"
if [ ! -x "$runtime/uv" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin ;;
    Darwin-x86_64) target=x86_64-apple-darwin ;;
    Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
    Linux-aarch64) target=aarch64-unknown-linux-gnu ;;
    *) echo 'Unsupported platform; use manual installation.' >&2; exit 1 ;;
  esac
  url="https://github.com/astral-sh/uv/releases/download/0.9.3/uv-$target.tar.gz"
  curl --fail --location "$url" -o "$runtime/uv.tar.gz"
  curl --fail --location "$url.sha256" -o "$runtime/uv.sha256"
  expected=$(cut -d ' ' -f 1 "$runtime/uv.sha256")
  actual=$(shasum -a 256 "$runtime/uv.tar.gz" | cut -d ' ' -f 1)
  [ "$expected" = "$actual" ] || { echo 'uv checksum mismatch' >&2; exit 1; }
  tar -xzf "$runtime/uv.tar.gz" -C "$runtime" --strip-components=1
fi
export UV_PYTHON_INSTALL_DIR="$runtime/python"
export UV_CACHE_DIR="$runtime/uv-cache"
"$runtime/uv" sync --project "$runtime" --python 3.12 --frozen
