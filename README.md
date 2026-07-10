# dadamjang be

다담장 커머스 플랫폼의 GraphQL API와 도메인 규칙을 담당합니다.

## 도메인

- 상품·오퍼·최종 가격 계산
- 개인화 피드·Growth 실험·이벤트
- 장바구니·주문·배송 예정일·recovery action
- 파트너 상품 draft·품질 검증·발행

## 기술 방향

- NestJS modular monolith
- GraphQL query, mutation, subscription
- PostgreSQL transaction과 append-only 이벤트 로그

## 계약 원칙

GraphQL schema가 프론트엔드와의 단일 계약입니다. 가격 계산과 주문 상태 전이는 서버에서만 확정합니다.

## 관측

- Datadog: 구조화된 HTTP 로그와 AWS 인프라 관측
- Sentry: NestJS 예외와 성능 trace. `SENTRY_DSN`이 비어 있으면 전송하지 않습니다.
Dadamjang GraphQL API and commerce domain services
