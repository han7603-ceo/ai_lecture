# 실시간 과제 제출 보드

학생이 휴대폰·PC로 과제를 올리면 교사 대시보드에 **실시간으로** 나타나는 강의용 웹사이트입니다.
외부 DB(Supabase 등) 없이 **서버 한 대만 켜면** 동작하며, 파일은 서버 디스크(`data/`)에 임시 저장됩니다.

## 주요 기능

| 구분 | 기능 |
| --- | --- |
| 입장 | QR 코드 촬영 또는 6자리 입장 코드 입력 → 이름 등록 |
| 학생 | 파일 선택/드래그/카메라 촬영·녹음 → **미리보기로 확인** → **최종 업로드**, **🔗 링크 제출**(구글 문서·유튜브·캔바 등 주소), 제출 파일 보기·다운로드·삭제, 이름 변경 |
| 이탈 방지 | 뒤로가기 시 확인창, 새로고침·탭 닫기 시 브라우저 경고창, 같은 기기로 다시 들어오면 자동 복귀 |
| 교사 대시보드 | PC방 관리 프로그램처럼 **좌석 박스**로 접속·제출 상태 표시 (정원 1~50명에 맞춰 레이아웃 자동 조절), 검색·필터(접속중/제출/미제출), 새 제출 알림. 박스 안에 **최신 파일부터 파일 목록**(또는 썸네일) 표시, 교사가 확인한 뒤 새로 올라온 파일에 **NEW** 표시, 정렬(자리 순서/최근 제출순/확인 필요 우선) |
| 크게 보기 | 학생 박스 클릭 → 제출 파일 전체 목록 + 큰 미리보기 + 개별 다운로드, ←/→ 키로 다음 학생. **듀얼 모니터**면 파일을 누를 때 다른 모니터의 창에 크게 표시 (모니터 1대면 같은 창) |
| 다운로드 | 과목 전체를 **학생별 폴더로 정리된 ZIP** 한 번에 (`과목명/01_홍길동/…` + `제출현황.csv`, 제출한 링크는 학생 폴더의 `링크.txt`), 학생 1명 ZIP |
| 수업 시작/종료 | **▶ 수업 시작**: 새 입장 코드 발급 + 입장·제출 열기 + QR 화면 자동 표시 (지난 코드는 무효, 이미 입장한 학생은 유지) / **⏹ 수업 종료**: 입장·제출 마감 |
| 자료 보내기 | **📤 자료 보내기**로 교사가 학생에게 **파일 또는 링크(URL)** 전달 — 전체 학생(나중 입장자 포함) 또는 선택한 학생, 안내 문구, 학생별 확인(열람) 여부, 회수. 학생 화면 **📥 선생님 자료**에 실시간 도착·NEW 표시·미리보기, 링크는 **열기 ↗**로 새 탭에서 열림 (수업 종료 후에도 열람 가능). **▶ 수업 시작**을 누르면 지난 수업 자료는 학생 화면에서 내려가고 교사 화면 '지난 수업 자료'에 보관(다시 보내기 가능) |
| 인증 메일 | 교사 메일함(IMAP 앱 비밀번호 또는 Apps Script)에서 지정한 메일(기본: OpenAI 인증 메일)만 골라 교사 대시보드 **📬 인증 메일**에 코드·링크 표시. **학생별 코드 확인 링크**: 계정 주소(예: `ad.bodacompany+s01@gmail.com`)를 등록하면 계정마다 개인 링크·QR(`/code/…`)이 생기고, 학생은 과목·입장과 상관없이 그 링크에서 자기 계정 코드만 확인. QR 카드 인쇄, 링크 다시 만들기. 60분 뒤 자동 삭제 |
| 참관(게스트) | 설정 → **👀 참관 링크**로 허락한 선생님에게 로그인 없는 **읽기 전용** 대시보드 링크 발급 (현재 과목/모든 과목, 2시간~30일). 좌석·제출 파일 보기·입장 안내(QR)는 가능, 삭제·수업 시작/종료·자료 보내기·ZIP·설정·인증 메일·학생 가입 메일은 불가. 만료·취소 시 즉시 차단 |
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

### 외부 서버 배포 (Railway 등)

일반적인 Node.js 앱으로 배포하면 됩니다. `PORT` 환경 변수를 따릅니다.
Railway 는 저장소의 `railway.json` 에 따라 `exec node server.js` 로 실행합니다 (`npm start` 를 거치면 재배포 때 종료 신호가 서버에 전달되지 않아 저장 없이 강제 종료되고 '배포 실패' 메일이 옵니다).

