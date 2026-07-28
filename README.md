# Influencer Frame Web

Windows 사내 Node 서버에서 HTTPS 서브도메인으로 제공하는 Influencer Frame 웹 앱 소스입니다.

## 서비스 구조

- 사용자는 브라우저별로 자신의 Higgsfield 계정을 OAuth로 연결합니다.
- 이미지 생성은 사용자 Higgsfield 크레딧을 사용합니다.
- GPT 기획 JSON은 회사 OpenAI API 계정의 `gpt-5.6-terra`를 사용합니다.
- OpenAI API 키는 소스나 GitHub에 저장하지 않습니다.
- 인플루언서 모드와 호리존 제품 이미지 모드를 한 화면에서 전환합니다.
- 런타임은 Vercel이나 Cloudflare Worker가 아니라 Node.js입니다.

## 서버 비밀 환경

`app/.env.example`을 항목 목록으로만 참고하고, 실제 값은 df-deploy가 관리하는 서버 비밀
환경변수로 주입합니다. `.env` 파일, 브라우저 코드, Git 또는 로그에 실제 값을 저장하지 않습니다.

```text
HDEX_PUBLIC_ORIGIN=https://실제_사내_서브도메인
HDEX_HIGGSFIELD_OAUTH_COOKIE_SECRET=32바이트_base64url_값
HDEX_HIGGSFIELD_MCP_URL=https://mcp.higgsfield.ai/mcp
OPENAI_API_KEY=회사_OpenAI_API_키
HOST=127.0.0.1
PORT=3000
HDEX_TEMP_DIR=C:\\HDEX\\temp
HDEX_TEMP_TTL_SECONDS=86400
HDEX_GENERATION_ENABLED=false
```

`HDEX_PUBLIC_ORIGIN`은 경로가 없는 고정 HTTPS origin이어야 하며 OAuth callback은
`${HDEX_PUBLIC_ORIGIN}/api/higgsfield/oauth/callback`으로 등록됩니다. 쿠키 비밀은 다음처럼
만들 수 있습니다.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## Windows / df-deploy 실행

요구 버전은 Node.js 22.12 이상입니다. df-deploy는 `main`을 받은 뒤 작업 디렉터리를
`app`으로 두고 다음 명령을 사용합니다.

```powershell
bun install --frozen-lockfile
bun run build
bun run start:df-deploy
```

프로세스 재시작 검증은 다음 명령과 endpoint를 사용합니다.

```powershell
bun run healthcheck
```

- Health endpoint: `/api/health`
- Start script: `bun run start:df-deploy`
- 산출물: `app/.output/server/index.mjs`, `app/.output/public`

Node는 기본적으로 `127.0.0.1`에만 바인딩합니다. 방화벽/VPN과 사내 리버스 프록시가 외부
HTTPS를 종료하고 Node의 `PORT`로 전달하며, 인터넷에서 Node 포트에 직접 접근하지 못하게
구성합니다. 별도 직원 계정 시스템은 두지 않고 Higgsfield OAuth 세션을 앱의 유일한 인증
경계로 사용합니다. 프록시는 원래 host/protocol 정보를 보존해야 하며, 외부에서 접근하는
origin과 `HDEX_PUBLIC_ORIGIN`이 정확히 같아야 합니다.

`HDEX_TEMP_DIR`은 Windows 절대 경로여야 합니다. 앱은 그 아래
`hdex-influencer-frame` 폴더만 소유하며 업로드·결과·작업 메타데이터를 TTL 이후 정리합니다.
`HDEX_GENERATION_ENABLED`는 기본 `false`입니다. OAuth/status/capability/model 확인은 가능하지만
`true`로 명시하기 전에는 `generate_image`가 provider에 전달되지 않습니다.

## 배포 흐름

df-deploy가 저장소 `main`을 받아 위 install/build/start 명령으로 갱신합니다. 이 저장소는
Vercel 또는 Higgsfield App 호스팅 배포 설정을 사용하지 않습니다. 사용자별 인증과 생성은
공용 CLI 계정이 아니라 해당 브라우저의 봉인된 OAuth 쿠키와 Higgsfield MCP를 사용합니다.

## 로컬 확인

`app` 폴더에서 실행합니다.

```bash
bun install
bun run dev
```

품질 검사:

```bash
bun run typecheck
bun run test
bun run build
```

테스트는 외부 OAuth/MCP와 유료 생성 요청을 mock 처리합니다. 운영 계정과 실제 회사 이미지를
검증 과정에서 외부로 전송하지 않습니다.

## 포함된 자료

`app/public/references`에는 성별·장소·연출별 폴더 레퍼런스가 포함됩니다.
`app/src/data/reference-catalog.json`은 해당 폴더 구조에서 자동 생성됩니다.

레퍼런스를 다시 가져올 때:

```bash
node app/scripts/import-influencer-references.mjs "레퍼런스_폴더_전체_경로"
```
