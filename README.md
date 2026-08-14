# 우리 일기 (couple-diary)

장거리 커플용 공유 일기 PoC. 의존성 0개 — Node.js만 있으면 돌아갑니다.

- 갤럭시·아이폰 모두 브라우저로 접속 → "홈 화면에 추가"하면 앱처럼 사용
- 둘만 아는 **커플 코드**로 입장 (사진 URL도 코드 없이는 안 열림)
- 글 + 사진(브라우저에서 자동 압축) + 기분 이모지, 날짜별 타임라인
- 서로 다른 시간대면 작성자의 **현지 시간**을 함께 표시
- 30초마다 자동 동기화

## 실행

```bash
COUPLE_CODE=둘만아는코드 PORT=3000 node server.js
```

데이터는 `./data/entries.json`(글)과 `./data/photos/`(사진 파일)에 저장됩니다.
백업은 `data/` 디렉터리만 복사하면 끝.

## 둘이 실제로 쓰려면 (배포)

인터넷에서 접근 가능한 곳에 올려야 합니다. 무료로 가능한 순서대로:

1. **Fly.io** (무료 티어, 디스크 볼륨 지원) — `fly launch` 후 `fly volumes create data`로
   `/app/data`에 볼륨 마운트, `COUPLE_CODE`는 `fly secrets set`으로.
2. **집/사무실 PC + Tailscale Funnel** — `tailscale funnel 3000` 한 줄로 HTTPS 외부 노출.
3. Render / Railway 등 Node 지원 PaaS (무료 티어는 디스크가 휘발성인 곳이 많으니 주의).

HTTPS가 있어야 아이폰에서 홈 화면 추가·카메라 접근이 매끄럽습니다.

## PoC 한계 (다음 단계 후보)

- 인증이 공유 코드 1개뿐 → 계정 분리 없음
- 푸시 알림 없음 (상대가 새 글 쓰면 알림 받기)
- 저장이 JSON 파일 → 규모 커지면 SQLite로
- 댓글/답장, 읽음 표시 없음
