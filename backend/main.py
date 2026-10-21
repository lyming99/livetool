#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""livetool 语音识别 sidecar。

和 Electron 主进程通过 stdin / stdout 通信，一行一个 JSON：

    子进程 -> 主进程
        {"type": "partial", "text": "今天我们来", "ts": 1710000000.0}
        {"type": "final",   "text": "今天我们来聊实时字幕。", "ts": ...}
        {"type": "status",  "state": "running", "detail": ""}
        {"type": "error",   "message": "..."}

    主进程 -> 子进程
        {"type": "start"}  {"type": "stop"}  {"type": "shutdown"}

规矩：stdout 只跑协议，所有日志走 stderr。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import time

_emit_lock = threading.Lock()

# Windows 下 Python 默认按 locale（GBK）写 stdout，中文会变成非 UTF-8 字节。
# 这里强制 UTF-8，避免依赖父进程是否设置了 PYTHONIOENCODING。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


_protocol_stdout = sys.stdout  # model libraries may redirect sys.stdout in another thread


def emit(obj: dict) -> None:
    """线程安全地输出一行 JSON。"""
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _emit_lock:
        _protocol_stdout.write(line)
        _protocol_stdout.flush()


def log(*args) -> None:
    print("[backend]", *args, file=sys.stderr, flush=True)


