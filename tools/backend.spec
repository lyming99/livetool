# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：把 backend 打成独立的 livetool-backend.exe。

几个关键取舍：
  - onedir 而不是 onefile：onefile 每次启动要解压到临时目录，慢好几秒
  - console=True：和 Electron 之间靠 stdin/stdout 管道通信，
    windowed 模式下 PyInstaller 会把 stdout 重定向到 devnull，协议就断了。
    实际运行时由 Electron 的 spawn({ windowsHide: true }) 隐藏控制台窗口。
  - 同时内置 FunASR 和 Whisper：
      FunASR  -> torch(CPU) + funasr，约 450MB + 8MB
      Whisper -> faster-whisper + ctranslate2，约 200MB
    安装包因此会到 400MB 上下。用的是 CPU 版 torch，不是 2GB 的 CUDA 版。
  - modelscope 只留下载模型需要的部分，transformers / sklearn 确实用不到。
"""

import importlib.util
import os

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

ROOT = os.path.dirname(SPECPATH or os.getcwd())
BACKEND = os.path.join(ROOT, 'backend')

# funasr 的模型代码里有 torch.jit.script / inspect.getsource，打包成纯字节码后
# 这些调用会抛 "TorchScript requires source access"，导致模型类注册不上
# （典型报错：model 'ParaformerStreaming' is not registered）。
# 所以把 funasr 的 .py 源文件一并复制到 _internal/funasr/ 下，
# 让 __file__ 指向的路径真实存在。
_funasr_spec = importlib.util.find_spec('funasr')
FUNASR_DIR = list(_funasr_spec.submodule_search_locations)[0]

datas = []
for _root, _dirs, _files in os.walk(FUNASR_DIR):
    for _name in _files:
        if not (_name.endswith('.py') or _name == 'version.txt'):
            continue
        _src = os.path.join(_root, _name)
        _rel = os.path.relpath(_root, FUNASR_DIR)
        _dest = 'funasr' if _rel == '.' else os.path.join('funasr', _rel)
        datas.append((_src, _dest))

# version.txt 之前已经通过 collect_data_files 收集，这里去重
datas = list({(src, dest) for src, dest in datas})

NATIVE_CAPTURE = os.path.join(ROOT, 'build', 'native-audio', 'livetool-audio-capture.exe')
if not os.path.isfile(NATIVE_CAPTURE):
    raise RuntimeError('Build tools/build_audio_capture.cmd before packaging the backend')
datas.append((NATIVE_CAPTURE, '.'))

hiddenimports = [
    'audio_devices',
    'mf_capture',
    'mf_stream',
    'installer',
    'mock_engine',
    'asr_engine',
    'whisper_engine',
    'api_engine',
]
hiddenimports += collect_submodules('faster_whisper')
hiddenimports += collect_submodules('ctranslate2')
# funasr 内部大量懒加载，必须显式收集，否则运行时会 ImportError
hiddenimports += collect_submodules('funasr')
# modelscope 不整体收集：它有几百个子模块（大部分是训练用的），
# 全量遍历既慢又会拖进来一堆无关依赖。funasr 只需要它的模型下载入口，
# 其余靠静态依赖分析自动带上。
hiddenimports += [
    'modelscope',
    'modelscope.hub.snapshot_download',
]

binaries = collect_dynamic_libs('ctranslate2')

# 注意：datas 在上面已经构造好了（funasr 的 .py 源文件 + version.txt）

a = Analysis(
    [os.path.join(BACKEND, 'main.py')],
    pathex=[BACKEND],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # All capture is Media Foundation; do not ship a hidden PortAudio path.
        'sounddevice', '_sounddevice', '_sounddevice_data', 'pyaudio',
        # 这两个体积不小（合计 600MB+），FunASR/Whisper 用不到
        'transformers', 'sklearn',
        # ASR 推理用不到的图像/可视化库，是被 librosa、modelscope 顺带拖进来的
        'torchvision', 'cv2', 'imageio', 'skimage', 'shapely',
        # modelscope 里只有 hub 下载用得到，模型定义/训练/导出全部不要
        'modelscope.models', 'modelscope.trainers', 'modelscope.msdatasets',
        'modelscope.exporters', 'modelscope.preprocessors',
        # modelscope 的云存储后端，只在云端读写数据集时用
        'aliyunsdkcore', 'oss2', 'Crypto',
        # 画图/交互式环境的库
        'matplotlib', 'IPython', 'notebook', 'jupyter',
        # 注意：unittest / pydoc / doctest 不能排除，torch 内部依赖它们
        'tkinter', 'test',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='livetool-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='livetool-backend',
)
