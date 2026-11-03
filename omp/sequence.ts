/**
 * Whole-line translation of text omp draws in pieces.
 *
 * omp often builds one line out of several spans or nodes: words around a keycap (`Press [enter] to
 * begin`), a number styled apart (`[37%] left`), a code span inside a sentence, icons between words.
 * Translating each piece alone gives Korean in English word order, or leaves pieces untranslated.
 * Here a line is masked into one string where every piece that must stay verbatim becomes a
 * placeholder character, the whole string is translated as one catalog entry
 * (`Press {0} to begin` → `시작하려면 {0} 키를 누르십시오`), and the line is rebuilt from the Korean,
 * putting the verbatim pieces back where the Korean places them.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * Placeholders are Unicode noncharacters U+FDD0–U+FDEF: they never occur in real text, and the
 * catalog's template patterns capture them like any other text.
 */
const PLACEHOLDER_BASE = 0xfdd0;
export const MAX_PLACEHOLDERS = 32;
const PLACEHOLDER_CHAR = /[\ufdd0-\ufdef]/;

export function placeholder(index: number): string {
	return String.fromCharCode(PLACEHOLDER_BASE + index);
}

function placeholderIndex(char: string): number | undefined {
	const code = char.charCodeAt(0);
	return code >= PLACEHOLDER_BASE && code < PLACEHOLDER_BASE + MAX_PLACEHOLDERS ? code - PLACEHOLDER_BASE : undefined;
}

/** `{n}` for every placeholder character: how masked text is shown in reports and captures. */
export function showPlaceholders(text: string): string {
	return text.replace(/[\ufdd0-\ufdef]/g, char => `{${char.charCodeAt(0) - PLACEHOLDER_BASE}}`);
}

export function hasPlaceholder(text: string): boolean {
	return PLACEHOLDER_CHAR.test(text);
}