**Railway 권장 설정**
- GitHub 저장소를 연결해 서비스를 만들면 `main`에 push할 때마다 자동 배포됩니다.
- **Volume**을 `/data`에 연결하고 환경 변수 `DATA_DIR=/data`를 지정해야 재배포 후에도 제출 파일이 남습니다.
- 환경 변수 `RAILPACK_DEPLOY_APT_PACKAGES=libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-noto-cjk`를 지정하면 LibreOffice와 한글 글꼴이 함께 설치되어 PPTX·DOCX·XLSX를 **원본 레이아웃(PDF)**으로 미리볼 수 있습니다. ([Railpack 패키지 설치 안내](https://railpack.com/guides/installing-packages/))
- `MASTER_PASSWORD`를 반드시 지정하세요. (환경 변수로 지정한 비밀번호가 대시보드에서 바꾼 비밀번호보다 우선합니다. 비밀번호를 바꿀 때는 Railway **Variables**에서 바꾸세요.)
- **Settings → Networking → Generate Domain**으로 `*.up.railway.app` 주소를 만들면 그 주소가 곧 학생 접속 주소입니다.

저장 공간이 유지되지 않는 곳(예: Render 무료 플랜)에서는 서버가 잠들거나 재시작할 때 제출 파일이 사라집니다 — [Render 문서](https://render.com/docs/free).

### 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3000` | 서버 포트 |
| `MASTER_PASSWORD` | (없음) | 지정하면 교사 비밀번호를 항상 이 값으로 사용 |
| `PUBLIC_URL` | (없음) | QR 코드에 넣을 주소 (예: `https://class.example.com`) |
| `DATA_DIR` | `./data` | 상태 파일·업로드 파일 저장 위치 |
| `MAX_FILE_MB` | `300` | 파일 1개 최대 용량(MB) |
| `SOFFICE_PATH` | 자동 탐색 | LibreOffice `soffice` 실행 파일 경로 |
| `INBOX_IMAP_USER` | (없음) | 인증 메일 연결: 확인할 Gmail 주소 (예: `ad.bodacompany@gmail.com`) |
| `INBOX_IMAP_PASSWORD` | (없음) | 그 계정의 **Google 앱 비밀번호** 16자리 (2단계 인증 필요) |
| `INBOX_IMAP_QUERY` | `from:openai.com newer_than:1d` | 가져올 메일의 Gmail 검색어 |
| `CLOUDFLARED_PATH` | 자동 탐색/다운로드 | `cloudflared` 실행 파일 경로 (외부 접속 모드) |

## 데이터 보관

- `data/state.json`: 과목·학생·파일·자료 목록 / `data/uploads/`: 학생 제출 파일 / `data/materials/`: 교사가 보낸 자료
- 수업이 끝나면 **전체 ZIP**으로 백업한 뒤 설정 → **과목 초기화**로 서버의 파일을 지우세요.
- 교사 로그인은 서버 메모리에 보관되므로 서버를 재시작하면 다시 로그인해야 합니다. (학생 입장 정보는 유지)

## 알아둘 점

- **듀얼 모니터 표시**는 [Window Management API](https://developer.mozilla.org/docs/Web/API/Window_Management_API)를 씁니다. 크롬·엣지(100 이상)에서 `https` 주소(Railway 등) 또는 `localhost`로 열었을 때만 동작하며, 처음 한 번 브라우저가 **창 관리 권한**을 묻습니다(허용 필요). 사파리·파이어폭스, 모니터 1대, 같은 Wi-Fi 모드(`http://192.168…`)에서는 지금처럼 같은 창에 표시됩니다. 보기 창의 **⛶ 전체화면** 버튼으로 그 모니터를 꽉 채울 수 있고, 크게 보기의 **🖥️ 다른 모니터** 버튼으로 켜고 끌 수 있습니다.

- 뒤로가기 경고는 브라우저 정책상 "1차 방지"입니다. 새로고침/탭 닫기 경고창의 문구는 브라우저가 정한 기본 문구로 표시되며, 사용자가 페이지와 한 번도 상호작용하지 않았다면 표시되지 않을 수 있습니다 ([MDN: beforeunload](https://developer.mozilla.org/docs/Web/API/Window/beforeunload_event)).
- 학생이 제출한 링크는 교사 화면에서 **링크 열기**를 누르면 새 탭(듀얼 모니터면 다른 모니터의 새 창)으로 열립니다. 외부 사이트가 대시보드를 조작하지 못하도록 연결을 끊고 열기 때문에, 링크마다 새 창이 열리며 다 본 창은 직접 닫아야 합니다.
- **인증 메일 연결**은 두 가지 방법이 있습니다. ① (추천) Railway Variables 에 `INBOX_IMAP_USER`·`INBOX_IMAP_PASSWORD`(앱 비밀번호)를 넣으면 서버가 30초마다 메일함을 **읽기 전용**으로 검색해 조건에 맞는 메일만 가져옵니다(읽음 표시를 바꾸지 않음). 앱 비밀번호는 메일함 전체를 읽을 수 있는 열쇠이므로 Railway 변수에만 두고, 그만 쓸 때는 [Google 계정의 앱 비밀번호](https://support.google.com/accounts/answer/185833)에서 삭제하세요. ② 교사 Google 계정 안에서 도는 Apps Script 가 조건(`QUERY`)에 맞는 메일만 연결 키와 함께 `/api/inbox` 로 보내고, 서버는 메모리에만 60분 보관합니다. 설정 방법은 대시보드 📬 인증 메일 → 연결 설정에 있습니다. 학생별 코드 확인 링크는 교사만 만들고 다시 만들 수 있으며, 링크를 아는 사람은 그 계정의 코드를 볼 수 있으니 학생 본인에게만 전달하세요. Apps Script 시간 트리거는 최소 1분 간격이라 1~2분 지연될 수 있습니다 ([설치형 트리거](https://developers.google.com/apps-script/guides/triggers/installable)).
- 교사가 보내는 링크와 학생이 제출하는 링크 모두 `http://`·`https://` 주소만 허용합니다. 학생이 링크를 누르면 이 서버를 한 번 거쳐(확인 기록) 원래 주소로 이동합니다.
- 파일 보기 링크에는 접근 토큰이 포함됩니다. 교실 내 사용을 전제로 한 간단한 인증이므로 민감한 자료에는 사용하지 마세요.

## 개발

```bash
npm run dev   # 파일 변경 시 자동 재시작
npm test      # API 통합 테스트 (입장·업로드·권한·ZIP·마감·초기화)
```

구성: Express 5 · Socket.IO 4 · Multer 2 · Archiver 7 · qrcode / 브라우저: pdf.js 4(legacy build) · docx-preview · JSZip
