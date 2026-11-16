"""在引擎自己的短生命周期解释器中验证 CPU 原生依赖，不访问模型或网络。"""
import ctypes
import importlib
import json
import os
import re
import sys


def loaded_runtime():
    """记录当前进程实际加载的 VC DLL，避免把系统目录当成实际加载来源。"""
    if os.name != "nt":
        return {}
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32")
    kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel.GetModuleHandleW.restype = wintypes.HMODULE
    kernel.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    paths = {}
    for name in ("msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"):
        handle = kernel.GetModuleHandleW(name)
        path = ctypes.create_unicode_buffer(32768)
        if handle and kernel.GetModuleFileNameW(handle, path, len(path)):
            paths[name] = path.value
    return paths


def probe(engine):
    modules = ("torch", "onnxruntime", "rapidocr", "docling.document_converter") if engine == "ocr" else ("onnxruntime", "pymupdf", "babeldoc.docvision.doclayout")
    for name in modules:
        try:
            print(json.dumps({"type": "progress", "stage": "imports", "module": name}), flush=True)
            module = importlib.import_module(name)
            if name == "torch" and (module.tensor([2], device="cpu") + 3).item() != 5:
                raise RuntimeError("CPU tensor check failed")
        except Exception as exc:
            numeric = re.search(r"WinError (\d+)", str(exc))
            code = getattr(exc, "winerror", None) or (int(numeric[1]) if numeric else None)
            category = {126: "NATIVE_DLL_MISSING", 127: "NATIVE_SYMBOL_MISSING", 193: "NATIVE_ARCH_MISMATCH", 1114: "NATIVE_DLL_INIT_FAILED"}.get(code, "NATIVE_IMPORT_FAILED")
            if isinstance(exc, ModuleNotFoundError):
                category = "NATIVE_PACKAGE_MISSING"
            print(json.dumps({"type": "install-error", "stage": "imports", "module": name, "category": category, "winerror": code, "detail": str(exc), "loaded": loaded_runtime()}), flush=True)
            return 1
    print(json.dumps({"type": "native-ready", "loaded": loaded_runtime()}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(probe(sys.argv[1]))