/** Span style tokens whose text is a keycap, code, a path, a number, a link or a glyph: never translated. */
export const VERBATIM_SPAN_TOKENS: Record<string, true> = {
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

const SPAN_FIELDS: Record<string, true> = { t: true, s: true, fx: true, href: true };

export function isObject(value: Json | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether `value` is a styled span. Not a type guard: every JSON object has the span's type. */
export function isSpan(value: Json): boolean {
	return isObject(value) && typeof value.t === "string" && Object.keys(value).every(field => SPAN_FIELDS[field] === true);
}

function hasToken(span: JsonObject, token: string): boolean {
	return typeof span.s === "string" && span.s.split(" ").includes(token);
}

export function isVerbatimSpan(span: JsonObject): boolean {
	return typeof span.s === "string" && span.s.split(" ").some(token => VERBATIM_SPAN_TOKENS[token] === true);
}

/** The style a span carries, without its text. */
function styleOf(span: JsonObject | undefined): JsonObject {
	const out: JsonObject = {};
	if (!span) return out;
	if (span.s !== undefined) out.s = span.s;
	if (span.fx !== undefined) out.fx = span.fx;
	if (span.href !== undefined) out.href = span.href;
	return out;
}

const sameStyle = (a: JsonObject, b: JsonObject): boolean => a.s === b.s && a.fx === b.fx && a.href === b.href;

interface Group {
	spans: JsonObject[];
	icon: boolean;
}

export interface MaskedSpans {
	/** The line with one placeholder per group of verbatim spans. */
	masked: string;
	groups: Group[];
	/** Per gap between groups, the first copy span in it: the style Korean text in that gap takes. */
	gapStyles: (JsonObject | undefined)[];
	/** Number of copy spans with letters. */
	copySpans: number;
	/** Whether all copy spans share one style, so a whole-line translation loses no emphasis. */
	uniformStyle: boolean;
	/** Style of the first code span when code spans were kept in the masked text as backticks. */
	codeStyle?: JsonObject;
}

/**
 * Masks a span array. Adjacent verbatim spans (with only whitespace between) form one group, since
 * the catalog writes a run of keycaps (`Alt+A`, `↑ ↓`) as one placeholder. With `codeAsBackticks`,
 * code spans stay in the text wrapped in backticks, matching catalog entries written from Markdown
 * source (`` gate it with `--until '<cmd>'` ``).
 */
export function maskSpans(spans: readonly JsonObject[], codeAsBackticks: boolean): MaskedSpans | undefined {
	const groups: Group[] = [];
	const gapStyles: (JsonObject | undefined)[] = [undefined];
	let masked = "";
	let pending: JsonObject[] = [];
	let copySpans = 0;
	let firstStyle: JsonObject | undefined;
	let uniformStyle = true;
	let codeStyle: JsonObject | undefined;
	const flush = () => {
		for (const span of pending) {
			const text = span.t as string;
			if (groups[groups.length - 1]?.icon && masked.endsWith(placeholder(groups.length - 1)) && /^\S/.test(text)) masked += " ";
			masked += text;
			if (text.trim().length > 0 && gapStyles[groups.length] === undefined) gapStyles[groups.length] = span;
		}
		pending = [];
	};
	for (const span of spans) {
		if (codeAsBackticks && hasToken(span, "code") && !hasToken(span, "key")) {
			codeStyle ??= styleOf(span);
			pending.push({ t: `\`${span.t as string}\``, ...styleOf(span) });
			continue;
		}
		if (isVerbatimSpan(span)) {
			const last = groups[groups.length - 1];
			const onlySpace = pending.every(item => (item.t as string).trim().length === 0);
			if (last && onlySpace && masked.endsWith(placeholder(groups.length - 1))) {
				last.spans.push(...pending, span);
				last.icon &&= hasToken(span, "icon");
				pending = [];
				continue;
			}
			flush();
			if (groups.length >= MAX_PLACEHOLDERS) return undefined;
			const icon = hasToken(span, "icon");
			// The terminal spaces icons from their neighbours, so omp sends none; the catalog writes
			// them (`… session; {0} cycles levels`).
			if (icon && masked.length > 0 && !/\s$/.test(masked)) masked += " ";
			masked += placeholder(groups.length);
			groups.push({ spans: [span], icon });
			gapStyles.push(undefined);
			continue;
		}
		const text = span.t as string;
		if (/[A-Za-z]/.test(text)) {
			copySpans++;
			const style = styleOf(span);
			if (!firstStyle) firstStyle = style;
			else if (!sameStyle(firstStyle, style)) uniformStyle = false;
		}
		pending.push(span);
	}
	flush();
	return { masked, groups, gapStyles, copySpans, uniformStyle, codeStyle };
}

/** Rebuilds spans from the Korean for a masked line. */
export function rebuildSpans(korean: string, masked: MaskedSpans): JsonObject[] {
	const out: JsonObject[] = [];
	const fallbackStyle = masked.gapStyles.find(style => style !== undefined);
	let gap = 0;
	let literal = "";
	let previousIcon = false;
	const pushLiteral = (nextIcon: boolean) => {
		let text = literal;
		literal = "";
		// The terminal spaces icons from their neighbours itself.
		if (previousIcon) text = text.replace(/^\s+/, "");
		if (nextIcon) text = text.replace(/\s+$/, "");
		if (text.length === 0) return;
		const style = styleOf(masked.gapStyles[Math.min(gap, masked.gapStyles.length - 1)] ?? fallbackStyle);
		if (masked.codeStyle) {
			// Backticked runs in the Korean become code spans again.
			const parts = text.split(/(`[^`]+`)/);
			for (const part of parts) {
				if (part.length === 0) continue;
				if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push({ t: part.slice(1, -1), ...masked.codeStyle });
				else out.push({ t: part, ...style });
			}
			return;
		}
		out.push({ t: text, ...style });
	};
	for (const char of korean) {
		const index = placeholderIndex(char);
		const group = index === undefined ? undefined : masked.groups[index];
		if (!group) {
			literal += char;
			continue;
		}
		pushLiteral(group.icon);
		out.push(...group.spans);
		previousIcon = group.icon;
		gap = Math.min((index ?? 0) + 1, masked.gapStyles.length - 1);
	}
	pushLiteral(false);
	return out;
}

// ─── Rows: a line drawn as sibling nodes ───────────────────────────────────

/** Kinds that may sit at either end of a row without being part of its sentence. */
const ROW_EDGE_KINDS: Record<string, true> = { icon: true, spinner: true, elapsed: true };
/**
 * Kinds drawn inline in a row's sentence, kept as `{n}`: keycaps, small charts (`Less [scale] More`) and
 * live counters (`Updated [elapsed] ago`; at an end of the row a counter is an edge instead).
 */
const ROW_HOLE_KINDS: Record<string, true> = { kbd: true, chart: true, elapsed: true };

export interface RowLine {
	/** Index range of the children that form the sentence. */
	from: number;
	to: number;
	masked: string;
	/** Per placeholder, the child indices of its keycaps. */
	groups: number[][];
	/** Per gap, the indices of the text children in it. */
	gaps: number[][];
	/** Style for text the Korean puts in a gap that has no text node yet. */
	style: JsonObject;
}

/** The prop a text node keeps its copy in: `spans` (styled pieces) or `text` (a string or pieces). */
export type CopyKey = "text" | "spans";

export function copyKey(props: Json | undefined): CopyKey {
	return isObject(props) && Array.isArray(props.spans) ? "spans" : "text";
}

/** The copy of a `text` child as one string, or undefined when it holds verbatim spans. */
export function rowText(child: JsonObject): string | undefined {
	const props = isObject(child.p) ? child.p : undefined;
	const text = props?.[copyKey(props)];
	if (typeof text === "string") return text;
	if (!Array.isArray(text) || !text.every(isSpan)) return undefined;
	if (text.some(span => isVerbatimSpan(span as JsonObject))) return undefined;
	return text.map(span => (span as JsonObject).t as string).join("");
}

/** Style of a text child's first span; undefined when its copy is a plain string. */
export function firstSpanStyle(child: JsonObject): JsonObject | undefined {
	const props = isObject(child.p) ? child.p : undefined;
	const text = props?.[copyKey(props)];
	return Array.isArray(text) && isObject(text[0]) && isSpan(text[0]) ? styleOf(text[0]) : undefined;
}

/**
 * Masks a row whose sentence is split by keycap or chart nodes (`[kbd] to retry`, `Press [kbd] to begin`,
 * `Less [chart] More`).
 * `texts` gives each text child's current copy (omp's English), by child index.
 */
export function maskRow(children: readonly JsonObject[], texts: ReadonlyMap<number, string>): RowLine | undefined {
	let from = 0;
	let to = children.length;
	while (from < to && ROW_EDGE_KINDS[children[from]!.k as string] === true) from++;
	while (to > from && ROW_EDGE_KINDS[children[to - 1]!.k as string] === true) to--;
	const groups: number[][] = [];
	const gaps: number[][] = [[]];
	const pieces: string[] = [];
	let style: JsonObject | undefined;
	let hasCopy = false;
	for (let index = from; index < to; index++) {
		const child = children[index]!;
		if (ROW_HOLE_KINDS[child.k as string] === true) {
			const last = groups[groups.length - 1];
			if (last && gaps[groups.length]!.every(textIndex => (texts.get(textIndex) ?? "").trim().length === 0)) {
				last.push(index);
				continue;
			}
			if (groups.length >= MAX_PLACEHOLDERS) return undefined;
			pieces.push(placeholder(groups.length));
			groups.push([index]);
			gaps.push([]);
			continue;
		}
		if (child.k !== "text") return undefined;
		const text = texts.get(index);
		if (text === undefined) return undefined;
		gaps[groups.length]!.push(index);
		style ??= firstSpanStyle(child) ?? {};
		if (/[A-Za-z]/.test(text)) hasCopy = true;
		if (text.trim().length > 0) pieces.push(text.trim());
	}
	if (groups.length === 0 || !hasCopy) return undefined;
	return { from, to, masked: pieces.join(" "), groups, gaps, style: style ?? {} };
}

/** Per gap, the Korean text for it; undefined when the Korean reorders or drops keycaps. */
export function splitRowKorean(korean: string, line: RowLine): string[] | undefined {
	const segments: string[] = [""];
	let expected = 0;
	for (const char of korean) {
		const index = placeholderIndex(char);
		if (index === undefined) {
			segments[segments.length - 1] += char;
			continue;
		}
		if (index !== expected) return undefined;
		expected++;
		segments.push("");
	}
	if (expected !== line.groups.length) return undefined;
	return segments.map(segment => segment.trim());
}
