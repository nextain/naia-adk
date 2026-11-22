# Matrix 대화 인스턴스 설정

대시보드 서버의 `NAIA_INSTANCE_CONFIG`에 JSON 설정 파일 경로를 지정한다. 형식은 `config/instance.example.json`을 참고한다. `features.messenger.enabled`가 `true`이고 `backend`가 `matrix`일 때 Matrix 대화 메뉴가 나타난다. 설정이 없거나 꺼져 있으면 메뉴와 경로가 닫힌다. 설정을 읽지 못하면 오류를 표시한다.

`accounts` 키는 로그인 게이트가 확인한 계정 키다. `matrixUserId`는 그 계정에 허용된 정확한 Matrix 사용자 ID이며, `roles`는 설정의 역할 이름 목록이다. 역할에 `read`, `write`, `manage`를 각각 명시한다. 권한은 합집합이고 알 수 없는 계정·역할은 거부한다. 관리 권한은 관리 경로를 보호하며, 관리 기능 자체는 아직 연결되지 않았다. Matrix 서버의 방 가입·권한 검사도 별도로 적용된다.

로그인 게이트의 공유 비밀과 신뢰 출처는 기존 대화와 같은 `NAIA_GATE_SECRET_FILE`, `NAIA_IDENTITY_TRUSTED_PROXIES`를 사용한다. 게이트는 브라우저가 보낸 계정 머리글을 지우고 인증한 계정으로 덮어써야 한다. 대시보드는 매 요청에 게이트 확인과 권한을 검사하며, Matrix 비밀번호는 로그인 요청에만 사용하고 연결 정보는 서버 메모리에 둔다. 서버가 다시 시작되면 Matrix에 다시 로그인한다. 다른 브라우저에서 같은 게이트 계정을 사용하면 같은 서버 내 연결을 공유한다.

Matrix 선택과 되돌리기는 승인된 인스턴스 설정 변경으로 기록한다. Matrix 오류나 거절은 화면에 표시한다. 기존 `/messages` REST/SSE 경로는 별도로 유지하고 자동 대체하지 않는다. Matrix 기능을 끄려면 `enabled`를 `false`로 바꾼다. 기존 대화의 사용 여부는 별도 `NAIA_MESSENGER_ENABLED` 설정으로 제어한다.

Node.js 22.13.0 이상에서 패키지 빌드를 먼저 완료해야 서버가 `@naia-adk/ax-messenger`를 읽을 수 있다. 배포 시 대시보드 커스텀 서버, workspace 패키지와 Matrix SDK 의존성이 런타임에 함께 존재해야 한다. 대시보드 빌드는 메신저 패키지를 먼저 컴파일하고 `.next/standalone`에 커스텀 서버와 런타임 의존성, 정적 파일을 모은다. standalone의 `packages/dashboard/server.js`는 빌드 설정을 읽고 표준 `PORT`·`HOSTNAME`을 사용한다. 이 값은 `NAIA_DASHBOARD_PORT`·`NAIA_DASHBOARD_HOST`로, 두 환경 설정은 실행 인자 `-p`·`-H`로 각각 재정의할 수 있다. 별도 관리 작업과 파일·멘션·답글 화면, 계정 발급·조직 매핑은 추가 연결이 필요하다.
