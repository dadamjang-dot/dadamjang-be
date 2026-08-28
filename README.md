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

## Catalog pagination·성능 계약

- 한 catalog 응답의 candidate, `totalCount`, page SKU/brand hydration은 read-only `REPEATABLE READ` transaction의 같은 snapshot을 사용합니다.
- 날짜 정렬은 `(status, createdAt DESC, productId DESC)` 또는 category 포함 복합 index로 cursor seek합니다.
- `LOW_PRICE`, `HIGH_PRICE`, `POPULAR`은 활성 SKU 집계를 filtered product마다 계산한 뒤 정렬하므로 현재 상한은 O(filtered catalog)입니다. page size 최대 50은 이 집계 대상 수를 제한하지 않습니다.
- 저장된 snapshot이 없으므로 서로 다른 page 요청 사이에 가격·재고가 바뀌면 metric keyset은 best-effort입니다. 호출자는 `productId`로 중복 제거해야 합니다.
- catalog 지원 규모와 latency alert 임계치는 아직 측정값이 없어 정의하지 않았습니다. 운영 기준을 정하기 전에 filtered candidate 수, metric-sort p95, temporary-file sort 발생을 측정해야 합니다.

## Database migration 계약

- runner는 한 전용 PostgreSQL session에서 advisory lock을 최대 30초 기다리고 migration 실행을 직렬화합니다.
- 각 migration은 같은 transaction에서 DDL과 journal을 기록하며 lock 대기는 5초, statement 실행은 5분으로 제한합니다.
- 이미 journal에 기록될 수 있는 migration SQL은 checksum 계약 때문에 수정하지 않습니다. `0015_catalog_keyset_indexes.sql`은 이 원자성을 유지하는 일반 index build이며 timeout으로 무기한 대기를 막습니다.
- `CREATE INDEX CONCURRENTLY`는 transaction 밖 DDL과 journal 사이의 crash 복구 및 invalid index 재실행 protocol이 마련되기 전에는 runner에서 지원하지 않습니다.

## Media trust boundary와 R2 운영 계약

- 업로드 mutation은 5분 만료 presigned `PUT`과 `pending/products/...` 또는 `pending/style-posts/...` 키만 발급합니다. 서명에는 `Content-Type`과 `Content-Length`가 포함되고, pending 객체에는 소유자·선언 MIME·선언 크기 metadata가 기록되어야 합니다.
- 첨부 시 서버는 먼저 전체 첨부 묶음의 소유자 경로, 허용 확장자, `HeadObject` MIME/크기/ETag와 `Range: bytes=0-63`·`If-Match` 기반 JPEG/PNG/WebP/HEIC/HEIF magic bytes를 검사합니다. 전부 유효할 때만 pending 객체를 조건부 `CopyObject`로 승격하며 DB에는 final 키만 저장합니다. final 객체 ID는 검증된 source key와 ETag의 SHA-256으로 결정되고 서버 promotion metadata를 확인하므로, 동일 객체 버전의 재시도·동시 요청은 하나의 immutable final 키로 수렴합니다.
- 배포 전부터 존재한 final 키는 선언 metadata가 없어도 호환됩니다. 단, 소유자 경로와 MIME·크기·ETag·magic-byte 검사는 동일하게 통과해야 합니다. 선언 metadata는 presigned 경계를 증명하는 pending 객체에만 필수입니다.
- 애플리케이션의 delivery URL helper는 pending 키를 거부합니다. 다만 R2 public bucket 설정은 애플리케이션이 강제하거나 조회할 수 없으므로 다음 항목은 **배포 필수 전제**입니다.
  - production bucket의 `r2.dev` public development URL을 비활성화합니다. 그렇지 않으면 custom-domain WAF를 우회할 수 있습니다.
  - R2 custom domain에서 URI path가 `/pending/`으로 시작하는 모든 `GET`/`HEAD`를 WAF custom rule로 차단하고 캐시하지 않습니다. 배포 검증에서 pending 원본 URL과 Images 변환 URL이 모두 전달되지 않는지 확인합니다.
  - object lifecycle rule을 prefix `pending/`, expiration 1일로 설정합니다. 만료 시점 이후 실제 삭제는 통상 최대 24시간 더 걸릴 수 있으며, 더 긴 bucket-lock rule을 `pending/`에 적용하면 안 됩니다.
  - browser upload CORS는 production 앱 origin만 허용하고 method는 `PUT`, 요청 header는 최소 `Content-Type`만 허용합니다. presigner가 metadata를 query parameter로 서명하므로 임의 `x-amz-meta-*` header 허용은 필요하지 않습니다.

이 저장소는 외부 R2 bucket을 소유하는 Terraform resource를 만들지 않습니다. 운영자는 Cloudflare의 [public bucket access](https://developers.cloudflare.com/r2/buckets/public-buckets/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/), [object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) 설정을 별도 배포 게이트로 확인해야 합니다. `CopyObject`, `x-amz-copy-source-if-match`, ranged `GetObject` 지원 여부는 [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) 계약을 기준으로 합니다.

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
- `RESEND_FROM_EMAIL`
- `CLOUDFLARE_R2_*`
- `SENTRY_DSN`
- `DATADOG_*`

비밀값은 Git에 커밋하지 않습니다.
