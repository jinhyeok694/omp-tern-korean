import { describe, expect, test } from "bun:test";
import { createCatalog } from "../omp/catalog.ts";
import { DEFAULT_APC_LIMIT, encodeMessage, FrameTranslator, TSP_PREFIX, translateWrite } from "../omp/tsp.ts";
import { keepWords } from "../omp/words.ts";

const catalog = createCatalog(
	{
		version: 1,
		revision: 1,
		strings: { Close: "닫기", "Press ": "누르기 " },
		templates: {
			"Press {0} to clear the search": "검색을 지우려면 {0} 키를 누르십시오",
			"Set the effort; {0} cycles levels": "추론 강도를 정합니다; {0} 키로 단계를 바꿉니다",
			"Gate it with `--until`.": "`--until`로 반복을 제한합니다.",
			"{0} to retry": "{0} 키로 다시 시도",
			"Press {0} to begin": "시작하려면 {0} 키를 누르십시오",
			"{0} to quit": "끝내려면 {0} 키를 누르십시오",
			"{0} to stop": "{0} 키로 멈추기",
		},
	},
	false,
);

type Node = { id: string; k: string; p?: Record<string, unknown>; c?: Node[] };

function decode(write: string): { ops: unknown[][] } {
	let body = "";
	for (const message of write.split("\x1b\\").filter(Boolean)) {
		const inner = message.slice(message.indexOf(TSP_PREFIX) + TSP_PREFIX.length);
		const parts = inner.split(";");
		let index = 1;
		while (index < parts.length - 1 && /^[A-Za-z0-9_-]+=/.test(parts[index]!)) index++;
		body += parts.slice(index).join(";");
	}
	return JSON.parse(body);
}

function run(translator: FrameTranslator, ops: unknown[], s = 1): unknown[][] {
	const out = translateWrite(encodeMessage("f", JSON.stringify({ sf: "s1", s, ops }), {}, DEFAULT_APC_LIMIT), translator, DEFAULT_APC_LIMIT);
	return out === undefined ? (ops as unknown[][]) : decode(out).ops;
}

const textNode = (id: string, text: unknown): Node => ({ id, k: "text", p: { text } });

describe("span lines", () => {
	test("a keycap moves to where the Korean puts it, and each piece keeps its style", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		const spans = [
			{ t: "Press ", s: "muted" },
			{ t: "esc", s: "key" },
			{ t: " to clear the search", s: "muted" },
		];
		const [op] = run(translator, [["add", "a", "main", null, textNode("a", spans)]]);
		expect((op![4] as Node).p!.text).toEqual([
			{ t: "검색을 지우려면 ", s: "muted" },
			{ t: "esc", s: "key" },
			{ t: " 키를 누르십시오", s: "muted" },
		]);
	});

	test("icons sent without spaces match the spaced catalog entry and stay unspaced", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		const spans = [{ t: "Set the effort;" }, { t: "⇧", s: "muted icon" }, { t: "⇥", s: "muted icon" }, { t: "cycles levels" }];
		const [op] = run(translator, [["add", "a", "main", null, textNode("a", spans)]]);
		expect((op![4] as Node).p!.text).toEqual([
			{ t: "추론 강도를 정합니다;" },
			{ t: "⇧", s: "muted icon" },
			{ t: "⇥", s: "muted icon" },
			{ t: "키로 단계를 바꿉니다" },
		]);
	});

	test("code spans match an entry written with backticks and come back as code", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		const spans = [{ t: "Gate it with " }, { t: "--until", s: "code" }, { t: "." }];
		const [op] = run(translator, [["add", "a", "main", null, textNode("a", spans)]]);
		expect((op![4] as Node).p!.text).toEqual([{ t: "--until", s: "code" }, { t: "로 반복을 제한합니다." }]);
	});

	test("words joined for Tern's line breaking keep their pieces and styles, the joiner touching the code", () => {
		const joined = (text: string) => {
			const korean = catalog.translate(text);
			return korean === undefined ? undefined : keepWords(korean);
		};
		const translator = new FrameTranslator(joined);
		const spans = [{ t: "Gate it with " }, { t: "--until", s: "code" }, { t: "." }];
		const [op] = run(translator, [["add", "a", "main", null, textNode("a", spans)]]);
		expect((op![4] as Node).p!.text).toEqual([{ t: "--until", s: "code" }, { t: "\u2060로 반\u2060복\u2060을 제\u2060한\u2060합\u2060니\u2060다\u2060." }]);
	});

	test("without a whole-line entry, pieces are translated one by one", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		const spans = [{ t: "Close", s: "strong" }, { t: "x", s: "key" }];
		const [op] = run(translator, [["add", "a", "main", null, textNode("a", spans)]]);
		expect((op![4] as Node).p!.text).toEqual([
			{ t: "닫기", s: "strong" },
			{ t: "x", s: "key" },
		]);
	});

	test("reports the whole line, not its pieces", () => {
		const seen: string[][] = [];
		const translator = new FrameTranslator(
			text => catalog.translate(text),
			(before, after) => seen.push([before, after]),
		);
		run(translator, [["add", "a", "main", null, textNode("a", [{ t: "Press " }, { t: "esc", s: "key" }, { t: " to clear the search" }])]]);
		expect(seen).toEqual([["Press {0} to clear the search", "검색을 지우려면 {0} 키를 누르십시오"]]);
	});
});

