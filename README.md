# admin-pwa

판매자용 모바일 PWA. 신규 클레임을 휴대폰 푸시 알림으로 받고, 1탭 승인.

## 배포 (GitHub Pages, 무료, 신용카드 X)

1. GitHub에 신규 repo 생성 (예: `nano-admin`)
2. `admin-pwa/` 안의 모든 파일을 repo 루트에 푸시
3. GitHub repo Settings > Pages > Source: `main` / `/(root)`
4. 1~2분 뒤 `https://<username>.github.io/nano-admin/` 발급
5. 휴대폰에서 그 URL 접속 → 첫 화면에서 "Bearer 토큰"과 Deno Deploy API URL 입력
6. 화면 하단의 "공유 → 홈 화면에 추가"로 PWA 설치 (iOS Safari / Android Chrome 모두 지원)
7. PWA 안에서 "알림 켜기" 한 번 누름 → 푸시 권한 허용 → 끝

## HTTPS 필수

Service Worker와 Web Push API는 HTTPS에서만 동작.
GitHub Pages는 자동으로 HTTPS 제공하므로 별도 설정 불필요.

## 아이콘 교체

`icon-192.png`, `icon-512.png`는 1x1 placeholder. 본인 로고 PNG로 교체 권장
(앱 아이콘으로 노출되는 부분).

## 보안

- `app.js`는 localStorage에 Bearer 토큰을 저장 (XSS 노출 위험 → repo는 가능하면 private)
- `Bearer` 토큰이 유출되면 즉시 Deno Deploy 대시보드에서 `ADMIN_BEARER_TOKEN` 재발급
