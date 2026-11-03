import * as path from "node:path";

/**
 * The translation catalog: exact UI strings and `{0}`-placeholder templates, English → Korean.
 * Lookups ignore surrounding whitespace and treat `...` like `…`, then put the whitespace back.
 */
export interface CatalogFile {
	version: 1;
	/** Grows with every published change; the newer of the bundled and downloaded catalogs wins. */
	revision: number;
	strings: Record<string, string>;
	templates?: Record<string, string>;
	/**
	 * Words translated only when they fill a template placeholder ("Fast mode {0}." with `enabled`).
	 * Alone they stay English: a bare lowercase word is usually an identifier.
	 */
	values?: Record<string, string>;
}

export interface Catalog {
	readonly size: number;
	readonly revision: number;
	translate(text: string): string | undefined;
	/** Strings looked up without a translation, when capture is on. */
	readonly misses: ReadonlySet<string>;
}

interface Template {
	pattern: RegExp;
	/** The template's longest literal run: a cheap `includes` check before the regex. */
	anchor: string;
	/** Korean with `{n}` placeholders. */
	korean: string;
}

const CACHE_LIMIT = 20_000;
/** Longer text is content, never a UI string worth a template scan. */
const TEMPLATE_MAX_LENGTH = 600;
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
const LETTERS = /[A-Za-z].*[A-Za-z]/;

/** Parses and validates catalog JSON; throws on anything that is not a version 1 catalog. */
export function parseCatalog(text: string): CatalogFile {
	const parsed: unknown = JSON.parse(text);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("version" in parsed) ||
		parsed.version !== 1 ||
		!("strings" in parsed) ||
		!parsed.strings ||
		typeof parsed.strings !== "object"
	)
		throw new Error("not a version 1 catalog");
	const revision = "revision" in parsed && typeof parsed.revision === "number" ? parsed.revision : 0;
	const templates = "templates" in parsed && parsed.templates && typeof parsed.templates === "object" ? parsed.templates : {};
	const values = "values" in parsed && parsed.values && typeof parsed.values === "object" ? parsed.values : {};
	return {
		version: 1,
		revision,
		strings: onlyStrings(parsed.strings),
		templates: onlyStrings(templates),
		values: onlyStrings(values),
	};
}

function onlyStrings(record: object): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) if (typeof value === "string" && value.length > 0) out[key] = value;
	return out;
}

export function bundledCatalogPath(): string {
	return path.join(import.meta.dir, "..", "catalog", "ko.json");
}

/** `Label: rest` — omp's Tern views often show `rest` alone (the autocomplete row already names the command). */
const LABEL_PREFIX = /^([A-Z][\w /-]{0,30}): (\S[\s\S]*)$/;
/** A fragment between placeholders is worth its own entry only when it is a phrase, not a word. */
const PHRASE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;

/**
 * Entries derived from the catalog for text omp splits apart when drawing natively:
 * - `Label: rest` also translates `rest`;
 * - a template's literal runs between placeholders (a key hint drawn as a keycap splits the line)
 *   translate on their own when the Korean keeps the placeholders in the same order.
 * Explicit entries always win.
 */
