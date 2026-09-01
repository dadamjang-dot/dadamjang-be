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
- `productPriceSummary(productId)`: 상품 상세용 경량 가격 요약입니다.

가격 변경 처리 시 전체 상품 목록 invalidate 대신 `productId + priceRevision` 기준 가격 요약 key만 갱신하는 것을 기본 전략으로 둡니다.

`productPriceEvidenceSnapshots`는 게시 상품의 최신 snapshot 한 건만 유지하며 기간별 가격 이력은 저장하지 않습니다. 모든 가격 요약은 저장된 snapshot을 필수로 사용하며, snapshot이 없으면 unavailable을 반환하고 현재 SKU로 revision을 합성하지 않습니다.

실제 비교가 원천이 생기기 전까지 공개 가격 요약의 `basePrice`와 `finalPrice`는 모두 활성 옵션 최저가입니다. 활성 SKU가 없는 게시 상품은 catalog 목록과 `totalCount`에서 제외되며 상세 가격 조회는 unavailable로 처리합니다.

최신 가격 snapshot은 게시 상품의 가격 관련 SKU row write마다 해당 상품의 활성 SKU를 다시 집계합니다. SKU 100개 상한에서는 허용하는 비용이며 statement-level 집계나 비동기 갱신으로 확장하지 않은 현재 write-scalability 상한입니다.

## Catalog pagination·성능 계약

- 한 catalog 응답의 candidate, `totalCount`, page SKU/brand hydration과 가격 요약 snapshot은 read-only `REPEATABLE READ` transaction의 같은 snapshot을 사용합니다.
- 날짜 정렬은 `(status, createdAt DESC, productId DESC)` 또는 category 포함 복합 index로 cursor seek합니다.
- `LOW_PRICE`, `HIGH_PRICE`, `POPULAR`은 활성 SKU 집계를 filtered product마다 계산한 뒤 정렬하므로 현재 상한은 O(filtered catalog)입니다. page size 최대 50은 이 집계 대상 수를 제한하지 않습니다.
- pagination 정렬 metric snapshot은 저장하지 않으므로 서로 다른 page 요청 사이에 가격·재고가 바뀌면 metric keyset은 best-effort입니다. 호출자는 `productId`로 중복 제거해야 합니다.
- catalog 지원 규모와 latency alert 임계치는 아직 측정값이 없어 정의하지 않았습니다. 운영 기준을 정하기 전에 filtered candidate 수, metric-sort p95, temporary-file sort 발생을 측정해야 합니다.

## Database migration 계약

- runner는 한 전용 PostgreSQL session에서 advisory lock을 최대 30초 기다리고 migration 실행을 직렬화합니다.
- 각 migration은 같은 transaction에서 DDL과 journal을 기록하며 lock 대기는 5초, statement 실행은 5분으로 제한합니다.
- 이미 journal에 기록될 수 있는 migration SQL은 checksum 계약 때문에 수정하지 않습니다. `0015_catalog_keyset_indexes.sql`은 이 원자성을 유지하는 일반 index build이며 timeout으로 무기한 대기를 막습니다.
- `CREATE INDEX CONCURRENTLY`는 transaction 밖 DDL과 journal 사이의 crash 복구 및 invalid index 재실행 protocol이 마련되기 전에는 runner에서 지원하지 않습니다.

## Media trust boundary와 R2 운영 계약