class Backend:
    def __init__(self, mock: bool) -> None:
        self.mock = mock
        self.engine = None
        self.running = False
        self.asr_config: dict = {}
        self._installing = False
        self._record_stop = None
        self._mic_testing = False
        self._mic_stop = None
        self._session = 0
        self._test_model = None
        self._lock = threading.Lock()
        # 会话录制器：开启录制时在 start() 创建，停止时收尾落盘
        self.recorder = None

    # ---- 事件回调（由引擎在识别线程里调用） ----

    def on_partial(self, text: str) -> None:
        # 写到 stderr 便于排查（stdout 只跑协议）
        if text:
            log(f"partial: ...{text[-30:]}")
        emit({"type": "partial", "text": text, "ts": time.time()})

    def on_final(self, text: str) -> None:
        log(f"final: {text}")
        recorder = self.recorder
        if recorder is not None:
            try:
                recorder.add_final(text)
                self.emit_session("recording", recorder, "")
            except Exception as exc:
                log("写入字幕失败：", repr(exc))
        emit({"type": "final", "text": text, "ts": time.time()})

    def on_status(self, state: str, detail: str = "") -> None:
        if state == "error" and self.recorder is not None:
            # 引擎报错后不会再有音频进来：立刻收尾落盘，避免会话一直挂着不完整
            try:
                self._finish_recording("failed")
            except Exception as exc:  # pragma: no cover - 收尾失败仍要上报状态
                log("引擎报错后收尾录制失败：", repr(exc))
        emit({"type": "status", "state": state, "detail": detail})

    # ---- 会话录制 ----

    def _session_event(self, state: str, recorder=None, detail: str = "") -> dict:
        recorder = self.recorder if recorder is None else recorder
        summary = {}
        if recorder is not None:
            try:
                summary = recorder.summary()
            except Exception as exc:  # pragma: no cover - 汇总失败只影响展示
                log("读取录制会话信息失败：", repr(exc))
        return {
            "type": "session",
            "state": state,
            "active": state == "recording" and recorder is not None,
            "directory": summary.get("directory") or None,
            "subtitlePath": summary.get("subtitlePath") or None,
            "segments": summary.get("segments", 0),
            "cues": summary.get("cues", 0),
            "durationSeconds": summary.get("durationSeconds", 0.0),
            "detail": detail,
        }

    def emit_session(self, state: str, recorder=None, detail: str = "") -> None:
        emit(self._session_event(state, recorder, detail))

    def _begin_recording(self, cfg: dict) -> None:
        """按配置创建本次识别会话的录制器；失败时只降级为「只识别」。"""
        if not cfg.get("recordEnabled"):
            self.recorder = None
            self.emit_session("idle", None, "")
            return
        recorder = None
        try:
            from audio_devices import capture_target
            from session_recorder import SessionRecorder

            target = capture_target(cfg)
            base = (cfg.get("recordDir") or "").strip() or os.path.join(_data_dir(), "recordings")
            recorder = SessionRecorder(
                base,
                segment_seconds=cfg.get("recordSegmentSeconds") or 300,
                subtitle_format=cfg.get("recordSubtitleFormat") or "srt",
                engine=(cfg.get("engine") or ""),
                source_kind=target["kind"], source_label=target["label"],
                # 开启录制即同时录真实音频；只存字幕不在界面暴露，避免出现无音频的“录音”会话
                include_audio=True,
                log=log,
            )
            recorder.start()
        except Exception as exc:
            log("创建录制会话失败：", repr(exc))
            self.recorder = None
            self.emit_session("error", None, f"无法创建录制文件：{exc}")
            return
        self.recorder = recorder
        self.emit_session("recording", recorder, f"正在录制到 {recorder.directory}")

    def _finish_recording(self, status: str = "completed") -> dict | None:
        """关闭录制器并把最终文件信息上报；重复调用是安全的。"""
        recorder, self.recorder = self.recorder, None
        if recorder is None:
            self.emit_session("idle", None, "")
            return None
        try:
            manifest = recorder.close(status)
        except Exception as exc:
            log("结束录制失败：", repr(exc))
            manifest = None
        self.emit_session(status if status in ("completed", "failed", "interrupted") else "stopped",
                          recorder, f"录制已保存到 {recorder.directory}")
        return manifest

    def set_record(self, enabled: bool, config: dict | None = None) -> None:
        """运行中即时启停录制会话；识别本身不受影响。

        以前只有 start() 时读一次 recordEnabled，用户在识别过程中打开开关不会
        生效，界面就一直停在「等待录制会话就绪」。这里让开关立刻生效：
        开启时补建录制会话（新会话目录从现在开始），关闭时收尾落盘。
        未在识别时只记住配置，下次 start() 会按它创建。
        """
        with self._lock:
            if config:
                self.asr_config = dict(config)
            cfg = dict(self.asr_config)
            running = self.running
            engine = self.engine
        if not running:
            # 未运行：不创建空会话，等 start() 时按新配置处理
            return
        if enabled:
            if self.recorder is not None:
                # 已经在录：只把当前状态回给界面，不重复建目录
                self.emit_session("recording", self.recorder,
                                  f"正在录制到 {self.recorder.directory}")
                return
            self._begin_recording({**cfg, "recordEnabled": True})
            if engine is not None and self.recorder is not None:
                engine.recorder = self.recorder
            return
        # 关闭：先把引用断开，避免引擎线程继续往已关闭的录制器写音频。
        # 这是用户主动结束录制（识别仍在继续），会话算正常完成。
        if engine is not None:
            engine.recorder = None
        self._finish_recording("completed")

    def abort(self, detail: str) -> None:
        """异常路径：先把已录内容落盘，再报告错误。

        由 main() 的异常分支与 sys.excepthook / threading.excepthook 调用。
        录制器本身已经按秒回填 WAV 头、按 5 秒刷新清单，所以即使这里是
        「进程被强杀后重启」，也只会丢最后一个刷新间隔的内容。
        """
        log("异常退出，先保存录制内容：", detail)
        try:
            self._finish_recording("interrupted")
        except Exception as exc:  # pragma: no cover - 收尾失败也要继续报错
            log("异常收尾失败：", repr(exc))
        try:
            with self._lock:
                self.running = False
            self.on_status("error", detail)
        except Exception:  # pragma: no cover - stdout 已断开时忽略
            pass

    # ---- 控制 ----

    def start(self, asr_config: dict | None = None) -> None:
        with self._lock:
            if self.running:
                return
            if self._record_stop is not None or self._mic_testing:
                self.on_status("stopped", "请先结束麦克风测试或录音，再开始实时识别")
                return
            self.running = True
            self._session += 1
            session = self._session
            if asr_config:
                self.asr_config = dict(asr_config)
            cfg = dict(self.asr_config)

        self._begin_recording(cfg)
        self.on_status("starting", "正在加载识别引擎")
        try:
            threading.Thread(target=self._boot_engine, args=(cfg, session), daemon=True).start()
        except Exception as exc:
            with self._lock:
                if self._session == session:
                    self.running = False
            self.on_status("error", f"无法启动识别线程：{exc}")

    def _boot_engine(self, config=None, session=None) -> None:
        engine = None
        session = self._session if session is None else session
        def current():
            with self._lock:
                return self.running and self._session == session and self.engine is engine
        try:
            with self._lock:
                if not self.running or self._session != session:
                    return
            if self.mock:
                from mock_engine import MockEngine
                engine = MockEngine()
            else:
                engine = self._create_engine(config)
            with self._lock:
                if not self.running or self._session != session:
                    engine.stop()
                    return
                # Track the engine BEFORE model loading, so stop can cancel its startup.
                self.engine = engine
                # 只有真实引擎有采集流；mock 模式没有音频可录
                engine.recorder = self.recorder
            engine.start(
                on_partial=lambda text: self.on_partial(text) if current() else None,
                on_final=lambda text: self.on_final(text) if current() else None,
                on_status=lambda state, detail="": self.on_status(state, detail) if current() else None,
            )
            if not current():
                engine.stop()
            elif self.mock:
                self.on_status("running")
            # Real engines report running only after the MF PCM stream is actually ready.
        except Exception as exc:
            if engine is not None:
                try:
                    engine.stop()
                except Exception as cleanup_error:
                    log("engine cleanup failed:", repr(cleanup_error))
            with self._lock:
                active = self._session == session and self.running
                if active:
                    self.running = False
                    self.engine = None
            if active:
                log("engine start failed:", repr(exc))
                self._finish_recording("failed")
                emit({"type": "error", "message": f"识别引擎启动失败：{exc}"})

    def _create_engine(self, config=None):
        cfg = self.asr_config if config is None else config
        engine = (cfg.get("engine") or "funasr").strip().lower()
        if engine == "whisper":
            from whisper_engine import WhisperEngine
            return WhisperEngine(config=cfg, models_dir=_models_dir())
        if engine == "api":
            from api_engine import ApiEngine
            return ApiEngine(config=cfg, models_dir=_models_dir())
        from asr_engine import FunAsrEngine
        return FunAsrEngine(config=cfg, models_dir=_models_dir())

    # ---- 设备与环境 ----

    def list_devices(self) -> None:
        from audio_devices import list_input_devices, list_output_devices
        try:
            inputs = list_input_devices()
        except Exception as exc:
            log("list input devices failed:", repr(exc))
            inputs = []
        try:
            outputs = list_output_devices()
        except Exception as exc:
            log("list output devices failed:", repr(exc))
            outputs = []
        emit({"type": "devices", "inputs": inputs, "outputs": outputs})

    def mic_test(self, config: dict | None = None) -> None:
        """采集 3 秒并回报峰值电平，用来判断麦克风到底有没有声音进来。"""
        with self._lock:
            if self._mic_testing:
                return
            if self._record_stop is not None or self.running:
                emit({"type": "mic_test", "ok": False, "peak": 0,
                      "detail": "请先结束录音或停止实时识别，再测试麦克风"})
                return
            if config is not None:
                self.asr_config = dict(config)
            self._mic_testing = True
            self._mic_stop = threading.Event()
            cfg = dict(self.asr_config)
        try:
            threading.Thread(target=self._do_mic_test, args=(cfg,), daemon=True).start()
        except Exception as exc:
            with self._lock:
                self._mic_testing = False
                self._mic_stop = None
            emit({"type": "mic_test", "ok": False, "peak": 0, "detail": str(exc)})

    # ---- 录制 + 识别测试 ----

    def record_test(self, seconds: float = 5.0, config: dict | None = None) -> None:
        """明确启动一轮录音；停止使用 stop_record，不复用上轮的停止标记。"""
        with self._lock:
            # 直到本轮关闭设备并保存完成才允许重入，不能只检查 Event.is_set()。
            if self._record_stop is not None:
                return
            if self.running or self._mic_testing:
                emit({"type": "record_result", "ok": False,
                      "detail": "请先结束麦克风测试或停止实时识别，再录制测试音频"})
                return
            if config is not None:
                self.asr_config = dict(config)
            cfg = dict(self.asr_config)
            stop_evt = threading.Event()
            self._record_stop = stop_evt
        try:
            threading.Thread(
                target=self._do_record_test,
                args=(float(seconds), stop_evt, cfg),
                daemon=True,
                name="record-test",
            ).start()
        except Exception as exc:
            self._finish_record(stop_evt, {
                "type": "record_result", "ok": False, "detail": f"无法启动录音：{exc}",
            })

    def stop_record(self) -> None:
        with self._lock:
            if self._record_stop is not None:
                self._record_stop.set()

    def _finish_record(self, stop_evt, result: dict) -> None:
        # 先复位再发终态：收到结果后立刻重录，也不会误操作上一轮。
        stop_evt.set()
        with self._lock:
            if self._record_stop is stop_evt:
                self._record_stop = None
        emit(result)

    def recognize_test(self, config: dict | None = None) -> None:
        """识别上一次录制的 wav，可反复点。分别报告加载耗时和推理耗时。"""
        if config:
            self.asr_config = config
        threading.Thread(target=self._do_recognize_test, daemon=True).start()

    def _do_record_test(self, seconds: float, stop_evt=None, config=None) -> None:
        stop_evt = stop_evt or self._record_stop or threading.Event()
        cfg = dict(self.asr_config if config is None else config)
        result = {"type": "record_result", "ok": False, "detail": "录音意外中断"}
        try:
            from audio_devices import capture_target, resolve_device
            if not (0 < seconds <= 60):
                raise ValueError("录音时长必须在 0 到 60 秒之间")
            target = capture_target(cfg)
            info = resolve_device(target["device"], kind=target["kind"])
            result = self._record_media_foundation(seconds, stop_evt, info, target["kind"])
        except Exception as exc:
            log(f"录音失败：{exc!r}")
            result = {"type": "record_result", "ok": False,
                      "detail": f"{type(exc).__name__}: {exc}"}
        finally:
            # 覆盖导入、查询、打开、读取、停止、保存的所有异常路径。
            self._finish_record(stop_evt, result)

    @staticmethod
    def _preserve_recording_reference() -> str:
        """Keep the previous recording byte-for-byte; never overwrite a reference."""
        import shutil

        reference = os.path.join(_data_dir(), "test_recording_reference.wav")
        current = os.path.join(_data_dir(), "test_recording.wav")
        if os.path.exists(reference):
            return reference
        if not os.path.exists(current):
            return ""
        try:
            target = open(reference, "xb")
        except FileExistsError:
            return reference
        try:
            with target, open(current, "rb") as source:
                shutil.copyfileobj(source, target)
        except Exception:
            try:
                os.remove(reference)
            except OSError:
                pass
            raise
        return reference

    def _record_media_foundation(self, seconds: float, stop_evt, info: dict,
                                 kind: str = "input") -> dict:
        import tempfile
        from mf_capture import capture_to_wave

        wav_path = os.path.join(_data_dir(), "test_recording.wav")
        fd, temporary = tempfile.mkstemp(prefix="recording-mf-", suffix=".wav", dir=_data_dir())
        os.close(fd)
        try:
            # Same PCM16 / 44.1kHz / mono format as wenzflow's voice-note recorder for
            # microphones; the loopback path converts the render mix to the same contract.
            result = capture_to_wave(temporary, seconds, info, stop_evt, emit,
                                     sample_rate=44100, channels=1, kind=kind)
            reference = self._preserve_recording_reference()
            os.replace(temporary, wav_path)
        finally:
            if os.path.exists(temporary):
                os.remove(temporary)
        detail = ("Windows WASAPI 环回 · 电脑声音" if kind == "output"
                  else "Windows Media Foundation 原生采集")
        result.update({"type": "record_result", "ok": True, "path": wav_path,
                       "referencePath": reference, "detail": detail,
                       "captureSource": kind})
        for key, digits in (("peak", 5), ("rms", 5), ("clipped", 2)):
            result[key] = round(result[key], digits)
        label = "电脑声音" if kind == "output" else "麦克风"
        log(f"{label}录音完成 {result['sampleRate']}Hz "
            f"{result['channels']}ch 时长={result['duration']}s 峰值={result['peak']} "
            f"不连续={result.get('discontinuities', 0)}")
        return result

    def _do_recognize_test(self) -> None:
        """识别 test_recording.wav，可反复调用（模型会缓存）。"""
        import soundfile as sf

        wav_path = os.path.join(_data_dir(), "test_recording.wav")
        if not os.path.exists(wav_path):
            emit({
                "type": "recognize_result",
                "ok": False,
                "detail": "还没有录音，请先点「录制 5 秒」",
            })
            return

        try:
            audio, sr = sf.read(wav_path, dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            # 录音是设备原始采样率，识别需要 16k
            if sr != 16000 and audio.size:
                from math import gcd

                from scipy.signal import resample_poly

                g = gcd(sr, 16000)
                audio = resample_poly(audio, 16000 // g, sr // g).astype("float32")
        except Exception as exc:
            emit({
                "type": "recognize_result",
                "ok": False,
                "detail": f"读取录音失败：{exc}",
            })
            return

        try:
            import contextlib

            t0 = time.time()
            model = self._get_test_model()
            load_seconds = time.time() - t0

            t1 = time.time()
            with contextlib.redirect_stdout(sys.stderr):
                text = self._recognize_array(model, audio)
            infer_seconds = time.time() - t1

            log(
                f"识别测试：时长 {len(audio) / 16000:.1f}s "
                f"加载 {load_seconds:.2f}s 推理 {infer_seconds:.2f}s -> {text!r}"
            )

            emit({
                "type": "recognize_result",
                "ok": True,
                "text": text,
                "duration": round(len(audio) / 16000, 2),
                "loadSeconds": round(load_seconds, 2),
                "inferSeconds": round(infer_seconds, 2),
            })
        except Exception as exc:
            log(f"识别测试失败：{exc!r}")
            emit({
                "type": "recognize_result",
                "ok": False,
                "detail": f"{type(exc).__name__}: {exc}",
            })

    def _get_test_model(self):
        """优先复用正在运行的引擎模型，没有就临时加载一个。"""
        engine = self.engine
        asr = getattr(engine, "_asr", None) if engine is not None else None
        if asr is not None:
            return asr

        if getattr(self, "_test_model", None) is not None:
            return self._test_model

        from funasr import AutoModel

        cfg = self.asr_config or {}
        cache_dir = (cfg.get("cacheDir") or "").strip()
        if cache_dir:
            os.environ.setdefault("MODELSCOPE_CACHE", cache_dir)

        target = (cfg.get("modelPath") or "").strip() or (cfg.get("model") or "paraformer-zh-streaming")
        kwargs = {
            "model": target,
            "cache_dir": "",
            "disable_update": True,
            "device": "cpu",
        }
        revision = (cfg.get("modelRevision") or "").strip()
        if revision and not (cfg.get("modelPath") or "").strip():
            kwargs["model_revision"] = revision

        import contextlib

        with contextlib.redirect_stdout(sys.stderr):
            self._test_model = AutoModel(**kwargs)
        return self._test_model

    @staticmethod
    def _recognize_array(model, audio) -> str:
        """把整段音频按 600ms 分块喂给流式模型。"""
        import numpy as np

        chunk_samples = 9600  # 600ms @ 16k
        cache: dict = {}
        text = ""
        total = len(audio)

        for start in range(0, total, chunk_samples):
            chunk = audio[start:start + chunk_samples]
            if len(chunk) < chunk_samples:
                chunk = np.pad(chunk, (0, chunk_samples - len(chunk)))
            is_final = start + chunk_samples >= total
            import contextlib

            with contextlib.redirect_stdout(sys.stderr):
                res = model.generate(
                    input=chunk,
                    cache=cache,
                    is_final=is_final,
                    chunk_size=[0, 10, 5],
                    encoder_chunk_look_back=4,
                    decoder_chunk_look_back=1,
                )
            if res:
                text += "".join(item.get("text", "") for item in res)
        return text

    def _do_mic_test(self, config=None) -> None:
        result = {"type": "mic_test", "ok": False, "peak": 0, "backend": "mediafoundation"}
        stop = self._mic_stop or threading.Event()
        kind = "input"
        try:
            import numpy as np
            from audio_devices import capture_target
            from mf_stream import PcmInputStream
            cfg = self.asr_config if config is None else config
            target = capture_target(cfg)
            kind = target["kind"]
            result["backend"] = "mediafoundation" if kind == "input" else "wasapi-loopback"
            result["captureSource"] = kind
            peak = rms = 0.0
            remaining = 3 * 16000
            with PcmInputStream(target["device"], kind=kind, stop_event=stop) as stream:
                while remaining > 0 and not stop.is_set():
                    data = stream.read(min(1600, remaining))
                    if not data.size:
                        break
                    peak = max(peak, float(np.max(np.abs(data))))
                    rms = max(rms, float(np.sqrt(np.mean(np.square(data)))))
                    remaining -= len(data)
            has_signal = rms > 0.001 and not stop.is_set()
            label = "电脑声音（WASAPI 环回）" if kind == "output" else "麦克风（Media Foundation）"
            result.update({"ok": has_signal, "peak": round(peak, 5), "rms": round(rms, 5),
                           "detail": ("测试已取消" if stop.is_set() else
                                      f"检测到输入（{label} · 16000Hz PCM16）" if has_signal else
                                      f"3 秒内没有检测到声音（{label} · 16000Hz PCM16）")})
        except Exception as exc:
            result["detail"] = f"{type(exc).__name__}: {exc}"
        finally:
            with self._lock:
                self._mic_testing = False
                if self._mic_stop is stop:
                    self._mic_stop = None
        emit(result)

    def selftest(self) -> None:
        """自检两条曾经出过问题的路径。

        1. ParaformerStreaming 是否注册成功
           （torch.jit.script 需要 .py 源码，打包后容易失败）
        2. CharTokenizer 能否实例化
           （register 装饰器的 inspect 调用依赖源码）
        """
        checks = []

        try:
            from funasr.register import tables
            import funasr.models.paraformer  # noqa: F401  触发模型注册

            registered = "ParaformerStreaming" in tables.model_classes
            checks.append({
                "name": "ParaformerStreaming 注册",
                "ok": registered,
                "detail": "" if registered else "模型类未出现在注册表中",
            })
        except Exception as exc:
            checks.append({
                "name": "ParaformerStreaming 注册",
                "ok": False,
                "detail": f"{type(exc).__name__}: {exc}",
            })

        try:
            import os
            import tempfile

            from funasr.tokenizer.char_tokenizer import CharTokenizer

            fd, path = tempfile.mkstemp(suffix=".txt")
            os.close(fd)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("测 测 试\n")
            try:
                tokenizer = CharTokenizer(seg_dict=path)
                ok = tokenizer.seg_dict is not None
                detail = "" if ok else "seg_dict 为空"
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
            checks.append({"name": "CharTokenizer 实例化", "ok": ok, "detail": detail})
        except Exception as exc:
            checks.append({
                "name": "CharTokenizer 实例化",
                "ok": False,
                "detail": f"{type(exc).__name__}: {exc}",
            })

        all_ok = all(c["ok"] for c in checks)
        emit({
            "type": "selftest",
            "ok": all_ok,
            "detail": "; ".join(
                f"{c['name']}={'OK' if c['ok'] else 'FAIL'}"
                + (f"({c['detail']})" if c["detail"] else "")
                for c in checks
            ),
            "checks": checks,
        })

    def check_env(self, engine: str, config: dict | None = None) -> None:
        try:
            from installer import check_env
            cfg = self.asr_config if config is None else config
            result = check_env(engine or "funasr", cfg)
        except Exception as exc:
            result = {"engine": engine, "deps": [], "ready": False, "error": str(exc)}
        emit({"type": "env", **result})

    def install(self, engine: str, config: dict | None) -> None:
        with self._lock:
            if self._installing:
                emit({"type": "install", "phase": "log", "message": "已有安装任务在进行中"})
                return
            if config:
                # 记住当前配置，安装后的环境检查才能读到接口地址等信息
                self.asr_config = dict(config)
            self._installing = True
        threading.Thread(target=self._do_install, args=(engine, config), daemon=True).start()

    def _do_install(self, engine: str, config: dict | None) -> None:
        from installer import run_install

        emit({"type": "install", "phase": "start", "engine": engine})
        ok = False
        try:
            ok = run_install(
                engine or "funasr",
                config or {},
                _models_dir(),
                lambda message: emit({"type": "install", "phase": "log", "message": message}),
            )
        except Exception as exc:
            emit({"type": "install", "phase": "log", "message": f"安装异常：{exc}"})

        with self._lock:
            self._installing = False
        emit({"type": "install", "phase": "done", "ok": ok, "engine": engine})
        self.check_env(engine)

    def switch_capture(self, config: dict | None = None) -> None:
        """运行中切换采集来源：只重建底层音频流，已加载的模型继续用。"""
        with self._lock:
            if config:
                self.asr_config = dict(config)
            cfg = dict(self.asr_config)
            engine = self.engine
            running = self.running
        try:
            from audio_devices import capture_target
            target = capture_target(cfg)
        except Exception as exc:
            emit({"type": "capture_switch", "ok": False,
                  "detail": f"无法解析采集设备：{exc}"})
            return
        if not running or engine is None:
            # 没有在跑就只更新配置，下次 start 会直接用新来源
            emit({"type": "capture_switch", "ok": True, "applied": False,
                  "kind": target["kind"], "device": target["device"],
                  "label": target["label"],
                  "detail": "识别未运行，采集来源已保存，下次开始时生效"})
            return
        try:
            info = engine.switch_capture(target["kind"], target["device"])
        except Exception as exc:
            log("switch capture failed:", repr(exc))
            emit({"type": "capture_switch", "ok": False,
                  "kind": target["kind"], "label": target["label"],
                  "detail": f"切换失败：{exc}"})
            return
        emit({"type": "capture_switch", "ok": True,
              "applied": bool(info.get("switched")), **info})

    def stop(self) -> None:
        self.stop_record()
        with self._lock:
            if self._mic_stop is not None:
                self._mic_stop.set()
            was_running = self.running
            self.running = False
            self._session += 1
            engine, self.engine = self.engine, None
            if engine is not None:
                # 先断开引用，避免引擎线程收尾时继续往已关闭的录制器写音频
                engine.recorder = None
        if not was_running and engine is None:
            self._finish_recording("stopped")
            return
        if engine is not None:
            try:
                engine.stop()
            except Exception as exc:
                log("engine stop failed:", repr(exc))
        # 字幕与音频文件在这里落盘：即使识别被异常中断，已录内容也会保留
        self._finish_recording("completed" if was_running else "stopped")
        self.on_status("stopped")


def _data_dir() -> str:
    """录音等诊断文件的存放目录（与模型目录同级）。"""
    import os

    if getattr(sys, "frozen", False):
        base = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "livetool")
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    os.makedirs(base, exist_ok=True)
    return base


def _models_dir() -> str:
    """模型缓存目录。

    源码运行时放项目下 models/（方便查看），打包后安装目录通常只读
    （Program Files），改放 %APPDATA%/livetool/models。
    """
    import os

    if getattr(sys, "frozen", False):
        base = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "livetool")
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    path = os.path.join(base, "models")
    os.makedirs(path, exist_ok=True)
    return path


