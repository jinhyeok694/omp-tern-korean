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
