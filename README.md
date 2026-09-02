# 다담장 Backend

FO, Partner, BO에서 사용하는 커머스 도메인을 제공하는 NestJS GraphQL API입니다.

## 주요 기능

- 이메일·카카오 로그인, 본인확인, 계정 복구와 비활성화
- 카테고리, 상품, 옵션·SKU, 가격 정보와 개인화 피드
- 상품·브랜드 위시, 최근 본 상품, 장바구니와 주문
- 스타일 게시물 작성·조회·좋아요와 이미지 업로드
- 알림함, 알림 설정과 푸시 디바이스 등록
- 파트너 상품 등록·심사·게시와 재고 관리
- 관리자용 파트너·상품 심사, 주문·카테고리·초대·감사 로그 관리

## 설계 포인트

- Checkout은 idempotency key와 PostgreSQL transaction으로 중복 주문 생성을 막습니다.
- 가격 요약 snapshot을 분리해 상품 목록에서 필요한 가격 정보만 조회합니다.
- 메일과 푸시 전송은 outbox에 기록한 뒤 worker가 재시도합니다.
- 업로드 파일은 비공개 R2 영역에서 형식과 크기를 검증한 뒤 공개 키로 승격합니다.
- Access token과 refresh token을 분리하고 일회용 인증 흐름을 서버에서 검증합니다.

## 기술

- NestJS 11, Apollo GraphQL
- PostgreSQL, Drizzle ORM
- AWS SDK, Cloudflare R2
- Sentry, 구조화 로그
- Jest, Supertest

## 로컬 실행

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm migrate
pnpm start:dev
```

API는 기본적으로 `http://localhost:5500/graphql`에서 실행됩니다. 외부 인증, 메일, 이미지 저장소를 사용하는 기능은 `.env.example`의 해당 값을 별도로 설정해야 합니다.

## 검증

```bash
pnpm lint
pnpm build
pnpm db:test:up
pnpm test
pnpm db:test:down
```

## 구현 범위

Checkout은 주문 생성 흐름을 검증하기 위한 mock 구현입니다. 실제 결제 승인, 재고 예약과 차감은 포함하지 않습니다.
