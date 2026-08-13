# dadamjang be

다담장 커머스 플랫폼의 NestJS GraphQL API입니다.

## 도메인

- Auth: 이메일 회원가입/로그인, 카카오 로그인/가입, access/refresh token
- Catalog: category, product, sku
- Feed: 개인화 상품 피드
- Wish: 위시템 저장/삭제
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

## Checkout 정합성 계약

- `checkoutCart(input)`은 `idempotencyKey`를 필수로 받습니다.
- `checkoutIdempotencyKeys`는 `userId + idempotencyKey` unique constraint로 중복 checkout을 막습니다.
- 같은 key로 재요청하면 저장된 `orderId`의 기존 주문을 반환합니다.
- 주문 생성, order item 생성, SKU 재고 차감, cart 비우기는 하나의 PostgreSQL transaction에서 처리합니다.
- SKU 재고 차감은 조건부 update로 수행해 stock이 0 미만이 되지 않게 합니다.
- 재사용된 checkout 요청은 `CHECKOUT_IDEMPOTENCY_REUSED` activity event로 기록합니다.

측정 기준:

- 중복 checkout 요청 수
- idempotency 재사용 처리 수
- 재고 차감 실패율
- oversell 재현 수
- checkout mutation p95
- 주문 생성 후 장바구니 cache 불일치 수

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

- FO 이메일 로그인은 `signinFo(email, password)`를 사용합니다. Partner/BO와 구버전용 `signin(userid, password, portal)`은 유지합니다.
- access token은 `Authorization: Bearer <accessToken>` 또는 cookie를 지원합니다.
- refresh token은 native 앱을 위해 `Authorization: Bearer <refreshToken>`도 지원합니다.
- Kakao callback deep link에는 token 대신 10분 만료 일회용 `flowId`만 포함합니다.
- 가입 본인확인 proof는 purpose와 device에 귀속되며 10분 만료·1회 소비됩니다.
- KG이니시스 결과는 허용된 결과 URL에서 서버 간 조회한 뒤 CI와 생년월일을 복호화합니다. CI는 `IDENTITY_CI_PEPPER`로 HMAC 처리하고 원문 개인정보는 저장하지 않습니다.
- `IDENTITY_VERIFICATION_MOCK_ENABLED=true`는 production 외 로컬 환경에서만 사용할 수 있습니다.
- 승인된 약관 원문은 `consentDocuments`에 별도로 등록합니다. migration에는 임시 약관 문안을 넣지 않습니다.

## 환경 변수

주요 값은 `.env.example`을 기준으로 설정합니다.

- `JWT_ACCESS_TOKEN_SECRET`
- `JWT_REFRESH_TOKEN_SECRET`
- `EMAIL_CODE_PEPPER`
- `KAKAO_CLIENT_ID`
- `KAKAO_CALLBACK_URL`
- `DADAMJANG_FO_AUTH_REDIRECT_URL`
- `DADAMJANG_FO_IDENTITY_REDIRECT_URL`
- `API_PUBLIC_BASE_URL`
- `IDENTITY_CI_PEPPER`
- `IDENTITY_INICIS_MID`
- `IDENTITY_INICIS_API_KEY`
- `IDENTITY_INICIS_SEED_IV`
- `IDENTITY_INICIS_CALLBACK_BASE_URL`
- `IDENTITY_VERIFICATION_MOCK_ENABLED`
- `RESEND_API_KEY`
- `CLOUDFLARE_R2_*`
- `SENTRY_DSN`
- `DATADOG_*`

비밀값은 Git에 커밋하지 않습니다.