- `CLOUDFLARE_R2_PENDING_BUCKET`은 public final bucket과 다른 전용 private bucket이어야 합니다. 업로드 mutation은 이 bucket에 대한 5분 만료 presigned `PUT`과 pending 키만 반환하며 public pending URL은 반환하거나 계산하지 않습니다. 서명은 `Content-Type`과 `Content-Length`를 포함하고 소유자·선언 MIME·선언 크기 metadata를 고정합니다.
- 시작 시 pending/final bucket이 같거나 `CLOUDFLARE_R2_PENDING_PUBLIC_BASE_URL`이 설정되거나 final delivery origin이 `r2.dev`이면 실패합니다. 새 업로드는 JPEG/PNG/WebP만 허용합니다. 기존 HEIC/HEIF final 키의 delivery URL 호환성은 유지하지만 새 업로드·재첨부에는 사용하지 않습니다.
- 첨부 시 서버는 먼저 전체 묶음의 경로와 `HeadObject` MIME·크기·ETag를 검증하고, `If-Match`가 적용된 전체 객체를 최대 10MB까지만 스트리밍합니다. JPEG/PNG/WebP 컨테이너 완결성, 실제 `sharp` decode, 단일 page, 각 축 8192px, 총 2천만 pixel 상한을 전부 통과한 뒤에만 승격합니다.
- pending bucket에서 final bucket으로 보내는 `CopyObject`는 leading-slash `CopySource`와 source ETag 조건을 사용합니다. final 키는 source key와 ETag의 SHA-256이므로 재시도와 동시 승격은 같은 immutable 키로 수렴합니다. 배포 전 final 객체는 전체 decode 후 ledger에 채택되어 기존 UUID 키를 유지합니다.
- `mediaObjectPromotions`와 `mediaObjectReferences`가 copy-before-DB-commit 간극을 추적합니다. 도메인 참조는 상품·스타일 글 transaction 안에서 기록되고, `SKIP LOCKED` 기반 GC는 24시간 동안 참조되지 않은 final 객체만 claim한 뒤 삭제합니다. 삭제 후 DB 기록 실패와 stale multi-instance claim도 동일 ledger에서 재시도합니다.
- Cloudflare 설정은 애플리케이션이 조회해 증명할 수 없으므로 다음 항목은 **배포 필수 전제**입니다.
  - pending bucket의 `r2.dev`, custom domain, 기타 public access를 모두 비활성화하고 final bucket과 pending bucket 모두에 접근할 수 있는 최소 권한 credential을 배포합니다.
  - pending bucket CORS는 production 앱 origin, `PUT`, 필요한 `Content-Type`만 허용하고 prefix `pending/`에 expiration 1일 lifecycle을 설정합니다.
  - final bucket의 `r2.dev` development URL을 비활성화합니다. 과거 final bucket에 남은 `pending/` 객체가 모두 만료·삭제될 때까지 custom domain에서 `/pending/`의 `GET`/`HEAD`와 Images 변환을 WAF로 차단하고 캐시하지 않습니다.
  - `0018_media_object_ledger.sql`을 먼저 적용하고 모든 구버전 writer가 종료된 뒤 `MEDIA_GC_WORKER_ENABLED=true`인 새 버전을 활성화합니다. rolling 중 구버전 writer가 ledger 없이 새 참조를 만들게 해서는 안 됩니다.

