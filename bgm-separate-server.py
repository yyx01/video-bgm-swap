# -*- coding: utf-8 -*-
"""
本地服务（配合 视频BGM替换器.user.js 使用）
============================================
包含两部分：
  1) WebSocket 人声/伴奏分离服务（端口 8765）【可选，需要 demucs】
  2) HTTP 代理（端口 8766）：转发浏览器请求到音乐API/音频直链，绕过浏览器跨域限制

功能：
  - AI 模式下：接收浏览器通过 WebSocket 发来的音频块（interleaved Float32 PCM），
    用 Demucs htdemucs 模型分离出【人声】和【伴奏】两轨，一起返回给浏览器。
    返回格式：4 通道交错 Float32 = [人声L, 人声R, 伴奏L, 伴奏R] x n
  - 浏览器通过 http://127.0.0.1:8766/fetch 访问音乐API，
    通过 http://127.0.0.1:8766/audio?url=... 下载音频直链。

依赖说明（开源友好）：
  【核心模式】（在线搜索 / BGM替换 / 仅BGM兜底）【默认】：
    仅需 Python 3.8+ 标准库，零第三方依赖。
    运行：python bgm-separate-server.py

  【AI人声分离模式】（保留人声/只替换伴奏）【显式开启】：
    额外安装：pip install demucs torch websockets numpy
    运行：python bgm-separate-server.py --ai
    首次运行会下载 htdemucs 模型（约80MB），之后缓存到本地。
    需要 demucs >= 4.1.0。

运行：
  python bgm-separate-server.py            # 默认仅代理（推荐，稳定轻量）
  python bgm-separate-server.py --ai      # 启用 AI 人声分离
"""

import asyncio
import json
import ssl
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

SAMPLE_RATE = 44100  # 与浏览器 AudioContext 采样率一致

_BUFFER_SECONDS = 4
_BUFFER_SAMPLES = SAMPLE_RATE * _BUFFER_SECONDS

# 本地代理忽略SSL证书校验（个人工具，部分音乐API证书不全）
_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

# ==================== 可选 AI 依赖（仅当显式加 --ai 参数时启用） ====================
# 默认【仅代理模式】：零第三方依赖、不加载模型，稳定轻量。
# 需要 AI 人声分离（保留人声/只替换伴奏）时运行：python bgm-separate-server.py --ai
_ENABLE_AI = "--ai" in sys.argv

if _ENABLE_AI:
    try:
        import numpy as np
        import torch
        import websockets
        from demucs.pretrained import get_model
        from demucs.apply import apply_model

        AI_AVAILABLE = True
        _AI_IMPORT_ERROR = None
    except Exception as _ai_err:  # noqa: BLE001 - 缺依赖时降级为仅代理模式
        AI_AVAILABLE = False
        _AI_IMPORT_ERROR = _ai_err
else:
    AI_AVAILABLE = False
    _AI_IMPORT_ERROR = None

