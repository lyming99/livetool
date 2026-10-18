# -*- coding: utf-8 -*-
"""修正 funasr 的 char_tokenizer 模块。

问题：
    funasr/tokenizer/char_tokenizer.py 把 load_seg_dict / seg_tokenize 定义在
    CharTokenizer 类之后。源码运行没问题（方法是运行时才查全局名字），但
    PyInstaller 打包后，类上的 @tables.register 装饰器在模块初始化早期就执行，
    此时尾部的函数还没绑定到模块命名空间，加载模型时会抛：
        NameError: name 'load_seg_dict' is not defined

修法：
    把这两个纯函数移到类定义之前。逻辑不变，只是顺序调整。

用法: python tools/patch_funasr.py
幂等：已经 patch 过会直接跳过。
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass


def find_target() -> str | None:
    spec = importlib.util.find_spec("funasr.tokenizer.char_tokenizer")
    return spec.origin if spec else None


REGISTER_NEEDLE = """            class_file = inspect.getfile(target_class)
            class_line = inspect.getsourcelines(target_class)[1]
            pattern = r"^.+/funasr/"
            class_file = re.sub(pattern, "funasr/", class_file)
            meta_data = ["""

REGISTER_PATCHED = """            try:
                class_file = inspect.getfile(target_class)
                class_line = inspect.getsourcelines(target_class)[1]
                pattern = r"^.+/funasr/"
                class_file = re.sub(pattern, "funasr/", class_file)
            except (OSError, TypeError):
                # PyInstaller 打包后没有 .py 源文件，inspect 拿不到位置信息，
                # 之前的版本会直接抛 OSError，把整个模块的初始化打断
                # （表现就是 load_seg_dict 之类的名字变成未定义）。
                # 这里只影响注册表里的调试元数据，不应该让注册失败。
                class_file = getattr(target_class, "__module__", "")
                class_line = 0
            meta_data = ["""


def patch_register(path: str) -> None:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    if REGISTER_PATCHED in text:
        print("register.py 已经是容错版本")
        return

    if REGISTER_NEEDLE not in text:
        print("register.py 结构不符合预期，跳过")
        return

    backup = path + ".bak"
    if not os.path.exists(backup):
        shutil.copy2(path, backup)

    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text.replace(REGISTER_NEEDLE, REGISTER_PATCHED))

    print(f"已修正：{path}")


def main() -> int:
    path = find_target()
    if not path or not os.path.exists(path):
        print("找不到 funasr/tokenizer/char_tokenizer.py，跳过")
        return 0

    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    class_pos = text.find("class CharTokenizer")
    decorator_pos = text.find("@tables.register")
    func_pos = text.find("def load_seg_dict(")

    if class_pos < 0 or func_pos < 0 or decorator_pos < 0:
        print("文件结构不符合预期，跳过")
        return 0

    if func_pos < class_pos:
        print("char_tokenizer 已经是修正后的顺序")
    else:
        # 以装饰器之前的空行为界，把整块「类定义」和「函数定义」对调
        split_at = text.rfind("\n\n\n", 0, decorator_pos)
        if split_at < 0:
            split_at = decorator_pos

        head = text[:split_at].rstrip("\n")
        class_part = text[split_at:func_pos].strip("\n")
        func_part = text[func_pos:].rstrip("\n")

        patched = (
            head
            + "\n\n\n"
            + func_part
            + "\n\n\n"
            + class_part
            + "\n"
        )

        backup = path + ".bak"
        if not os.path.exists(backup):
            shutil.copy2(path, backup)

        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(patched)

        print(f"已修正顺序：{path}")

    # 第二处：register 装饰器的 inspect 调用在打包环境会抛 OSError
    register_path = os.path.join(os.path.dirname(os.path.dirname(path)), "register.py")
    if os.path.exists(register_path):
        patch_register(register_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
