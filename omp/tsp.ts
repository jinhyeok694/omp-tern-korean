/**
 * Translation of omp's native Tern UI at the Tern Surface Protocol boundary.
 *
 * In Tern, omp draws by writing APC messages `ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \`.
 * Verb `f` carries a frame: `{ sf, s, ops }`, where ops add nodes, set props and edit text.
 * This module rewrites the UI copy inside those frames and passes every other byte through.
 * It depends on the public wire protocol only, not on omp's internal modules, so it keeps
 * working when omp moves its components around.
 */

import {
	type CopyKey,
	copyKey,
	firstSpanStyle,
	isObject,
	isSpan,
	isVerbatimSpan,
	type JsonObject,
	type MaskedSpans,
	maskRow,
	maskSpans,
	type RowLine,
	rebuildSpans,
	rowText,
	showPlaceholders,
	splitRowKorean,
} from "./sequence.ts";

export const TSP_PREFIX = "\x1b_tsp;";
const ST = "\x1b\\";
/** Role of the text node holding a failed request's message in omp's error card. */
const ERROR_MESSAGE_ROLE = "omp.error.message";
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

/** Called for every UI text unit with omp's text and what is shown; placeholders appear as `{n}`. */
export type Observe = (before: string, after: string) => void;

interface NodeState {
	kind: string;
	/** omp's untranslated text, kept only for nodes whose `text` this module translated. */
	original?: string;
	/** The row whose sentence this text node is part of. */
	row?: RowState;
}

/** A row translated as one sentence (`Press [enter] to begin`). */
interface RowState {
	id: string;
	children: { id: string; kind: string }[];
	/** omp's current copy of each text child, by child index. */
	texts: Map<number, string>;
	/** Per text child index, the span style it was sent with; absent when it was a plain string. */
	styles: Map<number, JsonObject>;
	/** Per text child index, the prop omp keeps its copy in. */
	keys: Map<number, CopyKey>;
	/** Text nodes this module added to gaps that had none, by gap index. */
	created: Map<number, string>;
	/** Style of the text nodes this module adds. */
	style: JsonObject;
}

/** A row ready to be drawn as one translated sentence. */
interface RowPlan {
	state: RowState;
	line: RowLine;
	/** Korean per gap between keycaps. */
	segments: string[];
	korean: string;
}

/** Node kinds per surface, so `text`/`splice` ops know what they edit. */
type SurfaceMemory = Map<string, NodeState>;
const MAX_REMEMBERED_NODES = 200_000;

export class FrameTranslator {
	readonly #surfaces = new Map<string, SurfaceMemory>();
	#translate: Translate;
	readonly #observe: Observe | undefined;
	/** Whether the frame being translated changed. */
	#changed = false;
	/** Above zero while pieces of a line translated as a whole are processed: they are not reported on their own. */
	#muted = 0;

	constructor(translate: Translate, observe?: Observe) {
		this.#translate = translate;
		this.#observe = observe;
	}

	setTranslate(translate: Translate): void {
		this.#translate = translate;
	}

	closeSurface(sf: string): void {
		this.#surfaces.delete(sf);
	}

	#report(before: string, after: string): void {
		if (this.#muted === 0) this.#observe?.(showPlaceholders(before), showPlaceholders(after));
	}

