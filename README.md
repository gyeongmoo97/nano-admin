# admin-pwa

판매자용 모바일 PWA. 신규 클레임을 휴대폰 푸시 알림으로 받고, 1탭 승인.

## 배포 (GitHub Pages, 무료, 신용카드 X)

1. GitHub에 신규 repo 생성 (예: `nano-admin`) — **Public 필수**
   (GitHub 무료 플랜은 Public repo만 Pages 사용 가능)
2. `admin-pwa/` 안의 모든 파일을 repo 루트에 푸시
3. GitHub repo Settings > Pages > Source: `main` / `/(root)`
4. 1~2분 뒤 `https://<username>.github.io/nano-admin/` 발급
5. 휴대폰에서 그 URL 접속 → 첫 화면에서 "Bearer 토큰"과 Deno Deploy API URL 입력
6. 화면 하단의 "공유 → 홈 화면에 추가"로 PWA 설치 (iOS Safari / Android Chrome 모두 지원)
7. PWA 안에서 "알림 켜기" 한 번 누름 → 푸시 권한 허용 → 끝

## 자동 로그인 (쿼리파라미터)

매번 토큰 타이핑 안 하려면 URL에 박아서 한 번 열면 됨:

```
https://<username>.github.io/nano-admin/?token=<ADMIN_BEARER_TOKEN>&api=https://<your-app>.deno.net
```

한 번 열면 즉시 localStorage에 저장 + URL의 쿼리파라미터는 자동 삭제 (히스토리에 토큰 잔존 방지).
이후엔 그냥 `https://<username>.github.io/nano-admin/` 만 열어도 로그인된 상태로 시작.

## HTTPS 필수

Service Worker와 Web Push API는 HTTPS에서만 동작.
GitHub Pages는 자동으로 HTTPS 제공하므로 별도 설정 불필요.

## 아이콘 교체

`icon-192.png`, `icon-512.png`는 1x1 placeholder. 본인 로고 PNG로 교체 권장
(앱 아이콘으로 노출되는 부분).

## 보안 모델

Public repo여도 안전한 이유:
- 소스 코드에 비밀 0개 (API URL은 어차피 네트워크 요청에서 공개됨)
- `ADMIN_BEARER_TOKEN`은 Deno Deploy 환경변수에만 존재
- 사용자가 PWA에 토큰을 **수동 입력**해야 로그인 가능
- 서버가 모든 어드민 API 요청의 Bearer 토큰을 검증

운영 주의사항:
- 본인 휴대폰 PWA에 입력한 토큰은 브라우저 localStorage에 저장됨
  → 휴대폰 분실/도난 시 즉시 Deno Deploy 대시보드에서 `ADMIN_BEARER_TOKEN` 재발급
- 공용/타인 휴대폰에서는 절대 로그인 금지 (localStorage가 남음)
- 토큰 유출 의심 시 Deno Deploy 환경변수 값을 새로 만들어 교체하면 기존 토큰 즉시 무효화
