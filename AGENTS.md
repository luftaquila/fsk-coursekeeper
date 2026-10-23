# AGENTS.md

- 지도에서 코스를 설계하고 RTK GPS 로버가 콘 위치마다 표시하는 코스 배치 시스템. 단독 웹 콘솔과 FSK 서비스가 같은 콘솔 코드와 같은 장치를 사용
- 위치: 공유 패키지 `course`, 단독 콘솔 `console`, 로버 ROS 노드 `rover/pilot`, 로버 hub `rover/hub`, 로버 MCU 펌웨어 `rover/mcu`, GPS 유닛 `rover/gps`, 장치 설치 스크립트 `rover/host`·`rover/gps/host`·`rover/common`, 로버 보드 `rover/pcb`, 3D 모델 `rover/3d`, 릴리즈 패키징 `scripts`

## AGENTS.md 작성 규칙
- 간결한 개조식, 명사형 종결, 모호한 표현 금지
- 메모리 없는 에이전트가 이 문서와 repo만으로 이해할 수 있게 작성
  - 새 용어를 만들지 않고 문장만으로 뜻이 명확하도록 작성. 코드에 있는 대상은 코드 식별자로 지칭
- 코드에서 바로 읽히는 동작·형식은 미기재. 핵심 시스템 구조는 포함
- 근거·측정값·경위·날짜·커밋 해시 미기재. 결정이 바뀌면 해당 항목을 고쳐 쓰고 이전 결정은 남기지 않음
- 수치는 값 자체가 결정일 때만 기재(예: 운용 로버 1대). 코드 상수가 있으면 식별자로 지칭
- 기각한 대안은 재제안을 막아야 할 때만 금지 항목으로 기재
- 항목 하나에 결정 하나. 하위 항목은 조건·예외·예시만, 예시는 repo의 실제 사례로
- 새 항목은 해당 섹션에 추가. 다른 섹션이나 `README.md`와 중복 금지
- 기재 내용은 현재 코드와 일치. 충돌을 발견하면 어느 쪽이 맞는지 사용자 확인 후 수정
- 로컬 경로·개인 툴체인 위치 등 특정 환경 종속 내용 금지
- 비공개·임시 문서 참조 금지

## 시스템 구조
- 공유 패키지 `fsk-coursekeeper`(`course/`)를 단독 콘솔과 FSK 서비스가 함께 사용
  - FSK는 pnpm git 태그 의존성(`github:luftaquila/fsk-coursekeeper#<tag>&path:/course`)으로 가져감
  - 패키지 이름·export 경로 변경은 FSK 소비 코드와 함께 갱신
- 호스트별로 다른 것은 데이터 관리·공개·권한뿐. 나머지(UI, 코스 도메인, 서비스, 장치 클라이언트)는 공유
- 코스 서비스(`course/service`)
  - better-sqlite3 호환 동기 핸들 위에서 동작. 서버(better-sqlite3)와 브라우저 Worker(SQLite WASM)에서 같은 코드 실행
  - 사용자·권한·공개·전송 개념 없음. 결과의 `events`·`detail`로 호스트가 전파·감사
  - REST 표면은 `routes.mjs` 하나. 서버는 Express로 등록, 브라우저 호스트는 `router.mjs`로 프로세스 내 처리
- 콘솔(`course/console`)은 호스트를 주입받음(`host.mjs`): 코스 전송, 장치 레지스트리, 권한, 기능 플래그, 공개 코스 조회
  - 콘솔은 `course` 내부 모듈과 선언된 패키지만 import(`tests/course/console-boundary.test.mjs`)
- 단독 콘솔(`console/`)은 코스 서비스를 Worker 안 SQLite WASM(`opfs-sahpool`)으로 실행. 릴리즈 때 GitHub Pages 배포
  - 브라우저 DB 연결은 하나뿐이라 탭 하나만 사용(Web Locks). OPFS가 없으면 메모리로 동작하고 경고 표시
  - 장치 주소·VWorld 키는 브라우저 설정(localStorage). 변경 시 새로고침으로 연결 재구성
  - 공개 기능 없음. 코스 파일 내보내기·가져오기와 DB 백업·복원만
- 미션 프리셋은 코스 데이터(코스 서비스 소유). 로버에는 미션 실행 원장만
- 로버·GPS 유닛은 각자 tailnet에 API 제공. 브라우저가 장치에 직접 연결
  - 장치 인증은 tailnet 접근(Tailscale ACL)만
  - 장치는 ID별 목록으로 관리. 다중 로버를 위한 연결 구조만 두고 UI·운용은 로버 1대 기준
  - 장치 CORS 허용 Origin은 장치 설정 파일로 지정(`hub.conf`의 `HUB_ALLOWED_ORIGINS`, `gps.conf`의 `ALLOWED_ORIGINS`). 설치 스크립트는 파일이 없을 때만 기본값 작성
  - NGII 로그인은 콘솔에서 설정하고 각 장치가 저장(hub DB, GPS 유닛 `state.json`). hub는 NGII 소스와 함께 로버에 전달
