@echo off
rem 视频BGM替换器 - 本地服务一键启动 (Windows)
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   视频BGM替换器 - 本地服务启动器
echo ============================================
echo.
echo   [默认] 仅代理模式（零依赖，稳定轻量）
echo   [AI]   人声分离模式（需 demucs，加 --ai 参数）
echo.

rem ========== 方式1：免安装版 exe（无需 Python） ==========
if exist "%~dp0dist\bgm-separate-server\bgm-separate-server.exe" (
    echo [模式] 免安装版 exe，无需 Python。
    echo.
    echo 正在启动服务，请保持此窗口开启...
    echo 按 Ctrl+C 可停止服务。
    echo.
    "%~dp0dist\bgm-separate-server\bgm-separate-server.exe"
    pause
    exit /b 0
)
if exist "%~dp0bgm-separate-server.exe" (
    echo [模式] 免安装版 exe，无需 Python。
    echo.
    echo 正在启动服务，请保持此窗口开启...
    echo 按 Ctrl+C 可停止服务。
    echo.
    "%~dp0bgm-separate-server.exe"
    pause
    exit /b 0
)

rem ========== 方式2：Python 运行 ==========
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 python，请先安装 Python 3.8+ 并勾选 "Add to PATH"
    echo 下载地址: https://www.python.org/downloads/
    start "" "https://www.python.org/downloads/"
    pause
    exit /b 1
)

set "AI_ARG="
python -c "import demucs, torch, websockets, numpy" >nul 2>nul
if errorlevel 1 (
    echo [提示] 未检测到 AI 依赖（demucs），将以"仅代理"模式启动。
    echo        在线搜索 / BGM替换可用；如需人声分离请先安装:
    echo        pip install demucs torch websockets numpy
    echo.
) else (
    set /p AI_CHOICE=检测到 AI 依赖，是否启用 AI 人声分离？ ^(y/n，默认 n^): 
    if /i "%AI_CHOICE%"=="y" set "AI_ARG=--ai"
)

echo.
echo 正在启动服务，请保持此窗口开启...
echo 按 Ctrl+C 可停止服务。
echo.
python bgm-separate-server.py %AI_ARG%
pause