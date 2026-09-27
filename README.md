# 실시간 과제 제출 보드

학생이 휴대폰·PC로 과제를 올리면 교사 대시보드에 **실시간으로** 나타나는 강의용 웹사이트입니다.
외부 DB(Supabase 등) 없이 **서버 한 대만 켜면** 동작하며, 파일은 서버 디스크(`data/`)에 임시 저장됩니다.

## 주요 기능

| 구분 | 기능 |
| --- | --- |
| 입장 | QR 코드 촬영 또는 6자리 입장 코드 입력 → 이름 등록 |
| 학생 | 파일 선택/드래그/카메라 촬영·녹음 → **미리보기로 확인** → **최종 업로드**, 제출 파일 보기·다운로드·삭제, 이름 변경 |
| 이탈 방지 | 뒤로가기 시 확인창, 새로고침·탭 닫기 시 브라우저 경고창, 같은 기기로 다시 들어오면 자동 복귀 |
| 교사 대시보드 | PC방 관리 프로그램처럼 **좌석 박스**로 접속·제출 상태 표시 (정원 1~50명에 맞춰 레이아웃 자동 조절), 검색·필터(접속중/제출/미제출), 새 제출 알림 |
| 크게 보기 | 학생 박스 클릭 → 제출 파일 전체 목록 + 큰 미리보기 + 개별 다운로드, ←/→ 키로 다음 학생 |
| 다운로드 | 과목 전체를 **학생별 폴더로 정리된 ZIP** 한 번에 (`과목명/01_홍길동/…` + `제출현황.csv`), 학생 1명 ZIP |
| 관리 | 홈페이지 이름·과목명 변경, **과목 여러 개** 관리, 정원 변경, 제출 마감, 입장 코드 재발급, 과목 초기화/삭제, 교사 비밀번호 변경 |
| 모바일 | 학생·교사 화면 모두 휴대폰 화면 지원 |

### 미리보기 지원 형식

