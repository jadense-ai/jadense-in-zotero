#!/bin/sh
# 本机独立环境；不执行远程安装脚本、不修改全局 Python。
set -eu
# shell 等待子进程时仍处理 TERM；超时仅清理当前安装命令。
child_pid=''
trap '[ -z "$child_pid" ] || kill "$child_pid" 2>/dev/null; exit 124' TERM INT
run_child() {
  "$@" &
  child_pid=$!
  wait "$child_pid"
  child_pid=''
}
runtime=$1
printf 'JADENSE_PDF_PROGRESS {"stage":"environment"}\n'
# 桌面程序不一定继承终端 PATH；兼容常见的用户安装位置。
uv_path=''
uv_version=''
uv_source=''
for candidate in "$(command -v uv || true)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$runtime/uv"; do
  [ -x "$candidate" ] || continue
  version=$("$candidate" --version 2>/dev/null) || continue
  if printf '%s\n' "$version" | awk '$1 == "uv" { split($2,v,"."); if (v[1]>0 || v[2]>9 || (v[2]==9 && v[3]>=3)) ok=1 } END { exit !ok }'; then
    uv_path=$candidate; uv_version=$version; uv_source=user
    [ "$candidate" != "$runtime/uv" ] || uv_source=plugin
    break
  fi
done
if [ "${2:-}" = '--check' ]; then
  ready=false
  if [ -x "$runtime/.venv/bin/python" ] && [ -f "$runtime/dependencies-0.6.4" ]; then ready=true; fi
  printf 'uvPath=%s\nuvVersion=%s\nuvSource=%s\nready=%s\n' "$uv_path" "$uv_version" "$uv_source" "$ready"
  exit 0
fi
mkdir -p "$runtime"
if [ -z "$uv_path" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target=aarch64-apple-darwin ;;
    Darwin-x86_64) target=x86_64-apple-darwin ;;
    Linux-x86_64) target=x86_64-unknown-linux-gnu ;;
    Linux-aarch64) target=aarch64-unknown-linux-gnu ;;
    *) echo 'Unsupported platform; use manual installation.' >&2; exit 1 ;;
  esac
  url="https://github.com/astral-sh/uv/releases/download/0.9.3/uv-$target.tar.gz"
  printf 'JADENSE_PDF_PROGRESS {"stage":"uv"}\n'
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 300 "$url" -o "$runtime/uv.tar.gz"
  curl --fail --location --retry 3 --connect-timeout 30 --max-time 120 "$url.sha256" -o "$runtime/uv.sha256"
  expected=$(cut -d ' ' -f 1 "$runtime/uv.sha256")
  actual=$(shasum -a 256 "$runtime/uv.tar.gz" | cut -d ' ' -f 1)
  [ "$expected" = "$actual" ] || { echo 'uv checksum mismatch' >&2; exit 1; }
  tar -xzf "$runtime/uv.tar.gz" -C "$runtime" --strip-components=1
  uv_path="$runtime/uv"
fi
export UV_PYTHON_INSTALL_DIR="$runtime/python"
export UV_CACHE_DIR="$runtime/uv-cache"
export UV_PROJECT_ENVIRONMENT="$runtime/.venv"
export UV_HTTP_RETRIES=3
export UV_HTTP_TIMEOUT=60
printf 'Using uv: %s\n' "$uv_path"
rm -f "$runtime/dependencies-0.6.4"
printf 'JADENSE_PDF_PROGRESS {"stage":"dependencies"}\n'
run_child "$uv_path" sync --project "$runtime" --python 3.12 --frozen
printf 'JADENSE_PDF_PROGRESS {"stage":"imports"}\n'
run_child "$runtime/.venv/bin/python" -c 'import babeldoc; import pymupdf; import onnxruntime'
printf 'ready\n' > "$runtime/dependencies-0.6.4"