def stdin_loop(backend: Backend) -> None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            log("无法解析的命令:", line)
            continue

        kind = cmd.get("type")
        if kind in ("mic_test", "record_test", "recognize_test") or (kind == "start" and not backend.mock):
            # 安装依赖后也在主线程补做预热，不把首次导入留给工作线程。
            warmup_audio_runtime()
        if kind == "start":
            backend.start(cmd.get("asr"))
        elif kind == "list_devices":
            backend.list_devices()
        elif kind == "selftest":
            backend.selftest()
        elif kind == "mic_test":
            backend.mic_test(cmd.get("asr"))
        elif kind == "record_test":
            backend.record_test(cmd.get("seconds", 5), cmd.get("asr"))
        elif kind == "recognize_test":
            backend.recognize_test(cmd.get("asr"))
        elif kind == "stop_record":
            backend.stop_record()
        elif kind == "check_env":
            backend.check_env(cmd.get("engine"), cmd.get("asr"))
        elif kind == "switch_capture":
            backend.switch_capture(cmd.get("asr"))
        elif kind == "set_record":
            backend.set_record(bool(cmd.get("enabled")), cmd.get("asr"))
        elif kind == "install":
            backend.install(cmd.get("engine"), cmd.get("asr"))
        elif kind == "stop":
            backend.stop()
        elif kind == "shutdown":
            backend.stop()
            return
        else:
            log("未知命令:", kind)


