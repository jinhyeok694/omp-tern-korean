import * as path from "node:path";
import { showPlaceholders } from "./sequence.ts";

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
	/** Length of the English without placeholders: more literal text, more specific. */
	literal: number;
	/** Written in the catalog, not derived from another entry. */
	explicit: boolean;
}

/** Joiners omp puts between independent parts of one line. */
const SEPARATORS = [" · ", " — ", " – "] as const;

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const WEEKDAYS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
const WEEKDAY = "(?:(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun),? )?";
const MONTH = "(?<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const YEAR_TIME = "(?:,? (?<year>\\d{4}))?(?:,? (?<time>\\d{1,2}:\\d{2}))?";
const DATES = [
	new RegExp(`^${WEEKDAY}(?<day>\\d{1,2}) ${MONTH}${YEAR_TIME}$`),
	new RegExp(`^${WEEKDAY}${MONTH} (?<day>\\d{1,2})${YEAR_TIME}$`),
];

const EMBEDDED_DATE = new RegExp(
	"\\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),? )?(?:\\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{1,2})\\b(?:,? \\d{4})?(?:,? \\d{1,2}:\\d{2})?",
	"g",
);

/** Every English date inside `text` in Korean order (a date a template's placeholders carried into the Korean). */
export function localizeDates(text: string): string {
	return text.replace(EMBEDDED_DATE, date => koreanDate(date) ?? date);
}

/** omp's English dates (`Wed 7 Oct`, `Sat 7 Nov 2026, 09:32`, `Nov 7`) in Korean order. */
export function koreanDate(text: string): string | undefined {
	for (const pattern of DATES) {
		const date = pattern.exec(text)?.groups;
		if (!date) continue;
		const { weekday, day, month, year, time } = date;
		return [year ? `${year}년` : "", `${MONTHS[month!]}월 ${Number(day)}일`, weekday ? `(${WEEKDAYS[weekday]})` : "", time ?? ""]
			.filter(Boolean)
			.join(" ");
	}
	return undefined;
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
	// Explicit templates win over derived ones of the same English.
	for (const english in file.templates ?? {}) templateSources.set(normalize(english), file.templates![english]!);
	const explicitTemplates = new Set(templateSources.keys());
	for (const [english, korean] of derived.templates) if (!templateSources.has(english)) templateSources.set(english, korean);
	const templates: Template[] = [];
	for (const [english, korean] of templateSources) {
		const parts = english.split(/(\{\d+\})/);
		const last = parts.at(-1) === "" ? parts.length - 2 : -1;
		const source = parts
			// A value never spans a part separator: "{0} requests" must not swallow "Wed 7 Oct · $0.02 · 2".
			// Nor a sentence end: "{0} suspends the loop." must not swallow "Loop mode enabled. ⇧". A value
			// that ends the template may hold sentences: "Retry failed after {0} attempts: {1}" with an error.
			.map((part, index) =>
				/^\{\d+\}$/.test(part)
					? index === last
						? "((?:(?! · | — | – ).)+?)"
						: "((?:(?! · | — | – |[.!?] ).)+?)"
					: part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
			)
			.join("");
		const anchor = parts
			.filter(part => !/^\{\d+\}$/.test(part))
			.map(part => part.trim())
			.reduce((a, b) => (b.length > a.length ? b : a), "");
		templates.push({
			pattern: new RegExp(`^${source}$`, "s"),
			anchor,
			korean,
			literal: english.replace(/\{\d+\}/g, "").length,
			explicit: explicitTemplates.has(english),
		});
	}
	// The most specific template wins: explicit before derived, then the one with the most literal text
	// ("{0} entries hidden by the current filter {1}. Press {2} to show all, …" before "… filter {1}").
	templates.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.literal - a.literal);
	const values = new Map(Object.entries(file.values ?? {}));
	const cache = new Map<string, string | null>();
	const misses = new Set<string>();

	/** `core` through the templates; `nested` when `core` is another template's value. */
	const fromTemplates = (core: string, nested: boolean): string | undefined => {
		if (core.length > TEMPLATE_MAX_LENGTH) return undefined;
		for (const template of templates) {
			if (!core.includes(template.anchor)) continue;
			// A value is matched only by templates with words (`{0} ago`), never by bare shapes (`{0} {1}`).
			if (nested && !/[A-Za-z]{2}/.test(template.anchor)) continue;
			const match = template.pattern.exec(core);
			if (!match) continue;
			return template.korean.replace(/\{(\d+)\}/g, (_all, index: string) => {
				const value = match[Number(index) + 1] ?? "";
				// A placeholder that is itself UI copy translates too: "Updated {0}" with "51s ago",
				// "{0} ago" with "2 minutes". Dates are not converted here: a template may split one
				// date over several values (`Resets {0} {1}, {2}`); `localizeDates` converts the result.
				const own = exact.get(value) ?? values.get(value);
				if (own !== undefined || nested || !LETTERS.test(value) || HANGUL.test(value)) return own ?? value;
				return fromTemplates(value, true) ?? value;
			});
		}
		return undefined;
	};

	const lookup = (core: string): string | undefined => {
		const hit = exact.get(core) ?? koreanDate(core);
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
		const templated = fromTemplates(core, false);
		if (templated !== undefined) return templated;
		// A session notice drawn as `${source}: ${message}` (`prewalk: Prewalk: armed for …`): the
		// source id stays, the message translates.
		const tagged = /^([a-z][\w-]*): (?=\S)/.exec(core);
		if (tagged) {
			const rest = core.slice(tagged[0].length);
			const korean = HANGUL.test(rest) ? undefined : lookup(rest);
			if (korean !== undefined) return `${tagged[0]}${korean}`;
		}
		// A status line joined from parts (`2.9s · 18K tok · <$0.01 this turn`), each of which may be
		// present or not: translate part by part.
		for (const separator of SEPARATORS) {
			if (!core.includes(separator)) continue;
			let changed = false;
			const parts = core.split(separator).map(part => {
				const partCore = normalize(part);
				const korean = partCore.length === 0 || HANGUL.test(partCore) ? undefined : lookup(partCore);
				if (korean === undefined) return part;
				changed = true;
				return part.replace(part.trim(), () => korean);
			});
			if (changed) return parts.join(separator);
		}
		// A notice omp joins from whole sentences (`Loop mode enabled. ` + hint): sentence by sentence.
		const sentences = core.split(/(?<=[.!?])\s+(?=[^\sa-z])/);
		if (sentences.length > 1) {
			let changed = false;
			const out = sentences.map(sentence => {
				const korean = HANGUL.test(sentence) ? undefined : lookup(normalize(sentence));
				if (korean === undefined) return sentence;
				changed = true;
				return korean;
			});
			if (changed) return out.join(" ");
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
			const result = korean === undefined ? undefined : `${match[1]}${localizeDates(korean)}${match[3]}`;
			cache.set(text, result ?? null);
			if (result === undefined && capture && LETTERS.test(core) && !HANGUL.test(core)) misses.add(showPlaceholders(core));
			return result;
		},
	};
}

function normalize(text: string): string {
	return text.trim().replace(/\.\.\.$/, "…");
}