	/** The Korean for a whole masked line, or undefined. */
	#whole(masked: string): string | undefined {
		const korean = this.#translate(masked);
		return korean === undefined || korean === masked ? undefined : korean;
	}

	#text(text: string, report = true): string {
		const translated = this.#translate(text);
		const shown = translated === undefined ? text : translated;
		if (report) this.#report(text, shown);
		if (shown === text) return text;
		this.#changed = true;
		return shown;
	}

	#span(span: JsonObject, report: boolean): JsonObject {
		if (isVerbatimSpan(span)) return span;
		const t = this.#text(span.t as string, report);
		return t === span.t ? span : { ...span, t };
	}

	/** A span of an error message: translated when the catalog knows the whole sentence, mono or not. */
	#errorSpan(span: JsonObject): JsonObject {
		const t = this.#text(span.t as string, true);
		return t === span.t ? span : { ...span, t };
	}

	/**
	 * Translates a span array: as one line when keycaps, numbers, code or icons split its words, so
	 * the Korean can put them where Korean word order needs them; piece by piece otherwise.
	 */
	#spans(spans: JsonObject[]): JsonObject[] {
		if (spans.length < 2) return spans.map(span => this.#span(span, true));
		const masked = maskSpans(spans, false);
		if (!masked || (masked.groups.length === 0 && masked.copySpans < 2)) return spans.map(span => this.#span(span, true));
		const whole = (): JsonObject[] | undefined => {
			let used: MaskedSpans = masked;
			let korean = this.#whole(masked.masked);
			if (korean === undefined) {
				const withCode = maskSpans(spans, true);
				if (withCode?.codeStyle) {
					korean = this.#whole(withCode.masked);
					used = withCode;
				}
			}
			if (korean === undefined) return undefined;
			this.#changed = true;
			this.#report(used.masked, korean);
			return rebuildSpans(korean, used);
		};
		const pieces = (): JsonObject[] => {
			const out = spans.map(span => this.#span(span, false));
			this.#report(masked.masked, maskSpans(out, false)?.masked ?? masked.masked);
			return out;
		};
		if (masked.groups.length > 0 || masked.uniformStyle) return whole() ?? pieces();
		// Differently styled pieces without keycaps: piece by piece keeps their emphasis; the whole line
		// is used only when a piece would stay English.
		const each = spans.map(span => this.#span(span, false));
		const leftover = each.some((span, index) => span === spans[index] && !isVerbatimSpan(span) && /[A-Za-z]{2}/.test(span.t as string));
		if (leftover) {
			const rebuilt = whole();
			if (rebuilt) return rebuilt;
		}
		this.#report(masked.masked, maskSpans(each, false)?.masked ?? masked.masked);
		return each;
	}

	/** Translates a TspText: a string or spans. */
	#tspText(value: Json): Json {
		if (typeof value === "string") return this.#text(value);
		if (Array.isArray(value) && value.every(isSpan)) return this.#spans(value as JsonObject[]);
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
			if (value.length > 0 && value.every(isSpan)) return this.#spans(value as JsonObject[]);
			if (denied) return value;
			return value.map(item => this.#value(item, key));
		}
		if (value === null || typeof value !== "object") return value;
		if (isSpan(value)) return this.#span(value as JsonObject, true);
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
			// omp sets a failed request's message in mono. A sentence the catalog knows (omp's own
			// connection errors) translates; anything else (a provider's raw error, a path) stays.
			if (name === "spans" && props.role === ERROR_MESSAGE_ROLE && Array.isArray(raw)) {
				out[name] = raw.map(span => (isSpan(span) ? this.#errorSpan(span as JsonObject) : span));
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
		if (!Array.isArray(node.c)) return out;
		const row = kind === "row" && typeof node.id === "string" ? this.#rowLine(node.id, node.c) : undefined;
		if (row) this.#muted++;
		out.c = node.c.map(child => (isObject(child) ? this.#node(memory, child) : child));
		if (row) {
			this.#muted--;
			out.c = this.#applyRow(memory, row, out.c as JsonObject[]);
		}
		return out;
	}

	// ─── Rows ──────────────────────────────────────────────────────────────

	/** A row whose sentence keycap nodes split, with its Korean; undefined when it has none or no translation. */
	#rowLine(id: string, children: Json[]): RowPlan | undefined {
		if (!children.every(child => isObject(child) && typeof child.id === "string" && typeof child.k === "string")) return undefined;
		const nodes = children as JsonObject[];
		const texts = new Map<number, string>();
		const styles = new Map<number, JsonObject>();
		const keys = new Map<number, CopyKey>();
		nodes.forEach((child, index) => {
			if (child.k !== "text") return;
			const text = rowText(child);
			if (text !== undefined) texts.set(index, text);
			keys.set(index, copyKey(child.p));
			const style = firstSpanStyle(child);
			if (style) styles.set(index, style);
		});
		const line = maskRow(nodes, texts);
		if (!line) return undefined;
		const korean = this.#whole(line.masked);
		const segments = korean === undefined ? undefined : splitRowKorean(korean, line);
		if (!korean || !segments) return undefined;
		const state: RowState = {
			id,
			children: nodes.map(child => ({ id: child.id as string, kind: child.k as string })),
			texts,
			styles,
			keys,
			created: new Map(),
			style: line.style,
		};
		return { state, line, segments, korean };
	}

	/** Props that give text child `index` the copy `text`, in the prop and style omp sent it with. */
	#copy(state: RowState, index: number, text: string): JsonObject {
		const style = state.styles.get(index);
		const key = state.keys.get(index) ?? "text";
		return { [key]: style || key === "spans" ? [{ ...style, t: text }] : text };
	}

	/** Props of a text node this module adds to a row. */
	#created(state: RowState, text: string): JsonObject {
		return { spans: [{ ...state.style, t: text }] };
	}

	/** Puts each gap's Korean into the row's text children, adding a text node where a gap has none. */
	#applyRow(memory: SurfaceMemory, row: RowPlan, children: JsonObject[]): JsonObject[] {
		const { state, line, segments, korean } = row;
		const out = children.map(child => ({ ...child, p: isObject(child.p) ? { ...child.p } : {} }) as JsonObject);
		const inserts = new Map<number, JsonObject[]>();
		line.gaps.forEach((gap, index) => {
			const segment = segments[index] ?? "";
			gap.forEach((childIndex, position) => {
				const text = position === 0 ? segment : "";
				const props = out[childIndex]!.p as JsonObject;
				Object.assign(props, this.#copy(state, childIndex, text));
				if (text === "") props.hidden = true;
			});
			if (gap.length > 0 || segment === "") return;
			const id = `${state.id}~ko${index}`;
			const before = index < line.groups.length ? line.groups[index]![0]! : line.groups[line.groups.length - 1]!.at(-1)! + 1;
			inserts.set(before, [...(inserts.get(before) ?? []), { id, k: "text", p: this.#created(state, segment) }]);
			state.created.set(index, id);
			memory.set(id, { kind: "text" });
		});
		for (const child of state.children) {
			const childState = memory.get(child.id);
			if (childState && child.kind === "text") childState.row = state;
		}
		const result: JsonObject[] = [];
		out.forEach((child, index) => {
			result.push(...(inserts.get(index) ?? []), child);
		});
		result.push(...(inserts.get(out.length) ?? []));
		this.#changed = true;
		this.#report(line.masked, korean);
		return result;
	}

	/** Re-translates a row after omp changed one of its text children; returns the ops that redraw it. */
	#rowUpdate(state: RowState, childId: string, text: string | undefined, otherProps: JsonObject): Json[][] {
		const index = state.children.findIndex(child => child.id === childId);
		if (text !== undefined) state.texts.set(index, text);
		else state.texts.delete(index);
		const stub = state.children.map(child => ({ id: child.id, k: child.kind }) as JsonObject);
		const line = text === undefined ? undefined : maskRow(stub, state.texts);
		const korean = line ? this.#whole(line.masked) : undefined;
		const segments = line && korean ? splitRowKorean(korean, line) : undefined;
		const ops: Json[][] = [];
		const set = (id: string, props: JsonObject) => ops.push(["set", id, id === childId ? { ...otherProps, ...props } : props]);
		this.#changed = true;
		if (!line || !segments) {
			// No whole-line translation for the new text: each piece on its own.
			state.children.forEach((child, childIndex) => {
				if (child.kind !== "text") return;
				const original = state.texts.get(childIndex);
				if (original === undefined) return;
				set(child.id, { ...this.#copy(state, childIndex, this.#text(original)), hidden: false });
			});
			for (const id of state.created.values()) set(id, { ...this.#created(state, ""), hidden: true });
			if (!state.children.some(child => child.id === childId && child.kind === "text") || text === undefined) ops.push(["set", childId, otherProps]);
			return ops;
		}
		this.#report(line.masked, korean!);
		line.gaps.forEach((gap, gapIndex) => {
			const segment = segments[gapIndex] ?? "";
			gap.forEach((childIndex, position) => {
				const value = position === 0 ? segment : "";
				set(state.children[childIndex]!.id, { ...this.#copy(state, childIndex, value), hidden: value === "" });
			});
			const created = state.created.get(gapIndex);
			if (created) set(created, { ...this.#created(state, segment), hidden: segment === "" });
			else if (gap.length === 0 && segment !== "") {
				const id = `${state.id}~ko${gapIndex}`;
				const beforeIndex = gapIndex < line.groups.length ? line.groups[gapIndex]![0]! : line.groups[line.groups.length - 1]!.at(-1)! + 1;
				const before = state.children[beforeIndex]?.id ?? null;
				ops.push(["add", id, state.id, before, { id, k: "text", p: this.#created(state, segment) }]);
				state.created.set(gapIndex, id);
			}
		});
		return ops;
	}

	// ─── Ops ───────────────────────────────────────────────────────────────

	#op(memory: SurfaceMemory, op: Json[]): Json[][] {
		const [name, id] = op;
		switch (name) {
			case "add":
				return [isObject(op[4]) ? [op[0]!, op[1]!, op[2]!, op[3]!, this.#node(memory, op[4])] : op];
			case "set": {
				if (typeof id !== "string" || !isObject(op[2])) return [op];
				const state = memory.get(id);
				if (state?.row && ("text" in op[2] || "spans" in op[2])) {
					const key: CopyKey = "spans" in op[2] ? "spans" : "text";
					const { [key]: value, ...rest } = op[2];
					const row = state.row;
					const index = row.children.findIndex(child => child.id === id);
					row.keys.set(index, key);
					const style = firstSpanStyle({ p: { [key]: value ?? "" } });
					if (style) row.styles.set(index, style);
					else row.styles.delete(index);
					const copy = rowText({ p: { [key]: value ?? "" } });
					return this.#rowUpdate(row, id, copy, this.#props(state.kind, rest, state));
				}
				return [[name, id, this.#props(state?.kind ?? "", op[2], state)]];
			}
			case "text": {
				const state = typeof id === "string" ? memory.get(id) : undefined;
				if (!state || !isCopyKind(state.kind) || typeof op[3] !== "string") return [op];
				if (state.row) {
					const index = state.row.children.findIndex(child => child.id === id);
					const current = state.row.texts.get(index) ?? "";
					return this.#rowUpdate(state.row, id as string, op[2] === "append" ? current + op[3] : op[3], {});
				}
				if (op[2] === "append") {
					// omp appends to its own text; only text this module replaced needs rebuilding.
					if (state.original === undefined) return [op];
					return [this.#replace(state, id as string, state.original + op[3])];
				}
				return [this.#replace(state, id as string, op[3])];
			}
			case "splice": {
				const state = typeof id === "string" ? memory.get(id) : undefined;
				const [, , at, del, text] = op;
				if (typeof at !== "number" || typeof del !== "number" || typeof text !== "string") return [op];
				if (state?.row) {
					const index = state.row.children.findIndex(child => child.id === id);
					const current = state.row.texts.get(index) ?? "";
					return this.#rowUpdate(state.row, id as string, current.slice(0, at) + text + current.slice(at + del), {});
				}
				if (state?.original === undefined) return [op];
				return [this.#replace(state, id as string, state.original.slice(0, at) + text + state.original.slice(at + del))];
			}
			case "del":
				if (typeof id === "string") memory.delete(id);
				return [op];
			default:
				return [op];
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
		const ops = body.ops.flatMap(op => (Array.isArray(op) ? this.#op(memory, op) : [op]));
		return this.#changed ? { ...body, ops } : undefined;
	}
}

/** Props holding a record whose keys are display labels (`facts: { Model: "…" }`). */
const RECORD_LABEL_PROPS: Record<string, true> = { facts: true };


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
