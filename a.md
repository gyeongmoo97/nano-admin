
## 배포 (GitHub Pages, 무료, 신용카드 X)

1. GitHub에 신규 repo 생성 (예: `nano-admin`)
2. `admin-pwa/` 안의 모든 파일을 repo 루트에 푸시
3. GitHub repo Settings > Pages > Source: `main` / `/(root)`
4. 1~2분 뒤 `https://<username>.github.io/nano-admin/` 발급
5. 휴대폰에서 그 URL 접속 → 첫 화면에서 "Bearer 토큰"과 Deno Deploy API URL 입력
6. 화면 하단의 "공유 → 홈 화면에 추가"로 PWA 설치 (iOS Safari / Android Chrome 모두 지원)
7. PWA 안에서 "알림 켜기" 한 번 누름 → 푸시 권한 허용 → 끝

