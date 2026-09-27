@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Assignment Board - Wi-Fi

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [안내] Node.js 가 설치되어 있지 않습니다.
  echo  열리는 페이지에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행하세요.
  echo.
  start "" "https://nodejs.org/ko/download"
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo.
  echo  처음 실행 준비 중입니다. 1~2분 정도 걸립니다...
  echo.
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [오류] 준비에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행하세요.
    pause
    exit /b 1
  )
)

node scripts\launch.js
echo.
echo  서버가 종료되었습니다.
pause