describe("props", () => {
	test("a one-word setting keeps its value while copy fields still translate", () => {
		const words = createCatalog({ version: 1, revision: 1, strings: { "Status: none": "상태: 없음", Current: "현재" }, templates: {} }, false);
		const translator = new FrameTranslator(text => words.translate(text));
		const [op] = run(translator, [
			[
				"add",
				"a",
				"main",
				null,
				{ id: "a", k: "text", p: { text: "Close", wrap: "none", preview: "none", kind: "none", chips: [{ text: "none" }], rows: [{ k: "Status", v: "none" }] } },
			],
		]);
		expect((op![4] as Node).p).toEqual({ text: "Close", wrap: "none", preview: "none", kind: "none", chips: [{ text: "없음" }], rows: [{ k: "Status", v: "없음" }] });
	});
});

describe("error card", () => {
	test("a known error sentence set in mono translates; an unknown one stays", () => {
		const errors = createCatalog({ version: 1, revision: 1, strings: {}, templates: { "Couldn't connect to {0}.": "{0}에 연결하지 못했습니다." } }, false);
		const translator = new FrameTranslator(text => errors.translate(text));
		const message = (id: string, t: string): Node => ({ id, k: "text", p: { role: "omp.error.message", spans: [{ t, s: "mono" }] } });
		const ops = run(translator, [
			["add", "a", "main", null, message("a", "Couldn't connect to localhost:8022.")],
			["add", "b", "main", null, message("b", "Couldn't open /tmp/x.json")],
			["add", "c", "main", null, { id: "c", k: "text", p: { spans: [{ t: "Couldn't connect to host.", s: "mono" }] } }],
		]);
		expect(ops.map(op => ((op[4] as Node).p!.spans as { t: string }[])[0]!.t)).toEqual([
			"localhost:8022에 연결하지 못했습니다.",
			"Couldn't open /tmp/x.json",
			"Couldn't connect to host.",
		]);
	});
});

