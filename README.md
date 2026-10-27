# 🎵 视频BGM替换器（油猴脚本版）

看视频时用**自己选的音乐**替换原视频背景音乐，人声音量拉低/拉高即可控制是否保留人声（AI 实时分离）。支持**导入洛雪(LX Music)聚合音源文件**在线搜索播放，**播放失败自动更换音源**。

**v0.5.0 更新（Sollin 式导入模式）：**

- 📦 **Sollin 式音源导入**：参照 GitHub 开源项目 `Ryderwe/Sollin-Music-Desktop` 的模式——**宿主负责搜索，LX 音源只负责解析播放链接**。导入音源后立即能用
- 🔍 **五大平台内置搜索**：网易云 / QQ音乐 / 酷我 / 酷狗 / 咪咕，无需依赖音源自带搜索（多数 LX 音源只实现了 `musicUrl`，没有 `musicSearch`）
- ✅ **兼容更多音源**：`墨澜音乐源`、`念心音源`、`长青SVIP音源`、`全豆要-聚合音源` 等 LX Music 音源均可导入（部分音源需 `utils.crypto` 已内置 MD5/AES）
- 💾 **音源只导入一次**：导入后自动保存到 localStorage，刷新/重开页面自动恢复，面板实时显示已导入音源（可单独删除）
- 📂 **支持一次选择多个音源文件**同时导入
- ⏸️ **BGM 跟随视频暂停**：视频暂停时 BGM 一起停，恢复播放后从暂停处继续
- 🎚️ **未启用替换时也能调原视频音量**：AI 分离下，即使不启用替换，人声音量/背景声音量也分别控制原视频的人声与伴奏
- 🔁 **播放失败自动换源**：单曲依次尝试 ，直到拿到可播放音频
- 🌐 **本地HTTP代理**：端口 8766 转发音乐API/音频直链，已支持 Chrome 私有网络访问（PNA）预检头
- 🚀 AudioWorklet 实时分离（被拦截时自动回退 ScriptProcessor），消除视频卡顿

## 文件说明

| 文件                                                 | 作用                                                |
| -------------------------------------------------- | ------------------------------------------------- |
| `video-bgm-swap.user.js`                           | 油猴脚本（主程序：替换面板+本地音源库+内置搜索+导入LX音源）                  |
| `dist\bgm-separate-server\bgm-separate-server.exe` | **免安装版本地服务**（Windows，无需Python，双击即用，仅代理模式）         |
| `bgm-separate-server.py`                           | 本地服务源码：端口8765人声/伴奏分离（可选AI `--ai`） + 端口8766 HTTP代理 |
| `start.bat`                                        | Windows 一键启动（自动优先使用免安装版 exe，无 exe 时用 Python）      |
| `start.sh`                                         | Linux/macOS 一键启动本地服务                              |
| `requirements.txt`                                 | AI 人声分离可选依赖（demucs/torch/websockets/numpy）        |
| `test-crypto.js`                                   | （可选）MD5/AES 标准向量自测脚本                              |

**部署要求**：

- **核心模式**（在线搜索 / BGM替换 / 仅BGM兜底）：Windows 用户**只需双击 `start.bat`**（自动使用免安装版 exe，连 Python 都不用装）；其他系统需 Python 3.8+ 标准库
- **AI 人声分离模式**（保留人声 / 只替换伴奏）：需要 Python 环境，`pip install -r requirements.txt` 后加 `--ai` 启动

---

## 📥 安装油猴脚本（三种方式任选）

### 方式 1：一键安装（网络通畅时最快）

点击下面的按钮，**Tampermonkey 会自动弹出安装确认**，点「安装」即可：

