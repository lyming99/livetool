# -*- coding: utf-8 -*-
"""环境检查与自动安装。

两件事：
  1. 检查识别引擎需要的 Python 包有没有装，没装就 pip install；
  2. 触发模型下载（FunASR 走 ModelScope，Whisper 走 HuggingFace）。

安装过程是长任务，全部在后台线程里跑，通过回调把日志推给 Electron。
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys

# PyInstaller 打包后 sys.frozen 为 True，这时没有可用的 pip，
# 依赖必须在打包时内置，不能再走「自动安装」
FROZEN = bool(getattr(sys, "frozen", False))

# 每个引擎需要哪些包、对应哪个 import 名
ENGINES = {
    "funasr": {
        "label": "FunASR",
        "deps": [
            ("funasr", "funasr"),
            ("torch", "torch"),
        ],
        "install": [],
    },
    "whisper": {
        "label": "Whisper (faster-whisper)",
        "deps": [
            ("faster_whisper", "faster-whisper"),
        ],
        "install": ["faster-whisper"],
    },
    # 接口（云端 API）不需要本地模型：音频在本地采集，只把音频段发给接口转写。
    # deps 留空，环境检查改为校验接口地址是否填写（见 check_env）。
    "api": {
        "label": "接口（云端 API）",
        "deps": [],
        "install": [],
        "remote": True,
    },
}

# 国内访问 HuggingFace 经常超时，未显式配置时走镜像。
# 用户如果自己设了 HF_ENDPOINT 就尊重用户的设置。
HF_MIRROR = "https://hf-mirror.com"


def _check_api_env(config: dict, spec: dict) -> dict:
    """接口引擎没有本地模型，只校验接口地址与原生采集组件。"""
    deps = []

    base = (config.get("apiBaseUrl") or "").strip()
    model = (config.get("apiModel") or "").strip() or "whisper-1"
    if not base:
        deps.append({"module": "api", "package": "接口地址",
                     "installed": False, "error": "请填写接口地址，例如 https://api.openai.com/v1"})
    elif not (base.startswith("http://") or base.startswith("https://")):
        deps.append({"module": "api", "package": "接口地址",
                     "installed": False, "error": "接口地址需要以 http:// 或 https:// 开头"})
    else:
        deps.append({"module": "api", "package": "接口地址", "installed": True, "error": ""})

    deps.append({"module": "api-model", "package": f"接口模型（{model}）",
                 "installed": True, "error": ""})

    key = (config.get("apiKey") or "").strip()
    deps.append({"module": "api-key", "package": "接口密钥",
                 "installed": True, "error": "" if key else "未填写密钥（仅当接口无需鉴权时可直接使用）"})

    from mf_capture import helper_path
    native_ready = helper_path().is_file()
    deps.append({"module": "mediafoundation", "package": "Windows 原生采集组件",
                 "installed": native_ready,
                 "error": "" if native_ready else "请构建原生组件或重新安装新版"})

    # 地址必须填且是 http(s)；密钥只做提示，部分自建接口不需要
    valid_base = bool(base) and (base.startswith("http://") or base.startswith("https://"))
    return {
        "engine": "api",
        "label": spec["label"],
        "deps": deps,
        "ready": valid_base and native_ready,
    }


def check_env(engine: str, config: dict | None = None) -> dict:
    spec = ENGINES.get(engine)
    if spec is None:
        return {"engine": engine, "deps": [], "ready": False, "error": "未知引擎"}

    if engine == "api":
        return _check_api_env(config or {}, spec)

    deps = []
    for module, package in spec["deps"]:
        error = ""
        if FROZEN:
            # 打包环境下 find_spec 对隐藏导入不一定可靠，直接试着 import
            try:
                __import__(module)
                installed = True
            except Exception as exc:
                installed = False
                error = f"{type(exc).__name__}: {exc}"
        else:
            try:
                installed = importlib.util.find_spec(module) is not None
            except (ImportError, ValueError) as exc:
                installed = False
                error = f"{type(exc).__name__}: {exc}"
        deps.append({
            "module": module,
            "package": package,
            "installed": installed,
            "error": error,
        })

    from mf_capture import helper_path
    native_ready = helper_path().is_file()
    deps.append({"module": "mediafoundation", "package": "Windows 原生采集组件",
                 "installed": native_ready,
                 "error": "" if native_ready else "请构建原生组件或重新安装新版"})
    return {
        "engine": engine,
        "label": spec["label"],
        "deps": deps,
        "ready": all(d["installed"] for d in deps),
    }


def _pip_install(packages: list[str], on_line) -> bool:
    if not packages:
        return True

    cmd = [
        sys.executable, "-m", "pip", "install",
        "--disable-pip-version-check",
        "--no-input",
        *packages,
    ]
    on_line("$ " + " ".join(cmd))

    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            bufsize=1,
        )
    except Exception as exc:
        on_line(f"无法启动 pip：{exc}")
        return False

    assert proc.stdout is not None
    for line in proc.stdout:
        text = line.rstrip()
        if text:
            on_line(text)

    code = proc.wait()
    return code == 0


def _download_funasr(config: dict, models_dir: str, on_line) -> None:
    from funasr import AutoModel

    target = (config.get("modelPath") or "").strip() or (config.get("model") or "paraformer-zh-streaming")
    cache_dir = (config.get("cacheDir") or "").strip() or models_dir
    on_line(f"正在准备 FunASR 模型：{target}")
    on_line(f"缓存目录：{cache_dir}")

    kwargs = {
        "model": target,
        "cache_dir": cache_dir,
        "disable_update": True,
    }
    revision = (config.get("modelRevision") or "").strip()
    if revision and not (config.get("modelPath") or "").strip():
        kwargs["model_revision"] = revision

    AutoModel(**kwargs)
    on_line("FunASR 模型准备完成")

    if config.get("usePunc", True):
        punc = (config.get("puncModel") or "ct-punc").strip()
        on_line(f"正在准备标点模型：{punc}")
        AutoModel(model=punc, cache_dir=cache_dir, disable_update=True)
        on_line("标点模型准备完成")


# Whisper 各规格对应的 HuggingFace 仓库
WHISPER_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}

# faster-whisper 加载本地模型需要的文件
WHISPER_FILES = ["config.json", "preprocessor_config.json", "tokenizer.json", "vocabulary.txt", "model.bin"]


def _download_once(url: str, dest: str, on_line, label: str) -> None:
    """下载一次，边下边报百分比，支持断点续传。

    用 requests 而不是 urllib：实测同一个文件 urllib 只有 ~70KB/s，
    requests 能到 ~900KB/s。模型动辄几百 MB，差距很关键。
    """
    import requests

    tmp = dest + ".part"
    existing = os.path.getsize(tmp) if os.path.exists(tmp) else 0

    headers = {"User-Agent": "livetool/0.1"}
    if existing:
        headers["Range"] = f"bytes={existing}-"

    with requests.get(url, stream=True, timeout=30, headers=headers, allow_redirects=True) as resp:
        resp.raise_for_status()

        # 服务器支持续传才会返回 206，否则只能从头写
        if existing and resp.status_code == 206:
            mode = "ab"
            done = existing
        else:
            mode = "wb"
            done = 0

        total = int(resp.headers.get("Content-Length") or 0) + done
        if existing and mode == "ab":
            on_line(f"  {label} 继续下载（已有 {existing/1024/1024:.1f} MB）")

        last_percent = -1
        with open(tmp, mode) as fh:
            for chunk in resp.iter_content(1024 * 1024):
                if not chunk:
                    continue
                fh.write(chunk)
                done += len(chunk)
                if total:
                    percent = done * 100 // total
                    if percent >= last_percent + 5:
                        last_percent = percent
                        on_line(f"  {label} {percent}%")

    os.replace(tmp, dest)
    size_mb = os.path.getsize(dest) / (1024 * 1024)
    on_line(f"  {label} 完成（{size_mb:.1f} MB）")


def _download_file(url: str, dest: str, on_line, label: str, retries: int = 3) -> None:
    """CDN 经常中途断流，失败就续传重试，别让用户从头再来。"""
    import time

    for attempt in range(1, retries + 1):
        try:
            _download_once(url, dest, on_line, label)
            return
        except Exception as exc:
            # 文件不存在（404）这类错误重试没有意义，直接抛给上层跳过
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429:
                raise
            if attempt >= retries:
                raise
            on_line(f"  {label} 中断（{exc}），第 {attempt}/{retries} 次重试…")
            time.sleep(2)


def _download_whisper(config: dict, models_dir: str, on_line) -> None:
    """直接从镜像下载模型文件，不经过 huggingface_hub。

    原因：新版 huggingface_hub 默认用 Xet 协议，hf-mirror 这类镜像只做
    308 重定向，Xet 分块下载会卡在 0 字节。直连 HTTP 反而稳定。
    """
    size = (config.get("whisperModel") or "small").strip()
    repo = WHISPER_REPOS.get(size, f"Systran/faster-whisper-{size}")
    base = (os.environ.get("HF_ENDPOINT") or HF_MIRROR).rstrip("/")

    cache_root = (config.get("cacheDir") or "").strip() or models_dir
    target_dir = os.path.join(cache_root, "whisper", f"faster-whisper-{size}")
    os.makedirs(target_dir, exist_ok=True)

    on_line(f"正在下载 Whisper 模型：{size}（{repo}）")
    on_line(f"保存到：{target_dir}")

    for name in WHISPER_FILES:
        dest = os.path.join(target_dir, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            on_line(f"  {name} 已存在，跳过")
            continue

        url = f"{base}/{repo}/resolve/main/{name}"
        try:
            _download_file(url, dest, on_line, name)
        except Exception as exc:
            # 除了权重和配置，其他文件缺了也能跑
            if name in ("model.bin", "config.json"):
                raise
            on_line(f"  跳过 {name}：{exc}")

    on_line("Whisper 模型准备完成")


def run_install(engine: str, config: dict, models_dir: str, on_line) -> bool:
    """装包 + 下模型，任一步失败就返回 False。"""
    spec = ENGINES.get(engine)
    if spec is None:
        on_line(f"未知引擎：{engine}")
        return False

    from mf_capture import helper_path
    if not helper_path().is_file():
        on_line("缺少 Windows 原生采集组件：源码请先执行 npm run build:audio，安装版请重新安装新版。")
        return False

    # 接口引擎没有本地依赖和模型：只确认接口地址已填写，不做任何下载
    if engine == "api":
        base = (config.get("apiBaseUrl") or "").strip()
        if not base:
            on_line("请在「识别引擎 → 接口」里填写接口地址，例如 https://api.openai.com/v1")
            return False
        if not (base.startswith("http://") or base.startswith("https://")):
            on_line("接口地址需要以 http:// 或 https:// 开头")
            return False
        on_line(f"接口模式无需下载模型：{base}")
        on_line(f"使用模型：{((config.get('apiModel') or '').strip() or 'whisper-1')}")
        if not (config.get("apiKey") or "").strip():
            on_line("提示：未填写接口密钥，仅当接口不需要鉴权时才可直接使用")
        return True

    # 先看还缺什么，已经装好的不重复装
    missing = []
    for module, package in spec["deps"]:
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append(package)

    if missing:
        if FROZEN:
            # 打包版没有 pip，缺的包只能靠构建时内置
            on_line("安装版未内置以下依赖，无法在应用内安装：" + ", ".join(missing))
            if engine == "funasr":
                on_line("FunASR 依赖 torch（约 2GB），打包体积过大，因此未包含在安装版中。")
                on_line("请改用 Whisper（设置里把引擎切成 Whisper，再点一次下载模型）。")
                on_line("确实需要 FunASR 的话，请克隆源码后用 npm start 运行。")
            else:
                on_line("如果要用这个引擎，请用源码方式运行并执行 pip install")
            return False
        on_line("需要安装：" + ", ".join(missing))
        if not _pip_install(missing, on_line):
            on_line("pip 安装失败，请检查网络或代理设置")
            return False
        on_line("依赖安装完成")
    else:
        on_line("依赖已齐全，跳过安装")

    # 装完包要重新加载才能 import，这里依赖仍在运行的解释器里，
    # 所以下载模型这步可能因为包刚装好而失败，需要提示重启应用
    try:
        if engine == "funasr":
            _download_funasr(config, models_dir, on_line)
        else:
            _download_whisper(config, models_dir, on_line)
    except Exception as exc:
        on_line(f"模型下载失败：{exc}")
        if missing:
            on_line("依赖刚刚安装，可能需要重启应用后重试")
        return False

    return True
