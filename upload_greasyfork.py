#!/usr/bin/env python3
"""
发布/更新油猴脚本到 Greasy Fork。

用法（Windows PowerShell）：
    $env:GF_API_KEY = "你的Greasy Fork API密钥"
    python upload_greasyfork.py

获取 API 密钥：登录 Greasy Fork → https://greasyfork.org/en/users/edit → 页面底部"API 密钥"
"""
import os
import sys
import uuid
import urllib.error
import urllib.request

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "video-bgm-swap.user.js")
API_URL = "https://greasyfork.org/en/scripts"

api_key = os.environ.get("GF_API_KEY", "")
if not api_key:
    print("错误：请先设置环境变量 GF_API_KEY")
    print('   PowerShell:  $env:GF_API_KEY = "你的密钥"')
    sys.exit(1)
with open(SCRIPT, "r", encoding="utf-8") as f:
    code = f.read()
print("脚本大小:", len(code), "字符")

# multipart/form-data
boundary = uuid.uuid4().hex
fields = [
    ("api_key", api_key),
    ("name", "视频BGM替换器"),
    ("code", code),
]
body = b""
for name, value in fields:
    body += (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
        f"{value}\r\n"
    ).encode("utf-8")
body += f"--{boundary}--\r\n".encode("utf-8")

req = urllib.request.Request(
    API_URL,
    method="POST",
    data=body,
    headers={
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "User-Agent": "video-bgm-swap-publisher",
    },
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read().decode("utf-8", "replace")
        print("上传成功! HTTP", r.status)
        # 解析跳转/脚本链接
        import re
        m = re.search(r'https://greasyfork.org/[^"\']*/scripts/\d+', data)
        if m:
            print("脚本地址:", m.group(0))
        else:
            print("响应片段:", data[:300])
except urllib.error.HTTPError as e:
    print("上传失败:", e.code)
    print(e.read().decode("utf-8", "replace")[:500])