import { describe, expect, test } from "bun:test";
import { DEFAULT_APC_LIMIT, encodeMessage, FrameTranslator, TSP_PREFIX, translateWrite } from "../omp/tsp.ts";

const KO: Record<string, string> = { Settings: "설정", Close: "닫기", Cancel: "취소", "Start of line": "줄 처음으로", Thinking: "생각하는 중" };
const translator = () => new FrameTranslator(text => KO[text]);
const frame = (ops: unknown[], s = 1) => encodeMessage("f", JSON.stringify({ sf: "s1", s, ops }), {}, DEFAULT_APC_LIMIT);

/** Joins the bodies of every message in a write (chunks included) and parses the frame. */
function decode(write: string): { ops: unknown[] } {
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

describe("FrameTranslator", () => {
	test("translates UI copy and leaves conversation, input, keycaps and ids alone", () => {
		const t = translator();
		const out = translateWrite(
			frame([
				[
					"add",
					"root",
					"main",
					null,
					{
						id: "root",
						k: "col",
						c: [
							{ id: "a", k: "text", p: { text: "Settings" } },
							{ id: "b", k: "md", p: { text: "Settings" } },
							{ id: "c", k: "editor", p: { text: "Cancel", placeholder: "Settings" } },
							{ id: "d", k: "button", p: { text: "Close", actions: { click: "close" }, facts: { Settings: "Close", Model: 3 } } },
							{ id: "f", k: "kv", p: { items: [{ k: "Settings", v: "Close" }, { k: [{ t: "Close", s: "muted" }], v: "x" }] } },
							{ id: "g", k: "prefs", p: { rows: [{ id: "r", label: "Close", control: { k: "select", value: "close" } }] } },
							{
								id: "e",
								k: "table",
								p: { rows: [{ id: "Close", cells: { keys: [{ t: "Close", s: "key" }], action: [{ t: "Start of line" }] } }] },
							},
						],
					},
				],
			]),
			t,
			DEFAULT_APC_LIMIT,
		);
		expect(out).toBeDefined();
		const [, , , , root] = decode(out!).ops[0] as [string, string, string, null, { c: { p: Record<string, unknown> }[] }];
		expect(root.c[0]!.p.text).toBe("설정");
		expect(root.c[1]!.p.text).toBe("Settings");
		expect(root.c[2]!.p).toEqual({ text: "Cancel", placeholder: "설정" });
		expect(root.c[3]!.p).toEqual({ text: "닫기", actions: { click: "close" }, facts: { 설정: "닫기", Model: 3 } });
		expect(root.c[4]!.p).toEqual({ items: [{ k: "설정", v: "닫기" }, { k: [{ t: "닫기", s: "muted" }], v: "x" }] });
		expect(root.c[5]!.p).toEqual({ rows: [{ id: "r", label: "닫기", control: { k: "select", value: "close" } }] });
		expect(root.c[6]!.p).toEqual({
			rows: [{ id: "Close", cells: { keys: [{ t: "Close", s: "key" }], action: [{ t: "줄 처음으로" }] } }],
		});
	});

	test("rebuilds later edits of translated text from omp's English", () => {
		const t = translator();
		translateWrite(frame([["add", "n", "main", null, { id: "n", k: "text", p: { text: "Close" } }]]), t, DEFAULT_APC_LIMIT);
		const appended = translateWrite(frame([["text", "n", "append", "d"]], 2), t, DEFAULT_APC_LIMIT);
		// Tern holds "닫기"; omp's text is now "Closed", which has no translation, so the English is sent whole.
		expect(decode(appended!).ops).toEqual([["text", "n", "replace", "Closed"]]);
		const spliced = translateWrite(frame([["splice", "n", 0, 6, "Thinking"]], 3), t, DEFAULT_APC_LIMIT);
		expect(spliced).toBeUndefined(); // "Closed" was sent untranslated, so omp's splice applies to what Tern holds
		const replaced = translateWrite(frame([["text", "n", "replace", "Thinking"]], 4), t, DEFAULT_APC_LIMIT);
		expect(decode(replaced!).ops).toEqual([["text", "n", "replace", "생각하는 중"]]);
		const splicedAgain = translateWrite(frame([["splice", "n", 8, 0, "…"]], 5), t, DEFAULT_APC_LIMIT);
		expect(decode(splicedAgain!).ops).toEqual([["text", "n", "replace", "Thinking…"]]);
	});

	test("passes other bytes, unchanged frames and messages split across writes through", () => {
		const t = translator();
		expect(translateWrite("\x1b[2Jplain text", t, DEFAULT_APC_LIMIT)).toBeUndefined();
		expect(translateWrite(frame([["add", "x", "main", null, { id: "x", k: "md", p: { text: "Close" } }]]), t, DEFAULT_APC_LIMIT)).toBeUndefined();
		const whole = frame([["add", "y", "main", null, { id: "y", k: "text", p: { text: "Close" } }]]);
		expect(translateWrite(whole.slice(0, 20), t, DEFAULT_APC_LIMIT)).toBeUndefined();
		const mixed = translateWrite(`before${whole}after`, t, DEFAULT_APC_LIMIT)!;
		expect(mixed.startsWith("before") && mixed.endsWith("after")).toBe(true);
	});

	test("joins chunked frames and re-chunks within the byte limit on code-point boundaries", () => {
		const t = translator();
		const long = `${"가".repeat(4000)}a=b;c`;
		const body = JSON.stringify({
			sf: "s1",
			s: 1,
			ops: [
				["add", "z", "main", null, { id: "z", k: "text", p: { text: "Settings" } }],
				["add", "w", "main", null, { id: "w", k: "md", p: { text: long } }],
			],
		});
		const limit = 1000;
		const out = translateWrite(encodeMessage("f", body, {}, limit), t, limit)!;
		const messages = out.split("\x1b\\").filter(Boolean);
		expect(messages.length).toBeGreaterThan(10);
		for (const message of messages) {
			const inner = message.slice(TSP_PREFIX.length);
			const bodyStart = inner.split(";").findIndex((part, i) => i > 0 && !/^[A-Za-z0-9_-]+=/.test(part));
			const chunkBody = inner.split(";").slice(bodyStart).join(";");
			expect(Buffer.byteLength(chunkBody, "utf8")).toBeLessThanOrEqual(limit);
		}
		const decoded = decode(out).ops as [string, string, string, null, { p: { text: string } }][];
		expect(decoded[0]![4].p.text).toBe("설정");
		expect(decoded[1]![4].p.text).toBe(long);
	});
});
