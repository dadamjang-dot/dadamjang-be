# Backend API 정리 설계

## 목표

프론트엔드 호출 여부만으로 Backend API를 삭제하지 않는다. 대응 UI가 없더라도 포트폴리오의 의도된 도메인 기능이면 유지하고, 현재 UI가 이미 다른 흐름으로 대체했거나 기존 API와 중복되는 공개 계약만 제거한다.

## 판정 결과

다음 API는 UI 부재가 삭제 근거가 아니므로 유지한다.

- `comparison`, `comparisonPriceSummaries`, `addComparisonItem`, `removeComparisonItem`
- `applyPartner`
- `myActivity`
- `updateMarketingConsent`

다음 API는 현재 사용자 흐름과 중복되므로 제거한다.

- `requestPasswordReset`: FO와 BO의 비밀번호 복구 UI가 인증코드 발급·검증 후 `resetPassword`를 호출한다. 별도 링크 발송 흐름은 대체됐다.
- `productImageUrl`: 상품과 이미지 UI는 상품 응답의 `imageUrls`를 사용하고, 업로드 중 미리보기는 로컬 파일을 사용한다. 공개 Query 없이 내부 URL 생성 함수만 유지한다.
- `unregisterFoPushDevice`: 알림 중지는 `updateFoNotificationPreferences`, 로그아웃 시 디바이스 해제는 `logout` 내부에서 처리한다. 별도 공개 Mutation은 중복이다.

대응 UI가 존재하면서 API 연결만 빠진 후보는 없으므로 새 프론트엔드 기능이나 화면은 추가하지 않는다.

## Backend 변경

### 비밀번호 링크 복구 제거

- `requestPasswordReset` Resolver, 입력 타입과 서비스 진입점을 제거한다.
- `PASSWORD_RESET_LINK` outbox 분기와 링크 발송 코드를 제거한다.
- 비밀번호 재설정 검증은 `emailVerificationToken`의 `PASSWORD_RESET` proof만 사용한다.
- `passwordResetToken` Drizzle schema와 계정 익명화 정리 코드를 제거한다.
- 신규 migration에서 기존 `PASSWORD_RESET_LINK` outbox 행을 삭제하고 kind constraint를 갱신한 뒤 `passwordResetToken` 테이블을 삭제한다.

### 중복 공개 API 제거

- `productImageUrl` Resolver와 GraphQL args 타입을 제거한다. `MediaService.getProductImageUrl`은 Catalog와 Partner가 사용하므로 유지한다.
- `unregisterFoPushDevice` Resolver와 전용 서비스 메서드를 제거한다. 로그아웃이 사용하는 `NotificationRepository.disableInstallation`은 유지한다.

## Frontend 변경

- BO GraphQL proxy의 public operation 목록에서 더 이상 존재하지 않는 `requestPasswordReset`을 제거한다.
- 기존 비밀번호 인증코드, 이미지 표시·업로드, 알림 설정·로그아웃 흐름은 변경하지 않는다.

## 호환성과 오류 처리

- 제거된 GraphQL field 호출은 GraphQL validation error가 된다.
- migration 적용 후 발급된 기존 링크 토큰은 사용할 수 없으며 대기 중인 링크 메일은 발송되지 않는다.
- 인증코드 기반 비밀번호 복구 proof와 기존 세션 폐기 동작은 유지한다.
- OAuth·본인인증 callback, health check, activity 기반 개인화, outbox worker는 범위 밖이며 유지한다.

## 검증

- GraphQL schema에 제거 대상 3개가 없고 유지 대상 7개가 남아 있는지 확인한다.
- 비밀번호 인증코드 발급·검증·재설정과 세션 폐기 integration test를 유지한다.
- migration이 link outbox 데이터와 legacy token table을 제거하고 나머지 email kind를 보존하는지 검증한다.
- 이미지 URL 생성의 내부 호출과 Push 로그아웃 해제를 기존 테스트로 검증한다.
- Backend lint, build, unit, integration test와 BO lint, typecheck, unit test, build를 실행한다.

## 범위 제외

- 대응 UI가 없는 기능의 화면 구현
- GraphQL nested field 단위 축소
- 역사적 migration 수정
- `docs/superpowers` 또는 `.superpowers` 재생성
