/**
 * Translation of omp's native Tern UI at the Tern Surface Protocol boundary.
 *
 * In Tern, omp draws by writing APC messages `ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \`.
 * Verb `f` carries a frame: `{ sf, s, ops }`, where ops add nodes, set props and edit text.
 * This module rewrites the UI copy inside those frames and passes every other byte through.
 * It depends on the public wire protocol only, not on omp's internal modules, so it keeps
 * working when omp moves its components around.
 */

export const TSP_PREFIX = "\x1b_tsp;";
const ST = "\x1b\\";
/** omp's own optimistic `hello` assumes this limit before Tern replies, so Tern always accepts it. */
export const DEFAULT_APC_LIMIT = 65_536;

/** Returns the Korean for one UI string, or undefined to keep it. */
export type Translate = (text: string) => string | undefined;

/** Node kinds whose `text` prop is content (conversation, code, terminal output, user input). */
const CONTENT_KINDS: Record<string, true> = {
	md: true,
	code: true,
	ansi: true,
	diff: true,
	math: true,
	editor: true,
	input: true,
	json: true,
	media: true,
	image: true,
};

/** Node kinds whose `text` prop is a keycap or a glyph: kept verbatim. */
const VERBATIM_TEXT_KINDS: Record<string, true> = { kbd: true, icon: true, spinner: true };

/** Whether a node's `text` prop is UI copy: a text line, a button's label, a chip. */
function isCopyKind(kind: string): boolean {
	return kind !== "" && CONTENT_KINDS[kind] !== true && VERBATIM_TEXT_KINDS[kind] !== true;
}

/**
 * Props that never hold UI copy: identifiers, machine values, styling tokens, key names,
 * links, user content and query text. `text` is decided by node kind instead, and is copy
 * inside nested objects (badges, chips, confirm prompts).
 */
