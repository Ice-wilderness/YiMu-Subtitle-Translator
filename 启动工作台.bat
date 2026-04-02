@echo off
:: 用 cmd /k 重新执行自身，确保窗口永不自动关闭
if not "%KEEP_OPEN%"=="1" (
    set KEEP_OPEN=1
    cmd /k "%~f0"
    exit /b
)
chcp 65001 >nul
title SRT Subtitle Workbench

pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot enter script directory.
    pause
    exit /b 1
)

echo.
echo  ================================================
echo    SRT Subtitle Workbench - Launcher
echo  ================================================
echo.

:: Step 1: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found. Install Python 3.8+ and add to PATH.
    echo  Download: https://www.python.org/downloads/
    popd & pause & exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo  [OK] Python %PYVER%

:: Step 2: Create virtualenv if needed
if not exist ".venv\Scripts\activate.bat" (
    echo  [1/4] Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo  [ERROR] Failed to create virtual environment.
        popd & pause & exit /b 1
    )
    echo  [OK] Virtual environment created.
)
if exist ".venv\Scripts\activate.bat" echo  [OK] Virtual environment ready.
call .venv\Scripts\activate.bat

:: Step 3: Install / update dependencies
echo  [2/4] Installing dependencies...
pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 (
    echo  [ERROR] Dependency installation failed.
    popd & pause & exit /b 1
)

:: Verify faster-whisper
python -c "import faster_whisper" >nul 2>&1
if errorlevel 1 (
    echo  [WARN] faster-whisper not found, retrying...
    pip install faster-whisper
    python -c "import faster_whisper" >nul 2>&1
    if errorlevel 1 (
        echo  [ERROR] faster-whisper install failed. Try: pip install faster-whisper
        popd & pause & exit /b 1
    )
)
echo  [OK] All dependencies ready.

:: Step 4: Check environment
echo  [3/4] Checking environment...

ffmpeg -version >nul 2>&1
if errorlevel 1 echo  [WARN] ffmpeg not found. Video transcription will not work.
if not errorlevel 1 echo  [OK] ffmpeg found.

:: 搜索 faster-whisper-xxl CLI（PATH > 本地tools/ > AppData VideoCaptioner）
set "CLI_PATH="
for /f "usebackq tokens=*" %%p in (`where faster-whisper-xxl.exe 2^>nul`) do if not defined CLI_PATH set "CLI_PATH=%%p"
if not defined CLI_PATH (
    if exist "tools\faster-whisper-xxl\faster-whisper-xxl.exe" set "CLI_PATH=%~dp0tools\faster-whisper-xxl\faster-whisper-xxl.exe"
)
if not defined CLI_PATH (
    powershell -NoProfile -Command "$r=@($env:APPDATA,$env:LOCALAPPDATA)|%%{Join-Path $_ 'VideoCaptioner\resource\bin\Faster-Whisper-XXL\faster-whisper-xxl.exe'}|Where-Object{Test-Path $_}|Select-Object -First 1;if($r){$r}" > "%TEMP%\_fwxxl.tmp" 2>nul
    for /f "usebackq tokens=*" %%p in ("%TEMP%\_fwxxl.tmp") do if not defined CLI_PATH set "CLI_PATH=%%p"
    del "%TEMP%\_fwxxl.tmp" 2>nul
)
if defined CLI_PATH (
    echo  [OK] faster-whisper-xxl found: %CLI_PATH%
    powershell -NoProfile -Command "$f='config.json';$p='%CLI_PATH:\=\\%';$c=if(Test-Path $f){Get-Content $f -Raw|ConvertFrom-Json}else{[pscustomobject]@{}};if(-not $c.whisper_cli_exe -or $c.whisper_cli_exe -eq ''){Add-Member -InputObject $c -Force -NotePropertyName whisper_cli_exe -NotePropertyValue $p;$c|ConvertTo-Json -Depth 5|Set-Content $f -Encoding UTF8;Write-Host '  [OK] CLI path saved to config.json'}" 2>nul
) else (
    echo  [INFO] faster-whisper-xxl CLI not found. Click "Install CLI" in the app to download it.
)

set GPU_FOUND=0
nvidia-smi >nul 2>&1
if not errorlevel 1 set GPU_FOUND=1
if "%GPU_FOUND%"=="0" echo  [INFO] No NVIDIA GPU detected. Will use CPU.
if "%GPU_FOUND%"=="1" echo  [OK] NVIDIA GPU detected.

:: Kill any process on port 9999
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 9999 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Write-Host ' [INFO] Killing old process on port 9999 (PID' $_ ')'; Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

:: Step 5: Start server
echo  [4/4] Starting server...
echo.
echo  ================================================
echo    URL: http://localhost:9999
echo    Log: logs\app.log
echo    Close this window to stop the server.
echo  ================================================
echo.

start "" "http://localhost:9999"

python app.py
set EXIT_CODE=%errorlevel%

popd

echo.
if %EXIT_CODE% neq 0 (
    echo  [ERROR] Server exited with code %EXIT_CODE%. Check logs\app.log for details.
) else (
    echo  [INFO] Server stopped normally.
)
echo  === 窗口保持打开，输入 exit 可关闭 ===


