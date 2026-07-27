# Influencer Frame Web

설치 없이 도메인으로 사용하는 Influencer Frame 웹 앱 소스입니다.

## 서비스 구조

- 사용자는 자신의 Higgsfield 계정으로 로그인합니다.
- 이미지 생성은 사용자 Higgsfield 크레딧을 사용합니다.
- GPT 기획 JSON은 회사 OpenAI API 계정의 `gpt-5.6-terra`를 사용합니다.
- OpenAI API 키는 소스나 GitHub에 저장하지 않습니다.
- 인플루언서 모드와 호리존 제품 이미지 모드를 한 화면에서 전환합니다.

## OpenAI API 키

소스를 GitHub에 먼저 올린 뒤 배포 서비스의 비밀 환경값에 다음 항목을 추가합니다.

```text
OPENAI_API_KEY=발급받은_API_키
```

키가 없어도 사이트 배포와 Higgsfield 로그인은 가능하지만, `GPT JSON 만들기`는 키를
입력한 뒤 작동합니다. 키를 `.env`, 코드, GitHub 파일에 직접 적지 마세요.

## GitHub

저장소에는 이 폴더의 내용 전체를 업로드합니다. `main` 브랜치에 변경사항이 들어오면
검증 작업이 자동 실행됩니다. 실제 서비스 배포 연결은 Higgsfield App 호스팅에서
진행하며, 사용자별 로그인과 생성 크레딧은 해당 호스팅 환경에서 제공됩니다.

## 로컬 확인

`app` 폴더에서 Bun을 사용합니다.

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

## 포함된 자료

`app/public/references`에는 성별·장소·연출별 폴더 레퍼런스가 포함됩니다.
`app/src/data/reference-catalog.json`은 해당 폴더 구조에서 자동 생성됩니다.

레퍼런스를 다시 가져올 때:

```bash
node app/scripts/import-influencer-references.mjs "레퍼런스_폴더_전체_경로"
```
