/**
 * Measures what stays English on real screens.
 *
 *   bun tools/residual.ts <frames.log…> [--out candidates.json] [--all]
 *
 * Replays TSP writes recorded with `OMP_KO_DUMP=<file>` through the translator with this repo's
 * catalog, and reports every UI text unit (a string, or a line drawn in pieces) whose shown text
 * still holds English words: untranslated units, and units mixing Korean with leftover English
 * (a sentence translated in fragments). Words that stay English on purpose are not counted: glossary
 * `keep`/`untranslated` terms, code, paths, flags, identifiers, numbers and units, and short
 * product names listed in `catalog/skip.json`.
 *
 * `--out` writes the units as translation candidates, with runtime numbers turned into `{n}`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createCatalog, parseCatalog } from "../omp/catalog.ts";
import { DEFAULT_APC_LIMIT, FrameTranslator, translateWrite } from "../omp/tsp.ts";

const ROOT = path.join(import.meta.dir, "..");

interface Glossary {
	keep: string[];
	untranslated: string[];
}

export interface Unit {
	before: string;
	after: string;
	count: number;
	words: string[];
	/**
	 * `english`: nothing translated. `fragment`: Korean next to a run of two or more English words,
	 * a sentence translated in pieces. `term`: Korean with isolated English words (names, values).
	 */
	kind: "english" | "fragment" | "term";
}

/** Units and words always shown in English: identifiers, units, and words the glossary keeps. */
const UNIT_WORDS = new Set(["ms", "tok", "toks", "ttft", "ctx", "xhigh", "xlow", "min", "max", "px", "KB", "MB", "GB", "vs", "e.g", "i.e"]);

