#!/bin/bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo " [안내] Node.js 가 설치되어 있지 않습니다."
  echo " 열리는 페이지에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행하세요."
  open "https://nodejs.org/ko/download"
  read -r -p " 엔터를 누르면 창이 닫힙니다..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ""
  echo " 처음 실행 준비 중입니다. 1~2분 정도 걸립니다..."
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo " [오류] 준비에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행하세요."
    read -r -p " 엔터를 누르면 창이 닫힙니다..."
    exit 1
  fi
fi

node scripts/launch.js --tunnel