[![安装脚本](https://img.shields.io/badge/一键安装-油猴脚本-2ea44f?style=for-the-badge)](https://raw.githubusercontent.com/yyx01/video-bgm-swap/master/video-bgm-swap.user.js)

备用链接（同样点击即装）：
[jsDelivr 安装](https://cdn.jsdelivr.net/gh/yyx01/video-bgm-swap@master/video-bgm-swap.user.js)

> 如果点击后没有弹出安装页，可能是 `raw.githubusercontent.com` / `cdn.jsdelivr.net` 在你的网络下无法访问（国内常见），请改用方式 2 或方式 3。

### 方式 2：从 Release 下载后拖拽安装（最稳，无需访问 CDN）

1. 打开 👉 **https://github.com/yyx01/video-bgm-swap/releases**（GitHub 主站一般可直接访问）
2. 在 v0.5.0 的 **Assets** 里下载 **`video-bgm-swap.user.js`**
3. 把这个文件**直接拖进** Tampermonkey 的「已安装脚本」页面 → 点「安装」

### 方式 3：本地文件直接拖拽（已有项目源码时）

直接把 `video-bgm-swap.user.js` 文件**拖进** Tampermonkey 的「已安装脚本」页面 → 点「安装」。

---

## 🚀 快速开始（3 步）

1. **安装油猴脚本**：点击上方「一键安装」按钮 → Tampermonkey 弹出确认 → 点「安装」
2. **启动本地服务**：Windows 双击 `start.bat`（或直接双击 `dist\bgm-separate-server\bgm-separate-server.exe`），看到 `HTTP 代理已启动: http://127.0.0.1:8766` 即成功
3. **刷新视频页**：右上角出现 🎵 面板 → 导入音源/选本地音乐 → 勾选「启用替换」→ **直接可用**

---

## 一、安装油猴脚本

1. 浏览器安装 **Tampermonkey（篡改猴）** 扩展
2. **拖拽安装（最简单）**：把 `video-bgm-swap.user.js` 文件**直接拖进** Tampermonkey 的「已安装脚本」页面，点击「安装」即可
   - 或者：点击 Tampermonkey 图标 → **添加新脚本** → 把文件内容**全部复制粘贴**进去 → `Ctrl+S`
3. 打开任意视频网站（B站 / YouTube 等）并刷新页面
4. 页面右上角会出现 **🎵 BGM 替换器** 面板（拖动标题栏可移动，点"—"最小化，点"×"收起为小圆点）

> 脚本默认在**所有网站**运行，但页面上没有 `<video>` 时不会启动任何东西，可放心。

---

## 二、启动本地服务

> **默认是【仅代理模式】：零依赖、稳定轻量**（在线搜索 / BGM替换可用，无人声分离）。
> 只有你需要**保留人声 / 只替换伴奏**时，才需要额外启用 AI 模式。

### 方式 1：一键启动（推荐新手）

- **Windows**：双击 `start.bat`
- **Linux / macOS**：终端执行 `bash start.sh`

启动器行为：

- 未装 AI 依赖 → 直接以**仅代理模式**启动
- 已装 AI 依赖 → 询问你是否启用 AI 人声分离（输入 `y` 启用，默认不启用）

### 方式 2：命令行手动启动

```bash
# 默认：仅代理模式（零依赖，在线搜索/替换可用，无人声分离）
python bgm-separate-server.py

# 如需 AI 人声分离（保留人声 / 只替换伴奏），先装依赖再启动：
pip install -r requirements.txt
python bgm-separate-server.py --ai
```

启动后会看到：

- `HTTP 代理已启动: http://127.0.0.1:8766`（必现）
- AI 模式（`--ai`）还会看到：`本地人声分离服务已启动: ws://127.0.0.1:8765`

> 首次 AI 模式运行会下载 htdemucs 模型（约80MB），之后自动缓存。
> 服务不启动也能用"仅BGM"兜底替换，但没有AI人声分离，在线音乐也无法播放。

---

## 三、快速体验"仅BGM"（不启动Python也能用）

1. 点 **【➕ 本地音乐】** 选本地音乐，或 **【📦 导入音源】** 导入聚合音源文件后在线搜索
2. 在搜索结果/本地列表里**点选一首**作为BGM
3. 勾选 **【启用替换】**
4. 把 **人声音量** 拉到底（0）= 没有人声，只留BGM
5. 用 **背景声音量** 调节BGM响度；设置 BGM 开始时间 / 结束时间 / 起始位置

> 不启动Python时：替换窗口内原声被静音、只播BGM；窗口外恢复原声（状态栏显示"仅BGM兜底"）。

---

## 四、使用AI保留人声（启动Python后）

启动本地服务后，脚本自动进入 AI 分离：

- **人声是通用的**：无论是否替换、替换窗口内外，**人声音量始终控制原视频的人声**；替换只影响背景音乐——窗口内原伴奏被新BGM替代，人声原样保留
- **人声音量**：100=人声全保留；50=人声减半；**0=没有人声（只剩BGM）**
- **背景声音量**：一个滑块自动切换两种作用——
  - **替换窗口内**：调的是**新BGM**的音量
  - **替换窗口外（或未启用替换）**：调的是**原伴奏**的音量（拉到底=没有伴奏声，只有人声）
- **未勾选"启用替换"时**：人声/背景声滑块仍然生效，分别调节原视频的人声和伴奏音量
- **BGM 跟随视频暂停**：视频暂停 BGM 停止，继续播放时从暂停处恢复
- 服务断开时自动回到"仅BGM兜底"，不会没声音

---

## 五、导入音源 & 在线搜索（v0.5.0）

**支持的音源类型**：洛雪音乐(LX Music)生态的 `.js` 音源文件，例如：

- `墨澜音乐源 v2.3.0.js`（仅实现 `musicUrl`，需 `utils.crypto`，已内置）
- `念心音源 v1.0.2.js`、`长青SVIP音源(二改).js`（混淆版也兼容）
- `全豆要-聚合音源 v10.00.js`（额外支持汽水VIP搜索）

**使用步骤**：

1. 点 **【📦 导入音源】**，选择一个或多个 LX 音源 `.js` 文件（可按住 Ctrl 多选）
2. 导入成功后面板显示 **📦 已导入音源** 列表（带名字和 × 删除按钮）
3. 音源会自动保存，**刷新页面后无需重新导入**
4. 在搜索框输入**歌名/歌手**，回车或点【搜索】
5. 脚本用内置的五大平台搜索（网易云/QQ/酷我/酷狗/咪咕），列表出现 **🌐 在线结果**（带平台徽标）
6. 点任意一首：
   - 脚本自动让已导入的音源解析播放链接（**最新导入的音源优先**）
   - 失败时**自动依次尝试其他平台/音质**，直到拿到能播放的音频
   - 成功后状态栏显示 `已加载: 歌曲名（平台 · 音源 320k）`
7. 再点一次已加载的歌曲即可立即切换

> 在线播放依赖本地HTTP代理（端口8766），请保持 `bgm-separate-server.py` 运行。
> 聚合音源来自第三方API，可用性随时可能变化；失败时脚本会自动换源。
> 若某个音源文件解析报错，可只导入其他几个再试——脚本支持多音源共存、按导入顺序回退。

---

## 六、常见问题

### 启用替换后 BGM 不响 / 音乐替换失效？

- 请确认脚本是最新版并刷新页面
- 若用在线音乐，请确认本地服务已启动、状态栏不是"本地服务未连接"
- 若用本地音乐，先点一下歌曲让它成为当前BGM（列表里会显示 ▶）

### 视频卡顿 / 声音断断续续？

- 已改用 **AudioWorklet**，音频处理不再占用主线程
- 实时分离很吃 CPU，建议 i5 及以上；笔记本请插电
- 如果仍卡，可把 `video-bgm-swap.user.js` 顶部的 `CHUNK_SIZE` 调大（如 `16384`），牺牲一点延迟换流畅

### 在线搜索没结果 / 获取播放失败？

- 确认 `bgm-separate-server.py` 运行、看到"HTTP 代理已启动"
- **Chrome 私有网络访问（PNA）**：公开HTTPS页面访问 `127.0.0.1` 需要预检头 `Access-Control-Allow-Private-Network`，`bgm-separate-server.py` 已加上；若仍被拦截请更新脚本/服务文件后重启
- 音源API可能失效，换一个音源文件试试
- 单曲全部失败会在列表显示 ❌

### 保留人声时状态一直显示"仅BGM兜底"？

- 有几种可能：
  1. **服务没启动**：确认 `python bgm-separate-server.py` 在运行、终端无报错；端口检查 `netstat -ano | findstr 8765`
  2. **默认仅代理模式**：没有加 `--ai` 参数启动（默认就是仅代理）。想保留人声需运行 `python bgm-separate-server.py --ai`
  3. **装了 --ai 但没装 demucs**：会降级为仅代理，先 `pip install -r requirements.txt` 再重启
- 面板会显示橙色提示"AI人声分离未连接，人声音量不可用"（且人声滑块置灰）——此时人声音量滑块无效果是正常的

### 运行 py 文件报 "Unable to connect to COM5: port not found"？

- 这是 **Thonny / 串口调试器 / IDE 的 MicroPython 模式** 在尝试连接串口设备，**与我们的脚本无关**（脚本只用网络端口 8765/8766，不碰串口）
- 请在 **命令提示符(cmd) 或 PowerShell** 中运行，不要用 Thonny 的串口模式：

  ```bash
  cd /d C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\video-bgm-swap
  python bgm-separate-server.py
  ```
- 若用 Thonny：菜单 运行 → 选择解释器 → 选"本地 Python 3"，不要选 MicroPython(串口)
- 看到 `HTTP 代理已启动: http://127.0.0.1:8766` 即成功

### 本地服务报 API 错误 / 模型加载失败？

- 服务器使用标准 demucs API（`demucs.pretrained.get_model` + `demucs.apply.apply_model`），一般与 demucs 版本无关
- 如果报 demucs 相关错误，请确认版本：`pip show demucs`，需要 **>= 4.1.0**
- 如果模型下载失败（网络问题），可手动下载 htdemucs 模型放入 demucs 缓存目录，或重试运行

### 不想装 demucs / torch（太占空间）？

- **默认就是不用装**：直接运行 `bgm-separate-server.py`（或双击 `start.bat`）即为**仅代理模式**：
  - ✅ 在线搜索 / 音频直链代理（8766）可用
  - ✅ BGM 替换、仅BGM兜底可用（替换/取消替换无杂音无静音）
  - ❌ AI 人声分离不可用（人声滑块置灰，面板有橙色提示）
- 之后再想体验人声分离，随时 `pip install -r requirements.txt`，然后 `python bgm-separate-server.py --ai` 重启即可，无需改任何配置

---

## 七、已知限制（MVP）

- 刷新页面后需要**重新添加本地音乐**（音源已自动持久化，无需重导）
- 切换BGM时会从指定位置重新开始播放（后续可加交叉淡入淡出）
- 在线音源依赖第三方API，稳定性无法保证
- 实时分离模式对 CPU 要求较高（未启用替换时如需调音量也会占用分离算力）

## ⚠️ 版权提醒

本项目仅供个人学习与技术交流。请只使用**你拥有版权或已获授权**的音乐作为音源，不要传播替换后的视频。

---

## 📄 许可证

[MIT License](LICENSE)

```
MIT License

Copyright (c) 2026 video-bgm-swap contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 🤝 贡献指南

- 欢迎提交 Issue / PR：修复 bug、改进音源兼容、优化实时分离性能
- 开发约定：
  - 油猴脚本 `video-bgm-swap.user.js`：单文件、`@grant none`、无构建步骤，改完用 `node --check` 验证语法
  - 本地服务 `bgm-separate-server.py`：尽量只依赖标准库，AI 相关保持可选导入（`try/except` 降级）
  - 保持 Chrome 私有网络访问（PNA）预检头，避免 CORS 拦截