- 로버 Pi는 ROS 노드(`rover/pilot`)와 hub(`rover/hub`)를 별도 컨테이너로 실행
  - hub 포트 2개, 모두 loopback: 장치 포트(`bridge_node` 연결)와 운영자 포트(`tailscale serve` 뒤). 한쪽 라우트는 다른 포트에 미노출
  - hub에는 코스 데이터 없음. 미션 생성 시 브라우저가 코스 식별자와 콘 좌표를 전달
- 로버 Pi는 GPIO 미사용. 구동·조향·펌프·LED·E-Stop·배터리 측정은 MCU(`rover/mcu`), Pi는 `mcu_bridge_node`의 USB CDC 명령으로만 제어
- GPS 유닛(`rover/gps`)은 자체 API와 base 모드 NTRIP caster 제공
  - 캡처 모드와 base 모드는 배타
  - 로버는 공용 DNS 고정이라 MagicDNS 미해석. caster는 GPS 유닛이 보고하는 tailnet IPv4(`caster.host`)로 지정
  - 측량점 고도는 타원체고(TMODE 입력), 콘 캡처 고도는 MSL

## 미션 안전
- 항법은 로버 단독 실행. 콘솔·hub 연결 끊김은 정지 사유 아님
- 구동 정지 경로는 E-Stop, MCU의 Pi heartbeat 단절, `mcu_bridge_node`의 구동 명령 단절(`drive_cmd_timeout_s`)
- 재부팅 후 checkpoint(`mission_checkpoint.py`)에서 복원한 미션은 일시정지 상태. 운영자 재개 전 이동 금지
- 펌프 작동 전 현재 waypoint를 `dispense_uncertain`으로 기록. 완료 신호 전에 중단되면 자동 재분사 금지, 운영자가 건너뛰거나 새 waypoint로 재시도
- checkpoint 손상 시 fault latch(`mission_checkpoint.fault.json`). 해당 미션의 서버 reset 또는 운영자 end 전까지 시작·재개 차단
- hub의 안전 hold는 navigator가 `hold_id`를 담아 보고할 때까지 재전송

## 배포
- 배포 단위는 릴리즈(`v*` 태그, `release.yml`)
  - 태그·릴리즈는 사용자 지시가 있을 때만 생성
  - 브랜치 push는 테스트·빌드만, 게시 없음. 수동 실행(`rover.yml`)만 hub·pilot 이미지를 `:edge-<sha>`로 게시
- 설치 스크립트는 `scripts/package-devices.sh`가 REPO·VERSION을 채워 생성. 두 장치 공용 호스트 파일은 `rover/common/files`
- 장치 자동 업데이트 금지
- 로버 이미지는 설치 시 `/etc/fsk-coursekeeper/{pilot,hub}-image`에 버전 고정
- 장치·콘솔은 빌드 때 받은 버전(태그, `edge-<sha>`, `dev`)을 보고하고 콘솔이 표시. 호환성 판단은 미션 프로토콜 버전
- 로버별 설정은 NGII 로그인, `hub.conf`, tailnet 노드, 보정 파일(`/var/lib/pilot`)뿐. `rover_params.yaml`은 이미지에 포함, 전 로버 동일

## 설계 원칙
- 최신 상태만 기준. 구 프로토콜·저장 형식 호환 코드 추가 금지
- 장치 프로토콜 변경 시 장치 코드와 콘솔을 함께 갱신

## 작업 원칙
- 코드 변경 시 관련 문서(`README.md`, `AGENTS.md`)와 주석이 낡지 않았는지 확인하고 함께 갱신

## 하드웨어
- E-Stop은 NC 접점과 내부 풀업. 버튼 누름과 단선 모두 정지
- 모터 전류 측정 없음

## 검증
- 호스트 테스트 통과는 주행·RTK·보드 동작 검증이 아님. 실측 없이 하드웨어 동작 주장 금지
- `test_mission_checkpoint`의 디렉터리 fsync 테스트는 Linux 전용
- 콘솔 E2E는 실제 hub·GPS 유닛 API에 시뮬레이션 장치(`tests/e2e/devices.mjs`)를 붙여 단독 콘솔 검증. CI 미포함
