import { describe, expect, test } from "bun:test";
import { koreanizeRequest } from "../omp/korean-prompts.ts";

const titleRequest = "<title-request>\nName this session.\n</title-request>";

describe("koreanizeRequest", () => {
	test("adds the language line inside a trailing title request, in each provider's message shape", () => {
		const anthropic = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: titleRequest }] }] };
		const responses = { input: [{ role: "user", content: [{ type: "input_text", text: titleRequest }] }] };
		const google = { contents: [{ role: "user", parts: [{ text: titleRequest }] }] };
		const chat = { messages: [{ role: "system", content: "s" }, { role: "user", content: titleRequest }] };
		for (const payload of [anthropic, responses, google, chat]) {
			const out = JSON.stringify(koreanizeRequest(payload));
			expect(out).toContain("한국어");
			expect(out.indexOf("한국어")).toBeLessThan(out.indexOf("</title-request>"));
		}
		expect(JSON.stringify(anthropic)).not.toContain("한국어"); // the original payload is not mutated
	});

	test("adds the recap line and keeps earlier messages identical", () => {
		const earlier = { role: "user", content: "hello" };
		const payload = { messages: [earlier, { role: "user", content: "<recap>\nUser stepped away.\n</recap>" }] };
		const out = koreanizeRequest(payload) as { messages: unknown[] };
		expect(out.messages[0]).toBe(earlier);
		expect(JSON.stringify(out.messages[1])).toContain("합니다체");
	});

	test("leaves ordinary turns, title tags mentioned earlier in the conversation, and odd payloads alone", () => {
		expect(koreanizeRequest({ messages: [{ role: "user", content: "fix the bug" }] })).toBeUndefined();
		expect(koreanizeRequest({ messages: [{ role: "user", content: titleRequest }, { role: "assistant", content: "ok" }] })).toBeUndefined();
		expect(koreanizeRequest(null)).toBeUndefined();
		expect(koreanizeRequest([titleRequest])).toBeUndefined();
	});

	test("does not add the line twice", () => {
		const once = koreanizeRequest({ messages: [{ role: "user", content: titleRequest }] });
		expect(koreanizeRequest(once)).toBeUndefined();
	});
});