function derive(file: CatalogFile): { strings: Map<string, string>; templates: Map<string, string> } {
	const strings = new Map<string, string>();
	const templates = new Map<string, string>();
	const add = (english: string, korean: string) => {
		const en = normalize(english);
		const ko = korean.trim();
		if (en.length < 4 || ko.length === 0 || !/[A-Za-z]{3,}/.test(en.replace(/\{\d+\}/g, ""))) return;
		if (!/\{\d+\}/.test(en)) strings.set(en, ko);
		// A derived template must be a phrase: "{0} saved" would turn any "… saved" into Korean.
		else if (PHRASE.test(en.replace(/\{\d+\}/g, " "))) templates.set(en, ko);
	};
	const splitLabel = (english: string, korean: string) => {
		const en = LABEL_PREFIX.exec(english);
		const colon = korean.indexOf(": ");
		if (en && colon > 0) add(en[2]!, korean.slice(colon + 2));
	};
	for (const english in file.strings) splitLabel(english, file.strings[english]!);
	for (const english in file.templates ?? {}) {
		const korean = file.templates![english]!;
		splitLabel(english, korean);
		const enHolders = english.match(/\{\d+\}/g) ?? [];
		const koHolders = korean.match(/\{\d+\}/g) ?? [];
		if (enHolders.join() !== koHolders.join()) continue;
		const enParts = english.split(/\{\d+\}/);
		const koParts = korean.split(/\{\d+\}/);
		enParts.forEach((part, index) => {
			if (PHRASE.test(part) && koParts[index]?.trim()) add(part, koParts[index]!);
		});
	}
	return { strings, templates };
}

export function createCatalog(file: CatalogFile, capture: boolean): Catalog {
	const exact = new Map<string, string>();
	const templateSources = new Map<string, string>();
	const derived = derive(file);
	for (const [english, korean] of derived.strings) exact.set(english, korean);
	for (const english in file.strings) exact.set(normalize(english), file.strings[english]!);
	// Explicit templates are tried first; derived ones only fill gaps.
	for (const english in file.templates ?? {}) templateSources.set(normalize(english), file.templates![english]!);
	for (const [english, korean] of derived.templates) if (!templateSources.has(english)) templateSources.set(english, korean);
	const templates: Template[] = [];
	for (const [english, korean] of templateSources) {
		const parts = english.split(/(\{\d+\})/);
		const source = parts
			.map(part => (/^\{\d+\}$/.test(part) ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
			.join("");
		const anchor = parts.filter(part => !/^\{\d+\}$/.test(part)).reduce((a, b) => (b.length > a.length ? b : a), "");
		templates.push({ pattern: new RegExp(`^${source}$`, "s"), anchor, korean });
	}
	const values = new Map(Object.entries(file.values ?? {}));
	const cache = new Map<string, string | null>();
	const misses = new Set<string>();

	const lookup = (core: string): string | undefined => {
		const hit = exact.get(core);
		if (hit !== undefined) return hit;
		// A tooltip or notice of several lines: translate line by line.
		if (core.includes("\n")) {
			let changed = false;
			const lines = core.split("\n").map(line => {
				const lineCore = normalize(line);
				const korean = lineCore.length === 0 ? undefined : lookup(lineCore);
				if (korean === undefined) return line;
				changed = true;
				return line.replace(line.trim(), () => korean);
			});
			return changed ? lines.join("\n") : undefined;
		}
		if (core.length > TEMPLATE_MAX_LENGTH) return undefined;
		for (const template of templates) {
			if (!core.includes(template.anchor)) continue;
			const match = template.pattern.exec(core);
			if (!match) continue;
			return template.korean.replace(/\{(\d+)\}/g, (_all, index: string) => {
				const value = match[Number(index) + 1] ?? "";
				// A placeholder that is itself UI copy ("{0} ago" with "2 minutes") translates too.
				return exact.get(value) ?? values.get(value) ?? value;
			});
		}
		return undefined;
	};

	return {
		size: exact.size + templates.length,
		revision: file.revision,
		misses,
		translate(text) {
			const cached = cache.get(text);
			if (cached !== undefined) return cached ?? undefined;
			const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
			const core = normalize(match[2]!);
			const korean = core.length === 0 || HANGUL.test(core) ? undefined : lookup(core);
			if (cache.size >= CACHE_LIMIT) cache.clear();
			const result = korean === undefined ? undefined : `${match[1]}${korean}${match[3]}`;
			cache.set(text, result ?? null);
			if (result === undefined && capture && LETTERS.test(core) && !HANGUL.test(core)) misses.add(core);
			return result;
		},
	};
}

function normalize(text: string): string {
	return text.trim().replace(/\.\.\.$/, "…");
}
