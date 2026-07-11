# dadamjang be

다담장 커머스 플랫폼의 NestJS GraphQL API입니다.

## 도메인

- Auth: 이메일 회원가입/로그인, 카카오 로그인/가입, access/refresh token
- Catalog: category, product, sku
- Feed: 개인화 상품 피드
- Wishlist: 위시템 저장/삭제
- Cart: 장바구니 추가/삭제/조회
- Order: mock checkout, 주문 조회
- Partner: 사업자 이메일/사업자 등록번호 기반 파트너
- Admin: 초대 기반 BO 계정
- Media: Cloudflare R2/Images 기반 업로드 계약
- Event: growth/event logging

## 가격 근거 GraphQL 계약

- `productPriceSummaries(filter)`: 상품 목록/검색용 경량 가격 요약 connection입니다.
- `comparisonPriceSummaries`: 비교함용 경량 가격 요약 목록입니다.
- `productPriceEvidence(productId, priceRevision)`: 가격 이력, 쿠폰 조건, 배송 정책, offer 출처를 별도 조회하는 lazy query입니다.

목록/비교 query는 상세 가격 근거를 포함하지 않습니다. 가격 변경 처리 시 전체 상품 목록 invalidate 대신 `productId + priceRevision` 기준 evidence/offer key만 갱신하는 것을 기본 전략으로 둡니다.

## 기술

- NestJS
- GraphQL
- PostgreSQL
- Drizzle ORM
- Redis
- Sentry
- Datadog structured logging

## 로컬 실행

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm migrate
pnpm start:dev
```

로컬 의존성은 `docker-compose.yml`에서 PostgreSQL 중심으로 실행합니다.

## 검증

```bash
pnpm lint
pnpm build
pnpm test
```

## 인증 계약

- FO 로그인은 `portal: FO`를 사용합니다.
- access token은 `Authorization: Bearer <accessToken>` 또는 cookie를 지원합니다.
- refresh token은 native 앱을 위해 `Authorization: Bearer <refreshToken>`도 지원합니다.
- Kakao callback은 `DADAMJANG_FO_AUTH_REDIRECT_URL`이 있으면 앱 deep link로 redirect합니다.

## 환경 변수

주요 값은 `.env.example`을 기준으로 설정합니다.

- `JWT_ACCESS_TOKEN_SECRET`
- `JWT_REFRESH_TOKEN_SECRET`
- `EMAIL_CODE_PEPPER`
- `KAKAO_CLIENT_ID`
- `KAKAO_CALLBACK_URL`
- `DADAMJANG_FO_AUTH_REDIRECT_URL`
- `RESEND_API_KEY`
- `CLOUDFLARE_R2_*`
- `SENTRY_DSN`
- `DATADOG_*`

비밀값은 Git에 커밋하지 않습니다.
