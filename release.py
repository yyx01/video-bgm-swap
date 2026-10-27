#!/usr/bin/env python3
"""
上传免安装版 zip 到 GitHub Releases。

用法（Windows PowerShell）：
    $env:GH_TOKEN = "ghp_你的经典令牌"
    python release.py

要求：GitHub 经典令牌（ghp_ 开头），权限勾选 repo。
"""
import json
import os
import sys
import urllib.error
import urllib.request

REPO = "yyx01/video-bgm-swap"
TAG = "v0.5.0"
NAME = "bgm-separate-server-win.zip"
ASSET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist", NAME)

token = os.environ.get("GH_TOKEN", "")
if not token:
    print("错误：请先设置环境变量 GH_TOKEN")
    print('   PowerShell:  $env:GH_TOKEN = "ghp_你的令牌"')
    sys.exit(1)
if not os.path.exists(ASSET):
    print("错误：找不到文件", ASSET)
    print("请先运行 build.bat 打包 exe。")
    sys.exit(1)


def api(path, method="GET", data=None, raw_body=None, content_type=None):
    url = "https://api.github.com" + path
    headers = {
        "Authorization": "Bearer " + token,
        "User-Agent": "video-bgm-swap-release",
        "Accept": "application/vnd.github+json",
    }
    body = raw_body
    if raw_body is None:
        body = json.dumps(data).encode() if data else None
        if data is not None:
            headers["Content-Type"] = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, method=method, data=body, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


# 1) 创建 Release（tag 已存在则直接使用该 release）
status, body = api(
    f"/repos/{REPO}/releases",
    "POST",
    {
        "tag_name": TAG,
        "name": "v0.5.0",
        "body": "免安装版本地服务（Windows）\n"
                "- 解压后双击 `bgm-separate-server\\bgm-separate-server.exe` 即可启动\n"
                "- 无需安装 Python，仅代理模式（在线搜索 / BGM替换）\n"
                "- AI 人声分离请使用源码运行（见 README）",
        "draft": False,
        "prerelease": False,
    },
)
release = json.loads(body) if body else {}
if status not in (200, 201):
    status, body = api(f"/repos/{REPO}/releases/tags/{TAG}")
    release = json.loads(body) if body else {}
    if status != 200:
        print("创建/获取 Release 失败:", status, body[:300])
        sys.exit(1)
print("Release 页:", release.get("html_url"))

# 2) 上传 zip 作为 asset
release_id = release.get("id")
upload_url = release.get("upload_url", "").replace("{?name,label}", "?name=" + NAME)
if not upload_url:
    print("错误：release 没有 upload_url")
    sys.exit(1)
with open(ASSET, "rb") as f:
    asset_bytes = f.read()
status, body = api(upload_url, "POST", raw_body=asset_bytes, content_type="application/zip")
if status in (200, 201):
    asset = json.loads(body)
    print("上传成功:", asset.get("browser_download_url"))
else:
    print("上传失败:", status, body[:300])
    sys.exit(1)