이 저장소는 외부 R2 bucket을 소유하는 Terraform resource를 만들지 않습니다. 운영자는 Cloudflare의 [public bucket access](https://developers.cloudflare.com/r2/buckets/public-buckets/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/), [object lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) 설정을 별도 배포 게이트로 확인해야 합니다. `HeadObject`, conditional `GetObject`, `CopyObject` 지원 여부는 [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) 계약을 기준으로 합니다.

## 외부 메일 outbox 계약

- 가입 코드, 비밀번호 재설정 코드·링크, 관리자 초대는 모두 `emailDeliveryOutbox`를 사용합니다. 요청/관리자 transaction은 암호화된 payload와 proof를 원자적으로 기록할 뿐 Resend를 기다리지 않습니다.
- PostgreSQL `SKIP LOCKED` claim, stale-claim 복구, 동일 outbox ID 기반 provider idempotency key로 multi-instance 재시도합니다. 전송 성공 여부가 모호하면 proof를 삭제하지 않으며 다음 claim이 같은 payload와 key를 사용합니다.
- 복구 요청은 등록 여부와 관계없이 같은 admission·outbox 경로와 generic 응답을 사용합니다. 사용자 조회와 미등록 주소 suppress는 응답이 끝난 뒤 worker에서 수행합니다.
- 운영에서는 `EMAIL_OUTBOX_WORKER_ENABLED=true`를 명시합니다. `0017_email_delivery_outbox.sql`과 새 writer를 함께 배포하고, outbox를 처리할 인스턴스가 최소 하나 이상 실행 중인지 모니터링해야 합니다.
- `SENT`, `SUPPRESSED`, 최종 `FAILED` 전환 시 수신자, 요청 IP hash, 암호화 payload, proof, 오류 문자열을 즉시 비가역적으로 지웁니다. Worker는 purge와 claim 전에 구버전 writer가 남긴 terminal 민감 필드를 원래 `updatedAt`을 유지한 채 인덱스 기반 `SKIP LOCKED` 배치(최대 100개)로 반복 scrub하고 0이 아닌 처리 건수를 기록합니다. 상태·시도 횟수·시각은 관측을 위해 7일간 보존한 뒤 같은 worker가 최대 100개씩 삭제하며 삭제 건수를 기록합니다. `PENDING`과 현재 `PROCESSING` claim은 scrub과 보존 삭제에서 제외됩니다.

## ALB client IP 계약

- `TRUST_PROXY=false`가 direct/local 기본값입니다. staging·production에서만 app task로의 직접 ingress를 차단하고 ALB security group만 허용한 뒤 `TRUST_PROXY=true`를 사용합니다.
- backend는 socket 바로 앞의 한 hop만 신뢰합니다. ALB attribute `routing.http.xff_header_processing.mode`는 `append`여야 하며 `preserve` 또는 `remove`를 사용하면 안 됩니다. `routing.http.xff_client_port.enabled`는 `false`로 유지합니다. 이 계약에서 ALB가 붙인 가장 오른쪽 client hop만 admission identity가 되고 그 왼쪽의 forged/rotating XFF 값은 무시됩니다.

## Checkout 정합성 계약

- `checkoutCart(input)`은 `idempotencyKey`를 필수로 받습니다.
- `checkoutIdempotencyKeys`는 `userId + idempotencyKey` unique constraint로 중복 checkout을 막습니다.
- 같은 key로 재요청하면 저장된 `orderId`의 기존 주문을 반환합니다.
- 주문 생성, order item 생성, cart 비우기, idempotency 완료는 하나의 PostgreSQL transaction에서 처리합니다.
- checkout은 현재 SKU 재고를 비예약 availability snapshot으로 확인할 뿐 재고를 예약하거나 차감하지 않습니다. 주문은 `PAYMENT_PENDING`으로 생성되고 SKU stock은 그대로 유지됩니다.
- 재사용된 checkout 요청은 `CHECKOUT_IDEMPOTENCY_REUSED` activity event로 기록합니다.

측정 기준:

- 중복 checkout 요청 수
- idempotency 재사용 처리 수
- checkout 시점 재고 부족 거부 수
- `PAYMENT_PENDING` 주문 생성 수
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

## RDS CA 체크섬 교체

Docker 빌드는 `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`만 내려받고 고정 SHA-256을 검증합니다. AWS가 번들을 교체하면 빌드가 의도적으로 실패합니다.

공식 URL에서 다시 내려받은 뒤 별도의 신뢰 가능한 환경에서 두 방식의 SHA-256 결과와 인증서 파싱을 확인합니다. 결과가 모두 일치할 때만 Dockerfile과 자동화 계약의 체크섬을 함께 갱신합니다.

```bash
curl --fail --location https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem --output /tmp/aws-rds-global-bundle.pem
sha256sum /tmp/aws-rds-global-bundle.pem
openssl dgst -sha256 /tmp/aws-rds-global-bundle.pem
openssl crl2pkcs7 -nocrl -certfile /tmp/aws-rds-global-bundle.pem | openssl pkcs7 -print_certs -noout
echo "<new-sha256>  /tmp/aws-rds-global-bundle.pem" | sha256sum -c -
docker build --no-cache --tag dadamjang-backend-ca-check .
```

## 인증 계약

- FO 이메일 로그인은 `signinFo(email, password)`를 사용합니다. Partner/BO와 구버전용 `signin(userid, password, portal)`은 유지합니다.
- access token은 `Authorization: Bearer <accessToken>` 또는 cookie를 지원합니다.
- refresh token은 native 앱을 위해 `Authorization: Bearer <refreshToken>`도 지원합니다.
- Kakao callback deep link에는 10분 만료 `flowId`와 opaque 일회용 `callbackToken`이 포함됩니다. `callbackToken`은 hash만 저장되며 시작 device에 귀속되어 한 번만 소비됩니다.
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
