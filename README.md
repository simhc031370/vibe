# vPDF

UPDF에서 영감을 받은 브라우저용 PDF 도구입니다. 읽기, 주석, 페이지 구성, 변환을 지원하며 모든 처리는 로컬에서 합니다.
A lightweight, browser-based PDF reader, annotator, organizer and converter inspired by UPDF. Everything runs locally.

- 분석 문서: [docs/updf-analysis.md](docs/updf-analysis.md)

## 기능

- **읽기**: 연속 스크롤 뷰어, 썸네일, 확대/축소/너비 맞춤, 페이지 이동, 텍스트 검색
- **주석**: 형광펜, 사각형, 펜, 텍스트, 메모(실제 PDF 주석), 도장, 흰색 지우개, 이미지, 주석 삭제, 실행 취소/다시 실행. 한글 입력도 지원합니다.
- **페이지 구성**: 드래그 정렬, 회전, 삭제, 빈 페이지 삽입
- **도구**: PDF 병합, 분할/추출/범위 삭제, 워터마크, 페이지 번호, PDF → PNG/JPG/TXT, 이미지 → PDF, 문서 속성, 최적화
- 한국어/English UI, 파일 드래그 앤 드롭, 단축키(Ctrl+O/S/Z/Y/F, Ctrl +/-)

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ (정적 호스팅 가능)
```

## 테스트

```bash
npm test           # 코어 로직 단위 테스트 (Vitest)
npm run typecheck
npm run test:e2e   # 실제 UI E2E (Playwright + 로컬 Chrome, CHROME_PATH로 경로 지정 가능)
```
