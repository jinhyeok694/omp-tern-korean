import { describe, expect, test } from "bun:test";
import { createCatalog, parseCatalog } from "../omp/catalog.ts";

const catalog = createCatalog(
	{
		version: 1,
		revision: 1,
		strings: { "Loading…": "불러오는 중…", Context: "컨텍스트", "2 minutes": "2분" },
		templates: { "Context {0} used": "컨텍스트 {0} 사용", "{0} ago": "{0} 전", "Run {0} skill": "스킬 {0} 실행", "{0} of {1} tokens": "토큰 {1} 중 {0}" },
	},
	true,
);

describe("catalog", () => {
	test("matches trimmed text, keeps surrounding whitespace and reads ... as …", () => {
		expect(catalog.translate("  Loading...\n")).toBe("  불러오는 중…\n");
	});

	test("fills templates, reorders placeholders and translates placeholder values that are copy", () => {
		expect(catalog.translate("Context 12% used")).toBe("컨텍스트 12% 사용");
		expect(catalog.translate("9.8K of 600K tokens")).toBe("토큰 600K 중 9.8K");
		expect(catalog.translate("2 minutes ago")).toBe("2분 전");
		expect(catalog.translate("Run review skill")).toBe("스킬 review 실행");
	});

	test("translates placeholder-only values inside templates but never alone", () => {
		const withValues = createCatalog(
			{ version: 1, revision: 1, strings: {}, templates: { "Fast mode {0}.": "빠른 모드: {0}." }, values: { enabled: "켜짐" } },
			false,
		);
		expect(withValues.translate("Fast mode enabled.")).toBe("빠른 모드: 켜짐.");
		expect(withValues.translate("Fast mode ultra.")).toBe("빠른 모드: ultra.");
		expect(withValues.translate("enabled")).toBeUndefined();
	});

	test("translates the pieces omp splits off: a label's rest, and phrases around a keycap", () => {
		const split = createCatalog(
			{
				version: 1,
				revision: 1,
				strings: { "Clear: drop context, keep session": "비우기: 컨텍스트를 비우고 세션 유지", "Clear: now": "비우기: 지금" },
				templates: {
					"Set the effort for this session; {0} cycles levels": "이 세션의 추론 강도를 정합니다; {0} 키로 단계를 바꿉니다",
					"Presets: {0} saved": "프리셋: {0}개 저장됨",
				},
			},
			false,
		);
		expect(split.translate("drop context, keep session")).toBe("컨텍스트를 비우고 세션 유지");
		expect(split.translate("Set the effort for this session;")).toBe("이 세션의 추론 강도를 정합니다;");
		expect(split.translate("cycles levels")).toBe("키로 단계를 바꿉니다");
		// Too short to stand alone: a bare word, or a one-word template that would match any "… saved".
		expect(split.translate("now")).toBeUndefined();
		expect(split.translate("Session saved")).toBeUndefined();
	});

	test("writes English dates in Korean order, alone, inside a template and as a placeholder value", () => {
		const dates = createCatalog(
			{ version: 1, revision: 1, strings: {}, templates: { "{0} requests": "요청 {0}건", "Resets {0} {1}, {2}": "{0} {1}, {2}에 초기화", "Updated {0}": "{0} 업데이트" } },
			false,
		);
		expect(dates.translate("Wed 7 Oct")).toBe("10월 7일 (수)");
		expect(dates.translate("Resets Sat 7 Nov 2026, 09:32")).toBe("2026년 11월 7일 (토) 09:32에 초기화");
		expect(dates.translate("Updated Nov 7")).toBe("11월 7일 업데이트");
	});

	test("a status line joined with ` · ` is translated part by part, and no value swallows a separator", () => {
		const parts = createCatalog({ version: 1, revision: 1, strings: { "No activity": "활동 없음" }, templates: { "{0} requests": "요청 {0}건" } }, false);
		expect(parts.translate("Wed 7 Oct · $0.02 · 2 requests")).toBe("10월 7일 (수) · $0.02 · 요청 2건");
		expect(parts.translate("Mon 3 Nov · No activity")).toBe("11월 3일 (월) · 활동 없음");
		expect(parts.translate("foo · bar")).toBeUndefined();
	});

	test("a placeholder value that is itself a known phrase is translated, but never by a bare shape", () => {
		const nested = createCatalog(
			{ version: 1, revision: 1, strings: {}, templates: { "Updated {0}": "{0} 업데이트", "{0} ago": "{0} 전", "{0} {1}": "{1} {0}" } },
			false,
		);
		expect(nested.translate("Updated 51.4s ago")).toBe("51.4s 전 업데이트");
		expect(nested.translate("Updated gpt 5")).toBe("gpt 5 업데이트");
	});

	test("a value that ends a template may hold whole sentences, such as an error", () => {
		const errors = createCatalog(
			{
				version: 1,
				revision: 1,
				strings: {},
				templates: { "Retry failed after {0} attempts: {1}": "재시도 {0}회 후에도 실패했습니다: {1}", "Couldn't connect to {0}. Check the server.": "{0}에 연결하지 못했습니다. 서버를 확인하십시오." },
			},
			false,
		);
		expect(errors.translate("Retry failed after 3 attempts: Couldn't connect to host. Check the server.")).toBe(
			"재시도 3회 후에도 실패했습니다: host에 연결하지 못했습니다. 서버를 확인하십시오.",
		);
	});

	test("the template with the most literal text wins over a shorter one whose last value would swallow the rest", () => {
		const specific = createCatalog(
			{
				version: 1,
				revision: 1,
				strings: {},
				templates: {
					"{0} entries hidden by {1}": "{1}에 가려진 항목 {0}개",
					"{0} entries hidden by {1}. Press {2} to show all": "{1}에 가려진 항목 {0}개. {2} 키로 모두 보기",
				},
			},
			false,
		);
		expect(specific.translate("2 entries hidden by [default]. Press esc to show all")).toBe("[default]에 가려진 항목 2개. esc 키로 모두 보기");
	});

	test("a session notice keeps its source tag and translates its message", () => {
		const notices = createCatalog({ version: 1, revision: 1, strings: {}, templates: { "Prewalk: armed for {0}.": "Prewalk: {0}에 대기합니다." } }, false);
		expect(notices.translate("prewalk: Prewalk: armed for openai/gpt-5.")).toBe("prewalk: Prewalk: openai/gpt-5에 대기합니다.");
		expect(notices.translate("prewalk: something else")).toBeUndefined();
	});

	test("a notice joined from known sentences is translated sentence by sentence", () => {
		const notices = createCatalog(
			{ version: 1, revision: 1, strings: { "Loop mode enabled.": "반복 모드를 켰습니다." }, templates: { "{0} suspends the loop.": "{0} 키로 반복을 멈춥니다." } },
			false,
		);
		expect(notices.translate("Loop mode enabled. ⇧ suspends the loop.")).toBe("반복 모드를 켰습니다. ⇧ 키로 반복을 멈춥니다.");
	});

	test("translates multi-line text line by line and leaves unknown lines", () => {
		expect(catalog.translate("Context 2% used\nsomething else")).toBe("컨텍스트 2% 사용\nsomething else");
	});

	test("leaves Korean, unknown text and partial template matches alone, and records misses", () => {
		expect(catalog.translate("컨텍스트")).toBeUndefined();
		expect(catalog.translate("Context used")).toBeUndefined();
		expect(catalog.translate("Unknown label")).toBeUndefined();
		expect(catalog.misses.has("Unknown label")).toBe(true);
	});

	test("parseCatalog rejects other shapes and drops non-string entries", () => {
		expect(() => parseCatalog('{"version":2,"strings":{}}')).toThrow();
		expect(() => parseCatalog("[]")).toThrow();
		const parsed = parseCatalog('{"version":1,"revision":5,"strings":{"A b":"가","C d":3},"templates":null}');
		expect(parsed).toEqual({ version: 1, revision: 5, strings: { "A b": "가" }, templates: {}, values: {} });
	});
});