const DENY_PROPS: Record<string, true> = {
	id: true,
	key: true,
	role: true,
	tone: true,
	icon: true,
	href: true,
	src: true,
	url: true,
	path: true,
	act: true,
	action: true,
	// The common `actions` prop names gesture actions; a picker's `actions` list holds labelled buttons.
	click: true,
	dblclick: true,
	menu: true,
	mode: true,
	value: true,
	values: true,
	s: true,
	fx: true,
	lang: true,
	token: true,
	dot: true,
	scope: true,
	tab: true,
	active: true,
	selected: true,
	page: true,
	filter: true,
	query: true,
	target: true,
	keys: true,
	noun: true,
	draft: true,
	mark: true,
	variant: true,
	style: true,
	status: true,
	state: true,
	focus: true,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface NodeState {
	kind: string;
	/** omp's untranslated text, kept only for nodes whose `text` this module translated. */
	original?: string;
}

/** Node kinds per surface, so `text`/`splice` ops know what they edit. */
type SurfaceMemory = Map<string, NodeState>;
const MAX_REMEMBERED_NODES = 200_000;

export class FrameTranslator {
	readonly #surfaces = new Map<string, SurfaceMemory>();
	#translate: Translate;
	/** Whether the frame being translated changed. */
	#changed = false;

	constructor(translate: Translate) {
		this.#translate = translate;
	}

	setTranslate(translate: Translate): void {
		this.#translate = translate;
	}

	closeSurface(sf: string): void {
		this.#surfaces.delete(sf);
	}

	#text(text: string): string {
		const translated = this.#translate(text);
		if (translated === undefined || translated === text) return text;
		this.#changed = true;
		return translated;
	}

	/** Translates a TspText: a string or spans. */
	#tspText(value: Json): Json {
		if (typeof value === "string") return this.#text(value);
		if (Array.isArray(value)) return value.map(item => this.#value(item, ""));
		return value;
	}

	/** Translates any prop value; `key` names the prop or field that holds it. */
	#value(value: Json, key: string): Json {
		// `k` is a kv row's label (`{ k: "Model", v }`) but also a control's kind (`{ k: "select" }`).
		const denied = DENY_PROPS[key] === true || (key === "k" && typeof value === "string" && /^[a-z][\w-]*$/.test(value));
		if (typeof value === "string") return denied ? value : this.#text(value);
		if (Array.isArray(value)) {
			// Spans are copy wherever they sit (a table cell keyed by a column id such as `keys` or
			// `action`); their style tokens, not the field name, mark keycaps, code and paths.
			if (denied && !value.some(isSpan)) return value;
			return value.map(item => this.#value(item, key));
		}
		if (value === null || typeof value !== "object") return value;
		if (isSpan(value)) {
			if (typeof value.s === "string" && value.s.split(" ").some(token => VERBATIM_SPAN_TOKENS[token] === true))
				return value;
			const t = this.#text(value.t as string);
			return t === value.t ? value : { ...value, t };
		}
		// A node carried inside a prop (a hovercard).
		if (typeof value.k === "string" && ("p" in value || "c" in value)) return this.#propNode(value);
		if (denied) return value;
		// A picker item's `facts` maps labels to values: its keys are the labels the user reads.
		if (RECORD_LABEL_PROPS[key] === true) {
			const out: JsonObject = {};
			for (const label in value) out[this.#text(label)] = this.#value(value[label]!, "fact");
			return out;
		}
		const out: JsonObject = {};
		for (const field in value) out[field] = this.#value(value[field]!, field);
		return out;
	}

	#props(kind: string, props: JsonObject, state: NodeState | undefined): JsonObject {
		const out: JsonObject = {};
		for (const name in props) {
			const raw = props[name]!;
			if (name === "text") {
				if (isCopyKind(kind)) {
					const translated = this.#tspText(raw);
					if (state) state.original = typeof raw === "string" && translated !== raw ? raw : undefined;
					out[name] = translated;
				} else {
					if (state) state.original = undefined;
					out[name] = raw;
				}
				continue;
			}
			if (CONTENT_KINDS[kind] === true && name === "prompt") {
				out[name] = raw;
				continue;
			}
			out[name] = this.#value(raw, name);
		}
		return out;
	}

	#propNode(node: JsonObject): JsonObject {
		const kind = node.k as string;
		const out: JsonObject = { ...node };
		if (isObject(node.p)) out.p = this.#props(kind, node.p, undefined);
		if (Array.isArray(node.c)) out.c = node.c.map(child => (isObject(child) ? this.#propNode(child) : child));
		return out;
	}

	#node(memory: SurfaceMemory, node: JsonObject): JsonObject {
		const kind = typeof node.k === "string" ? node.k : "";
		let state: NodeState | undefined;
		if (typeof node.id === "string") {
			if (memory.size >= MAX_REMEMBERED_NODES) memory.clear();
			state = { kind };
			memory.set(node.id, state);
		}
		const out: JsonObject = { ...node };
		if (isObject(node.p)) out.p = this.#props(kind, node.p, state);
		if (Array.isArray(node.c)) out.c = node.c.map(child => (isObject(child) ? this.#node(memory, child) : child));
		return out;
	}

	#op(memory: SurfaceMemory, op: Json[]): Json[] {
		const [name, id] = op;
		switch (name) {
			case "add":
				return isObject(op[4]) ? [op[0]!, op[1]!, op[2]!, op[3]!, this.#node(memory, op[4])] : op;
			case "set": {
				if (typeof id !== "string" || !isObject(op[2])) return op;
				const state = memory.get(id);
				return [name, id, this.#props(state?.kind ?? "", op[2], state)];
			}
			case "text": {
				const state = typeof id === "string" ? memory.get(id) : undefined;
				if (!state || !isCopyKind(state.kind) || typeof op[3] !== "string") return op;
				if (op[2] === "append") {
					// omp appends to its own text; only text this module replaced needs rebuilding.
					if (state.original === undefined) return op;
					return this.#replace(state, id as string, state.original + op[3]);
				}
				return this.#replace(state, id as string, op[3]);
			}
			case "splice": {
				const state = typeof id === "string" ? memory.get(id) : undefined;
				if (state?.original === undefined) return op;
				const [, , at, del, text] = op;
				if (typeof at !== "number" || typeof del !== "number" || typeof text !== "string") return op;
				return this.#replace(state, id as string, state.original.slice(0, at) + text + state.original.slice(at + del));
			}
			case "del":
				if (typeof id === "string") memory.delete(id);
				return op;
			default:
				return op;
		}
	}

	/** Sends the whole text of a node this module translated, so omp's later edits apply to omp's text. */
	#replace(state: NodeState, id: string, full: string): Json[] {
		const hadTranslation = state.original !== undefined;
		const translated = this.#text(full);
		state.original = translated !== full ? full : undefined;
		// Tern holds the translated text: rebuilding from omp's text is a change even without a new translation.
		if (hadTranslation) this.#changed = true;
		return ["text", id, "replace", translated];
	}

	/** Translates one decoded frame body. Returns undefined when nothing changed. */
	frame(body: JsonObject): JsonObject | undefined {
		if (typeof body.sf !== "string" || !Array.isArray(body.ops)) return undefined;
		let memory = this.#surfaces.get(body.sf);
		if (!memory) {
			memory = new Map();
			this.#surfaces.set(body.sf, memory);
		}
		this.#changed = false;
		const ops = body.ops.map(op => (Array.isArray(op) ? this.#op(memory, op) : op));
		return this.#changed ? { ...body, ops } : undefined;
	}
}

const SPAN_FIELDS: Record<string, true> = { t: true, s: true, fx: true, href: true };
/** Props holding a record whose keys are display labels (`facts: { Model: "…" }`). */
const RECORD_LABEL_PROPS: Record<string, true> = { facts: true };
/** Span style tokens whose text is a keycap, code, a path, a number, a link or a glyph: never translated. */
const VERBATIM_SPAN_TOKENS: Record<string, true> = {
	key: true,
	code: true,
	mono: true,
	path: true,
	num: true,
	link: true,
	icon: true,
	typo: true,
	ins: true,
	del: true,
};

function isSpan(value: Json): value is JsonObject {
	return isObject(value) && typeof value.t === "string" && Object.keys(value).every(field => SPAN_FIELDS[field] === true);
}

function isObject(value: Json | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ─── Wire framing ──────────────────────────────────────────────────────────

interface RawMessage {
	verb: string;
	params: Record<string, string>;
	body: string;
	/** The exact bytes of this APC message. */
	raw: string;
}

const PARAM = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*$/;

function splitMessage(raw: string): RawMessage | null {
	const inner = raw.slice(TSP_PREFIX.length, -ST.length);
	let semi = inner.indexOf(";");
	if (semi <= 0) return semi === -1 && inner.length > 0 ? { verb: inner, params: {}, body: "", raw } : null;
	const verb = inner.slice(0, semi);
	const params: Record<string, string> = {};
	let pos = semi + 1;
	// A segment is a parameter only when another `;` follows it; the body is the rest.
	for (;;) {
		semi = inner.indexOf(";", pos);
		if (semi === -1) break;
		const segment = inner.slice(pos, semi);
		if (!PARAM.test(segment)) break;
		const eq = segment.indexOf("=");
		params[segment.slice(0, eq)] = segment.slice(eq + 1);
		pos = semi + 1;
	}
	return { verb, params, body: inner.slice(pos), raw };
}

let nextChunk = 1;

/** Encodes one logical message, chunked on code-point boundaries when the body exceeds `limit` UTF-8 bytes. */
export function encodeMessage(verb: string, body: string, params: Record<string, string>, limit: number): string {
	let base = "";
	for (const key in params) base += `;${key}=${params[key]}`;
	if (Buffer.byteLength(body, "utf8") <= limit) return `${TSP_PREFIX}${verb}${base};${body}${ST}`;
	const chunkId = `ko${(nextChunk++).toString(36)}`;
	const pieces: string[] = [];
	let start = 0;
	while (start < body.length) {
		let end = start;
		let bytes = 0;
		while (end < body.length) {
			const code = body.codePointAt(end)!;
			const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
			if (bytes + width > limit) break;
			bytes += width;
			end += code >= 0x10000 ? 2 : 1;
		}
		// A chunk must not lead with `key=value;`, which the receiver would read as one more parameter.
		while (end > start + 1 && end < body.length) {
			const semi = body.indexOf(";", end);
			const lowSurrogate = body.charCodeAt(end) >= 0xdc00 && body.charCodeAt(end) <= 0xdfff;
			if (!lowSurrogate && (semi === -1 || !PARAM.test(body.slice(end, semi)))) break;
			end--;
		}
		pieces.push(body.slice(start, end));
		start = end;
	}
	let out = "";
	for (let i = 0; i < pieces.length; i++) {
		const more = i < pieces.length - 1 ? ";m=1" : "";
		out += `${TSP_PREFIX}${verb}${i === 0 ? base : ""};c=${chunkId}${more};${pieces[i]}${ST}`;
	}
	return out;
}

/**
 * Rewrites the frames in one terminal write. Returns undefined when nothing changed, or when a
 * message is split across writes, so the caller writes the original bytes.
 */
export function translateWrite(data: string, translator: FrameTranslator, limit: number): string | undefined {
	if (!data.includes(TSP_PREFIX)) return undefined;
	const parts: string[] = [];
	let changed = false;
	let pos = 0;
	let chunk: { id: string; verb: string; params: Record<string, string>; body: string; raw: string } | null = null;
	while (pos < data.length) {
		const start = data.indexOf(TSP_PREFIX, pos);
		if (start === -1) {
			parts.push(data.slice(pos));
			break;
		}
		if (start > pos) parts.push(data.slice(pos, start));
		const end = data.indexOf(ST, start);
		if (end === -1) return undefined;
		pos = end + ST.length;
		const message = splitMessage(data.slice(start, pos));
		if (!message) return undefined;
		let verb = message.verb;
		let params = message.params;
		let body = message.body;
		let raw = message.raw;
		const chunkId = message.params.c;
		if (chunkId !== undefined) {
			if (!chunk) {
				const { c: _c, m: _m, ...first } = message.params;
				chunk = { id: chunkId, verb, params: first, body: "", raw: "" };
			} else if (chunk.id !== chunkId) {
				return undefined;
			}
			chunk.body += body;
			chunk.raw += raw;
			if (message.params.m === "1") continue;
			({ verb, params, body, raw } = chunk);
			chunk = null;
		}
		const rewritten = rewrite(verb, params, body, translator, limit);
		parts.push(rewritten ?? raw);
		if (rewritten !== undefined) changed = true;
	}
	if (chunk) return undefined;
	return changed ? parts.join("") : undefined;
}

function rewrite(
	verb: string,
	params: Record<string, string>,
	body: string,
	translator: FrameTranslator,
	limit: number,
): string | undefined {
	if (verb === "x") {
		try {
			const closed = JSON.parse(body) as { id?: unknown; keep?: unknown };
			if (typeof closed.id === "string" && closed.keep !== true) translator.closeSurface(closed.id);
		} catch {}
		return undefined;
	}
	if (verb !== "f") return undefined;
	let parsed: Json;
	try {
		parsed = JSON.parse(body) as Json;
	} catch {
		return undefined;
	}
	if (!isObject(parsed)) return undefined;
	const translated = translator.frame(parsed);
	return translated ? encodeMessage(verb, JSON.stringify(translated), params, limit) : undefined;
}