describe("rows of text and keycap nodes", () => {
	const kbd = (id: string, key: string): Node => ({ id, k: "kbd", p: { keys: [key] } });
	const row = (children: Node[]): Node => ({ id: "r", k: "row", c: children });

	test("the Korean is spread over the row's text nodes around the keycaps", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		const [op] = run(translator, [["add", "r", "main", null, row([textNode("t1", [{ t: "Press", s: "muted" }]), kbd("k", "enter"), textNode("t2", [{ t: "to begin", s: "muted" }])])]]);
		const children = (op![4] as Node).c!;
		expect(children.map(child => [child.id, child.p?.text, child.p?.hidden])).toEqual([
			["t1", [{ s: "muted", t: "시작하려면" }], undefined],
			["k", undefined, undefined],
			["t2", [{ s: "muted", t: "키를 누르십시오" }], undefined],
		]);
	});

	test("an icon at the edge stays out of the sentence; a text node is added where the Korean needs one", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		const [op] = run(translator, [
			["add", "r", "main", null, row([{ id: "i", k: "icon", p: { name: "loop" } }, kbd("k", "f5"), textNode("t", [{ t: "to quit", s: "muted" }])])],
		]);
		const children = (op![4] as Node).c!;
		expect(children.map(child => child.id)).toEqual(["i", "r~ko0", "k", "t"]);
		expect(children[1]!.p!.spans).toEqual([{ s: "muted", t: "끝내려면" }]);
		expect(children[3]!.p!.text).toEqual([{ s: "muted", t: "키를 누르십시오" }]);
	});

	test("a chart inside a row is a placeholder like a keycap, and copy sent as `spans` stays in `spans`", () => {
		const legend = createCatalog({ version: 1, revision: 1, strings: { Less: "간단히", More: "더 보기" }, templates: { "Less {0} More": "적음 {0} 많음" } }, false);
		const translator = new FrameTranslator(text => legend.translate(text));
		const spansNode = (id: string, t: string): Node => ({ id, k: "text", p: { spans: [{ t, s: "dim" }] } });
		const [op] = run(translator, [["add", "r", "main", null, row([spansNode("a", "Less"), { id: "c", k: "chart", p: { kind: "heatmap" } }, spansNode("b", "More")])]]);
		expect((op![4] as Node).c!.map(child => child.p)).toEqual([{ spans: [{ s: "dim", t: "적음" }] }, { kind: "heatmap" }, { spans: [{ s: "dim", t: "많음" }] }]);
		const update = run(translator, [["set", "b", { spans: [{ t: "More", s: "dim" }] }]], 2);
		expect(update).toEqual([
			["set", "a", { spans: [{ s: "dim", t: "적음" }], hidden: false }],
			["set", "b", { spans: [{ s: "dim", t: "많음" }], hidden: false }],
		]);
	});

	test("a live counter inside a row is a placeholder; at the row's end it stays out of the sentence", () => {
		const ago = createCatalog({ version: 1, revision: 1, strings: { Updated: "업데이트" }, templates: { "Updated {0} ago": "{0} 전 업데이트" } }, false);
		const translator = new FrameTranslator(text => ago.translate(text));
		const elapsed = (id: string): Node => ({ id, k: "elapsed", p: { age: 3 } });
		const [inside] = run(translator, [["add", "r", "main", null, row([textNode("a", [{ t: "Updated", s: "dim" }]), elapsed("e"), textNode("b", [{ t: "ago", s: "dim" }])])]]);
		expect((inside![4] as Node).c!.map(child => child.p)).toEqual([
			{ text: [{ s: "dim", t: "" }], hidden: true },
			{ age: 3 },
			{ text: [{ s: "dim", t: "전 업데이트" }] },
		]);
		const [atEnd] = run(translator, [["add", "q", "main", null, { id: "q", k: "row", c: [textNode("u", "Updated"), elapsed("f")] }]]);
		expect((atEnd![4] as Node).c!.map(child => child.p)).toEqual([{ text: "업데이트" }, { age: 3 }]);
	});

	test("a later change to a text node redraws the row from omp's English", () => {
		const translator = new FrameTranslator(text => catalog.translate(text));
		run(translator, [["add", "r", "main", null, row([kbd("k", "f5"), textNode("t", "to retry")])]]);
		const ops = run(translator, [["set", "t", { text: "to stop", tone: "muted" }]], 2);
		expect(ops).toEqual([["set", "t", { tone: "muted", text: "키로 멈추기", hidden: false }]]);
		const fallback = run(translator, [["set", "t", { text: "Close" }]], 3);
		expect(fallback).toEqual([["set", "t", { text: "닫기", hidden: false }]]);
	});
});
