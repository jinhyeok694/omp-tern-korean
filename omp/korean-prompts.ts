/**
 * Asks the model for Korean in the text omp generates for its own UI: session titles and the
 * "welcome back" recap. omp sends both as a side turn whose last user message wraps the request in
 * `<title-request>…</title-request>` or `<recap>…</recap>`; this adds one language line inside that
 * wrapper. The conversation itself and every other request are left alone.
 */

const INSTRUCTIONS: readonly { close: string; line: string }[] = [
	{
		close: "</title-request>",
		line: "- Language: write the title in natural Korean (한국어). Keep product names, code identifiers and file names as written; the `code` attribute stays capital Latin letters or digits.",
	},
	{
		close: "</recap>",
		line: "Language: write the recap in natural Korean (한국어), in polite 합니다체.",
	},
];

/** Keys holding the message list in the request bodies of the providers omp speaks to. */
const MESSAGE_LIST_KEYS = ["messages", "input", "contents"] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function addInstruction(text: string): string {
	let out = text;
	for (const { close, line } of INSTRUCTIONS) {
		const at = out.lastIndexOf(close);
		if (at === -1 || out.includes(line)) continue;
		out = `${out.slice(0, at)}${line}\n${out.slice(at)}`;
	}
	return out;
}

/** Rewrites every string in `value` that closes a title or recap request; returns `value` itself when none does. */
function rewrite(value: Json): Json {
	if (typeof value === "string") return value.includes("</") ? addInstruction(value) : value;
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map(item => {
			const next = rewrite(item);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}
	if (value !== null && typeof value === "object") {
		let changed = false;
		const out: { [key: string]: Json } = {};
		for (const key in value) {
			const next = rewrite(value[key]!);
			if (next !== value[key]) changed = true;
			out[key] = next;
		}
		return changed ? out : value;
	}
	return value;
}

/**
 * The payload with a Korean-language line added to a trailing title or recap request, or undefined
 * when the request is something else. Only the last message is examined, so a long conversation
 * costs one small walk.
 */
export function koreanizeRequest(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const body = payload as { [key: string]: Json };
	for (const key of MESSAGE_LIST_KEYS) {
		const list = body[key];
		if (!Array.isArray(list) || list.length === 0) continue;
		const last = list[list.length - 1]!;
		const next = rewrite(last);
		if (next === last) return undefined;
		return { ...body, [key]: [...list.slice(0, -1), next] };
	}
	return undefined;
}