function ignoredWords(glossary: Glossary, skip: string[]): Set<string> {
	const words = new Set<string>(UNIT_WORDS);
	for (const term of [...glossary.keep, ...glossary.untranslated]) for (const word of term.split(/\s+/)) words.add(word);
	// Short Title Case entries of the skip list are product, provider and plan names.
	for (const entry of skip) {
		const parts = entry.split(/\s+/);
		if (parts.length <= 4 && parts.every(part => /^[A-Z0-9(][\w().+/-]*$/.test(part))) for (const part of parts) words.add(part.replace(/[()]/g, ""));
	}
	return words;
}

/**
 * English words in `text` that a Korean user would see untranslated, and whether two of them stand
 * next to each other (no Korean word between).
 */
export function residue(text: string, ignore: ReadonlySet<string>): { words: string[]; run: boolean } {
	const stripped = text
		.replace(/\{\d+\}/g, " | ")
		.replace(/`[^`]*`/g, " | ")
		.replace(/https?:\/\/\S+/g, " | ")
		.replace(/\S+@\S+/g, " | ")
		.replace(/\S*[\\/~]\S*/g, " | ")
		.replace(/\S+=\S+/g, " | ")
		.replace(/(^|[\s(])--?[A-Za-z][\w-]*/g, " | ")
		.replace(/\$[A-Z_][A-Z0-9_]*/g, " | ")
		.replace(/\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{1,5}\b/g, " | ")
		.replace(/\b[a-z]\w*(?:\.\w+)+\b/g, " | ") // setting keys: security.enabled
		.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, " | ") // snake_case ids: tool_execution_start
		// Command syntax: `/mcp remove <name> [--scope project|user]`.
		.replace(/<[^<>\s]+>|\[--?[^\]]*\]/g, " | ")
		.replace(/(^|\s)\/[a-z][\w-]*(?: [a-z][\w-]*)?/g, " | ");
	const tokens = stripped.match(/[A-Za-z][A-Za-z'’-]*[A-Za-z]|[\u3131-\u318e\uac00-\ud7a3]+|[|:;()[\]{}]/g) ?? [];
	const words: string[] = [];
	let runWords: string[] = [];
	let run = false;
	for (const token of tokens) {
		const english =
			/^[A-Za-z]/.test(token) &&
			!ignore.has(token) &&
			!ignore.has(token.toLowerCase()) &&
			!/^[A-Z0-9]+$/.test(token) && // MCP, API, ACP
			!/[a-z][A-Z]/.test(token) && // camelCase
			!(/^[a-z]+-[a-z-]+$/.test(token) && token.length > 12); // kebab-case ids
		if (!english) {
			runWords = [];
			continue;
		}
		words.push(token);
		runWords.push(token);
		// Two English words in a row, at least one lowercase: a phrase left in English. Capitalized
		// runs (`Knight Rider`, `Glyph Protocol`) are names.
		if (runWords.length >= 2 && runWords.some(word => /^[a-z]/.test(word))) run = true;
	}
	return { words, run };
}

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
const DAY = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g;
const NUMBER =
	/(?<![\w{])[$<>~≈+-]?\d[\d.,:]*(?:\s?(?:K|M|B|%|ms|s|m|h|d|w|tokens?|tok|x))?(?:\d+(?:d|h|m|s))*(?![\w}])/g;

/** Turns runtime values (numbers, durations, costs, dates) and placeholders into `{0}`, `{1}`… in order. */
export function generalize(text: string): string {
	let index = 0;
	return text
		.replace(DAY, "\u0000")
		.replace(/\{\d+\}/g, "\u0000")
		// Icon glyphs (Nerd Font private-use characters) change with the symbol preset.
		.replace(/[\ue000-\uf8ff]|[\udb80-\udbff][\udc00-\udfff]/g, "\u0000")
		.replace(NUMBER, "\u0000")
		.replace(/\u0000/g, () => `{${index++}}`);
}

export function measure(frames: string[], catalogText: string): Unit[] {
	const catalog = createCatalog(parseCatalog(catalogText), false);
	const units = new Map<string, Unit>();
	const glossary = JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "glossary.json"), "utf8")) as Glossary;
	const skip = (JSON.parse(fs.readFileSync(path.join(ROOT, "catalog", "skip.json"), "utf8")) as { strings: string[] }).strings;
	const allowed = (JSON.parse(fs.readFileSync(path.join(import.meta.dir, "residual-allow.json"), "utf8")) as { lines: string[] }).lines;
	const skipSet = new Set([...skip, ...allowed]);
	const ignore = ignoredWords(glossary, skip);
	const translator = new FrameTranslator(
		text => catalog.translate(text),
		(wholeBefore, wholeAfter) => {
			// The catalog translates text of several lines line by line: report the lines.
			const beforeLines = wholeBefore.split("\n");
			const afterLines = wholeAfter.split("\n");
			const pairs = beforeLines.length === afterLines.length ? beforeLines.map((line, index) => [line, afterLines[index]!]) : [[wholeBefore, wholeAfter]];
			for (const [rawBefore, after] of pairs) {
				const before = rawBefore!.trim();
				if (before.length === 0 || skipSet.has(before)) continue;
				// A lone identifier-like token (`center`, `provider:anthropic:225`) is a value, not copy.
				if (/^[a-z0-9:_&.#-]+$/.test(before) || (/\d/.test(before) && !/\s/.test(before))) continue;
				const { words, run } = residue(after!, ignore);
				if (words.length === 0) continue;
				const key = `${before}\u0000${after}`;
				const unit = units.get(key);
				if (unit) unit.count++;
				else units.set(key, { before, after: after!.trim(), count: 1, words, kind: !HANGUL.test(after!) ? "english" : run ? "fragment" : "term" });
			}
		},
	);
	for (const data of frames) translateWrite(data, translator, DEFAULT_APC_LIMIT);
	const order = { fragment: 0, english: 1, term: 2 } as const;
	return [...units.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count);
}

const LABEL = { fragment: "조각", english: "영어", term: "용어" } as const;

if (import.meta.main) {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf("--out");
	const out = outIndex === -1 ? undefined : args.splice(outIndex, 2)[1];
	const all = args.includes("--all");
	const files = args.filter(arg => !arg.startsWith("--"));
	if (files.length === 0) {
		console.log(fs.readFileSync(import.meta.path, "utf8").split("\n").slice(1, 15).join("\n"));
		process.exit(1);
	}
	const frames = files.map(file => fs.readFileSync(file, "utf8"));
	const units = measure(frames, fs.readFileSync(path.join(ROOT, "catalog", "ko.json"), "utf8"));
	const count = (kind: Unit["kind"]) => units.filter(unit => unit.kind === kind).length;
	console.log(`조각으로 번역된 줄 ${count("fragment")}개, 영어 그대로인 줄 ${count("english")}개, 영어 낱말이 섞인 줄 ${count("term")}개`);
	for (const unit of all ? units : units.slice(0, 80)) {
		console.log(`${LABEL[unit.kind]} ×${unit.count} [${unit.words.join(", ")}]\n  en: ${JSON.stringify(unit.before)}\n  ko: ${JSON.stringify(unit.after)}`);
	}
	if (out) {
		const seen = new Set<string>();
		const candidates = [];
		for (const unit of units) {
			const en = generalize(unit.before).trim();
			if (seen.has(en)) continue;
			seen.add(en);
			candidates.push({ en, kind: /\{\d+\}/.test(en) ? "template" : "exact", files: [], contexts: ["runtime capture"], example: unit.before, shown: unit.after });
		}
		fs.writeFileSync(out, `${JSON.stringify(candidates, null, "\t")}\n`);
		console.log(`${candidates.length} candidates → ${out}`);
	}
}