| 형식 | 방식 |
| --- | --- |
| 이미지 jpg, png, gif, webp | 브라우저 기본 표시 |
| 영상 mp4, mov, webm | `<video>` 재생 |
| 음향 wav, mp3, m4a, ogg | `<audio>` 재생 |
| PDF | [pdf.js](https://mozilla.github.io/pdf.js/)로 페이지 렌더링 (모바일 포함) |
| DOCX | [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)로 페이지 렌더링 |
| XLSX / CSV | 시트별 표로 표시 (JSZip으로 직접 해석) |
| PPTX | 표지 썸네일 + 슬라이드별 텍스트·이미지 요약 |
| HWPX | 문서 내장 첫 페이지 미리보기 이미지(`Preview/PrvImage.png`) + 본문 텍스트 + 삽입 이미지 |
| HWP, DOC, PPT, XLS (구형 바이너리) | 서버에 **LibreOffice**가 있으면 PDF로 변환해 표시, 없으면 다운로드 안내 |

> 서버에 LibreOffice가 설치돼 있으면 DOCX/PPTX/XLSX/HWPX도 "원본 레이아웃(PDF)으로 보기" 버튼으로 정확한 모양을 볼 수 있습니다.
> 서버는 시작할 때 실제 변환이 되는지 스스로 시험해 보고, 안 되면 이 기능을 자동으로 끕니다.

## 교사 PC에서 실행하기 (더블클릭)

별도 서버 비용 없이 교사 PC를 서버로 사용합니다.

### 처음 한 번만 준비

1. [Node.js](https://nodejs.org/ko/download) **LTS 버전**을 설치합니다. (설치 안 돼 있으면 실행 파일이 설치 페이지를 열어 줍니다)
2. GitHub 저장소에서 **Code → Download ZIP**으로 내려받아 원하는 폴더에 압축을 풉니다.

### 수업할 때

| 상황 | Windows | Mac |
| --- | --- | --- |
| 학생이 **교사 PC와 같은 Wi-Fi**에 접속 | `start-classroom.bat` 더블클릭 | `start-classroom.command` 더블클릭 |
| 학생이 **LTE/다른 네트워크**로 접속, 또는 학교 Wi-Fi가 기기 간 통신을 막음 | `start-online.bat` 더블클릭 | `start-online.command` 더블클릭 |

- 처음 실행할 때 필요한 프로그램을 자동으로 설치합니다(1~2분, 인터넷 필요).
- 준비가 끝나면 교사 대시보드가 브라우저에 자동으로 열립니다. **📱 입장 안내 (QR)** 를 프로젝터에 띄우면 됩니다.
- **검은 창을 닫으면 서버가 꺼집니다.** 수업 중에는 창을 열어 두고, PC 절전 모드를 꺼 두세요.
- 제출된 파일은 이 폴더의 `data/`에 저장되어 다음 실행 때도 남아 있습니다.

### 외부 접속 모드(`start-online`)는 어떻게 동작하나요?

[Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)(무료, 가입 불필요)로 `https://○○○.trycloudflare.com` 주소를 만들어 교사 PC에 연결합니다.
실행 파일이 [cloudflared](https://developers.cloudflare.com/tunnel/downloads/)를 처음 한 번 자동으로 내려받아 `bin/`에 저장하고, 생성된 주소를 **QR 코드에 자동 반영**합니다.

- 주소는 **실행할 때마다 바뀝니다.** 수업마다 QR을 새로 띄워 주세요.
- Cloudflare는 이 무료 터널을 테스트·개발 용도로 안내하며, 가동 시간 보장이 없고 동시 요청이 200개로 제한됩니다. 한 학급(50명 이하) 수업에는 대체로 충분하지만, 중요한 평가에는 같은 Wi-Fi 모드나 유료 서버를 권장합니다.
- 학교·기관 방화벽이 Cloudflare 접속을 막으면 주소가 만들어지지 않습니다. 이때도 같은 Wi-Fi 모드로는 계속 쓸 수 있습니다.

> Mac에서 "확인되지 않은 개발자" 경고가 뜨면 파일을 **우클릭 → 열기**로 실행하세요.
> 실행 권한 오류가 나면 터미널에서 `chmod +x start-*.command` 를 한 번 실행하세요.

## 터미널에서 실행 (개발자용)

```bash
npm install
npm start            # 서버만 실행
npm run classroom    # 같은 Wi-Fi 모드 (브라우저 자동 열기)
npm run online       # 외부 접속 모드 (Cloudflare 터널)
```

- 교사 대시보드: `http://localhost:3000/master` (기본 비밀번호 `admin1234` → 로그인 후 바로 변경하세요)
- 대시보드를 `localhost`로 열어도 QR 코드에는 자동으로 내부 IP 주소(또는 터널 주소)가 들어갑니다.

### 외부 서버 배포 (Railway, Render, VPS 등)

일반적인 Node.js 앱으로 배포하면 됩니다. `npm start`로 실행되며 `PORT` 환경 변수를 따릅니다.
업로드 파일을 보존하려면 `DATA_DIR`을 영구 볼륨 경로로 지정하세요.
(Render 무료 플랜처럼 저장 공간이 유지되지 않는 곳에서는 서버가 잠들거나 재시작할 때 제출 파일이 사라집니다 — [Render 문서](https://render.com/docs/free))

### 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `MASTER_PASSWORD` | (없음) | 지정하면 교사 비밀번호를 항상 이 값으로 사용 |
| `PUBLIC_URL` | (없음) | QR 코드에 넣을 주소 (예: `https://class.example.com`) |
| `DATA_DIR` | `./data` | 상태 파일·업로드 파일 저장 위치 |
| `MAX_FILE_MB` | `300` | 파일 1개 최대 용량(MB) |
| `SOFFICE_PATH` | 자동 탐색 | LibreOffice `soffice` 실행 파일 경로 |
| `CLOUDFLARED_PATH` | 자동 탐색/다운로드 | `cloudflared` 실행 파일 경로 (외부 접속 모드) |

## 데이터 보관

- `data/state.json`: 과목·학생·파일 목록 / `data/uploads/`: 업로드 파일
- 수업이 끝나면 **전체 ZIP**으로 백업한 뒤 설정 → **과목 초기화**로 서버의 파일을 지우세요.
- 교사 로그인은 서버 메모리에 보관되므로 서버를 재시작하면 다시 로그인해야 합니다. (학생 입장 정보는 유지)

## 알아둘 점

- 뒤로가기 경고는 브라우저 정책상 "1차 방지"입니다. 새로고침/탭 닫기 경고창의 문구는 브라우저가 정한 기본 문구로 표시되며, 사용자가 페이지와 한 번도 상호작용하지 않았다면 표시되지 않을 수 있습니다 ([MDN: beforeunload](https://developer.mozilla.org/docs/Web/API/Window/beforeunload_event)).
- 파일 보기 링크에는 접근 토큰이 포함됩니다. 교실 내 사용을 전제로 한 간단한 인증이므로 민감한 자료에는 사용하지 마세요.

## 개발

```bash
npm run dev   # 파일 변경 시 자동 재시작
npm test      # API 통합 테스트 (입장·업로드·권한·ZIP·마감·초기화)
```

구성: Express 5 · Socket.IO 4 · Multer 2 · Archiver 7 · qrcode / 브라우저: pdf.js 4(legacy build) · docx-preview · JSZip