if AI_AVAILABLE:
    print("正在加载 Demucs htdemucs 模型（首次运行会下载模型，请耐心等待）...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = get_model("htdemucs")
    model.to(device)
    model.eval()
    print(f"模型加载完成，sources={model.sources}, device={device}")
elif _ENABLE_AI:
    print("检测到 --ai 参数，但 AI 依赖缺失，已降级为【仅代理模式】。")
    if _AI_IMPORT_ERROR:
        print("      导入失败原因:", _AI_IMPORT_ERROR)
    print("      请先安装: pip install demucs torch websockets numpy")
else:
    print("当前为【仅代理模式】（默认，零依赖）：在线搜索 / BGM替换可用，无人声分离。")
    print("如需 AI 人声分离（保留人声 / 只替换伴奏），请运行: python bgm-separate-server.py --ai")


def separate_buffer(audio_np):
    """
    audio_np: shape (2, T) float32 numpy array
    returns: vocals (2, T), accomp (2, T)  float32 numpy arrays
    仅在 AI_AVAILABLE 时被调用。
    """
    try:
        mix = torch.from_numpy(audio_np).unsqueeze(0).to(device)
        with torch.no_grad():
            result = apply_model(model, mix, shifts=1, split=True, overlap=0.25, device=device)
        result_np = result.cpu().numpy()
        vocals = result_np[0, 3]
        accomp = np.sum(result_np[0, :3], axis=0)
        return vocals.astype(np.float32), accomp.astype(np.float32)
    except Exception as e:
        print("分离失败，回退为原声:", e)
        return audio_np, np.zeros_like(audio_np)


# ==================== HTTP 代理（端口 8766）====================
class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 关闭默认请求日志

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        # 关键：Chrome 要求公开网页请求 localhost 时预检带此头，否则直接拦截
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/audio":
            url = qs.get("url", [""])[0]
            if not url:
                self.send_response(400)
                self.end_headers()
                return
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
                    data = resp.read()
                    ctype = resp.headers.get("Content-Type", "application/octet-stream")
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(data)))
                    self._cors_headers()
                    self.end_headers()
                    self.wfile.write(data)
            except Exception as e:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self._cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/fetch":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            payload = {}
        url = payload.get("url", "")
        method = payload.get("method", "GET")
        headers = {k: v for k, v in (payload.get("headers") or {}).items()}
        body = payload.get("body")

        try:
            req = urllib.request.Request(url, method=method, headers=headers)
            if body:
                data_bytes = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
                req.data = data_bytes
                if not any(k.lower() == "content-type" for k in headers):
                    req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=25, context=_SSL_CTX) as resp:
                data = resp.read().decode("utf-8", errors="replace")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self._cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({
                    "statusCode": resp.status,
                    "headers": dict(resp.headers),
                    "body": data
                }).encode("utf-8"))
        except urllib.error.HTTPError as e:
            data = e.read().decode("utf-8", errors="replace")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({
                "statusCode": e.code,
                "headers": dict(e.headers),
                "body": data
            }).encode("utf-8"))
        except Exception as e:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({
                "statusCode": 0,
                "headers": {},
                "body": "",
                "error": str(e)
            }).encode("utf-8"))


def start_http_proxy():
    try:
        server = HTTPServer(("127.0.0.1", 8766), ProxyHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print("HTTP 代理已启动: http://127.0.0.1:8766")
    except Exception as e:
        print("HTTP 代理启动失败（端口可能被占用）:", e)


# ==================== WebSocket 人声分离（端口 8765，可选） ====================
async def handler(ws):
    """仅在 AI_AVAILABLE 时被注册。"""
    print("浏览器已连接:", ws.remote_address)
    audio_buffer = np.zeros((2, 0), dtype=np.float32)
    total_processed = 0

    try:
        async for message in ws:
            try:
                pcm = np.frombuffer(message, dtype=np.float32)
                if pcm.size == 0:
                    continue

                if pcm.size % 2 == 0:
                    frame = pcm.reshape(2, -1)
                else:
                    frame = pcm.reshape(1, -1)
                    frame = np.vstack([frame, frame])

                audio_buffer = np.concatenate([audio_buffer, frame], axis=1)

                if audio_buffer.shape[1] >= _BUFFER_SAMPLES:
                    tail = audio_buffer[:, -_BUFFER_SAMPLES:]
                    vocals, accomp = separate_buffer(tail)

                    new_samples = audio_buffer.shape[1] - total_processed
                    new_samples = min(new_samples, _BUFFER_SAMPLES)
                    v = vocals[:, -new_samples:]
                    a = accomp[:, -new_samples:]

                    if v.ndim == 1:
                        v = np.vstack([v, v])
                    if a.ndim == 1:
                        a = np.vstack([a, a])

                    n = v.shape[1]
                    out = np.empty(4 * n, dtype=np.float32)
                    out[0::4] = v[0]
                    out[1::4] = v[1]
                    out[2::4] = a[0]
                    out[3::4] = a[1]

                    total_processed += new_samples
                    await ws.send(out.tobytes())
            except websockets.ConnectionClosed:
                # 客户端直接断开（刷新页面/关闭标签页），正常退出，不刷屏
                break
            except Exception as e:
                print("处理音频块失败:", e)
    except websockets.ConnectionClosed:
        print("浏览器断开连接")
    finally:
        print("连接已关闭:", ws.remote_address)


async def main():
    if AI_AVAILABLE:
        print(f"本地人声分离服务已启动: ws://127.0.0.1:8765 (buffer={_BUFFER_SECONDS}s)")
        async with websockets.serve(handler, "127.0.0.1", 8765):
            await asyncio.Future()
    else:
        print("AI 人声分离未启用（仅 HTTP 代理运行中，端口 8766）。")
        print("如需 AI 人声分离，请停止后运行: python bgm-separate-server.py --ai")
        print("按 Ctrl+C 退出。")
        while True:
            await asyncio.sleep(3600)


if __name__ == "__main__":
    start_http_proxy()
    asyncio.run(main())