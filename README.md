# 우리 일기 (couple-diary)

장거리 커플용 공유 일기 PoC. 의존성 0개 — Node.js만 있으면 돌아갑니다.

채팅이 아니라 **교환일기**입니다:

- **하루 1인 1페이지** — 짧은 메시지 스트림이 아니라, 하루를 정리한 한 편의 글. 같은 날 다시 저장하면 그 페이지가 수정됩니다.
- **둘 다 써야 공개** — 그날 페이지는 두 사람 모두 쓴 뒤에야 서로에게 열립니다. 내가 안 쓴 날의 상대 글은 🔒 잠금으로만 보입니다(서버가 내용 자체를 안 내려줌).
- **즉답 없음** — 읽음 표시·답장·타이핑 표시가 없습니다. 일기에 대한 대화는 전화에서.

기능: 갤럭시·아이폰 브라우저에서 "홈 화면에 추가"로 앱처럼 사용(PWA), 둘만 아는 **커플 코드** 입장(사진 URL도 코드 필요), 사진 자동 압축, 기분 이모지, 작성자 **현지 시간** 병기, 30초 자동 동기화.

## 실행

```bash
COUPLE_CODE=둘만아는코드 PORT=3000 node server.js
```

데이터는 `./data/entries.json`(글)과 `./data/photos/`(사진 파일)에 저장됩니다.
백업은 `data/` 디렉터리만 복사하면 끝.

## 테스트

브라우저 동작을 실제 Chrome으로 검증합니다. 의존성은 없습니다.

```bash
# 1. 디버그 포트를 연 Chrome
chrome --headless=new --remote-debugging-port=9222 about:blank &

# 2. 서버
COUPLE_CODE=loveu PORT=3000 node server.js &

# 3. 테스트
node test/run.js
```

`CDP_URL`, `APP_URL` 환경변수로 주소를 바꿀 수 있습니다.

## 둘이 실제로 쓰려면 (배포)

인터넷에서 접근 가능한 곳에 올려야 합니다. 무료로 가능한 순서대로:

1. **Fly.io** (무료 티어, 디스크 볼륨 지원) — `fly launch` 후 `fly volumes create data`로
   `/app/data`에 볼륨 마운트, `COUPLE_CODE`는 `fly secrets set`으로.
2. **집/사무실 PC + Tailscale Funnel** — `tailscale funnel 3000` 한 줄로 HTTPS 외부 노출.
3. Render / Railway 등 Node 지원 PaaS (무료 티어는 디스크가 휘발성인 곳이 많으니 주의).

HTTPS가 있어야 아이폰에서 홈 화면 추가·카메라 접근이 매끄럽습니다.

## PoC 한계 (다음 단계 후보)

- 인증이 공유 코드 1개뿐 → 계정 분리 없음 (잠금 규칙도 이름 기반이라 신뢰 전제)
- 푸시 알림 없음 (상대가 페이지를 쓰면 알림 받기)
- 저장이 JSON 파일 → 규모 커지면 SQLite로
- 오늘의 질문 프롬프트, 캘린더/회고 뷰 없음