_audio_runtime_ready = False


def warmup_audio_runtime() -> None:
    """Windows 数值库必须在 stdio 开始阻塞读取前，由主线程首次加载。

    NumPy/SciPy 的原生 DLL 初始化可能检查 stdin；若另一线程正阻塞读
    管道，首次导入会一直等到下一条输入（numpy/numpy#24290）。
    仅预热音频依赖，不加载任何识别模型；缺依赖仍允许打开环境安装界面。
    """
    global _audio_runtime_ready
    if sys.platform != "win32" or _audio_runtime_ready:
        return
    import importlib

    started = time.monotonic()
    ready = True
    for name in ("numpy", "scipy.signal", "soundfile"):
        try:
            importlib.import_module(name)
        except Exception as exc:
            ready = False
            log(f"音频依赖 {name} 尚不可用：{exc!r}")
    _audio_runtime_ready = ready
    log(f"音频运行库预热 {'完成' if ready else '未齐全'}，耗时 {time.monotonic() - started:.2f}s")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock", action="store_true", help="用模拟数据驱动，不加载模型")
    args = parser.parse_args()

    if not args.mock:
        warmup_audio_runtime()
    emit({"type": "status", "state": "idle", "detail": ""})
    backend = Backend(mock=args.mock)

    # 任何未捕获异常都先收尾录制会话再退出：主进程会重新拉起本进程，
    # 已录内容不能因为崩溃而丢掉。
    def handle_exception(exc_type, exc, tb, thread=None) -> None:
        name = getattr(thread, "name", "main") if thread is not None else "main"
        detail = f"{exc_type.__name__}: {exc}（线程 {name}）"
        try:
            backend.abort(detail)
        finally:
            import traceback

            traceback.print_exception(exc_type, exc, tb, file=sys.stderr)

    def thread_exception(hook_args) -> None:
        handle_exception(hook_args.exc_type, hook_args.exc_value,
                         hook_args.exc_traceback, hook_args.thread)

    sys.excepthook = handle_exception
    threading.excepthook = thread_exception

    try:
        stdin_loop(backend)
    except KeyboardInterrupt:
        pass
    except BaseException as exc:  # noqa: BLE001 - 崩溃前必须先保住已录内容
        log("主循环异常，先保存录制内容：", repr(exc))
        backend.abort(f"{type(exc).__name__}: {exc}")
        raise
    finally:
        # stop() 内部会再调用一次 _finish_recording，重复调用是安全的
        backend.stop()


if __name__ == "__main__":
    main()
