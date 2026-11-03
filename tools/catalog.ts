/**
 * Catalog maintenance.
 *
 *   bun tools/catalog.ts check [file…] [--base <git-ref>]   validate translations (default: both catalogs)
 *   bun tools/catalog.ts coverage [--report out.md]          untranslated source strings
 *   bun tools/catalog.ts slice --count N --out <dir>         split untranslated strings for translators
 *   bun tools/catalog.ts merge <file…>                       add `{ en: ko }` maps to catalog/ko.json
 *   bun tools/catalog.ts merge-tern <file…>                  add `{ id: ko }` maps to tern-plugin/ko.json
 *   bun tools/catalog.ts bump                                raise catalog revisions
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceFile } from "./extract-omp.ts";

const ROOT = path.join(import.meta.dir, "..");
const OMP_CATALOG = path.join(ROOT, "catalog", "ko.json");
const OMP_SOURCE = path.join(ROOT, "catalog", "source.json");
const TERN_CATALOG = path.join(ROOT, "tern-plugin", "ko.json");
const TERN_SOURCE = path.join(ROOT, "tern-plugin", "source.json");
const GLOSSARY = path.join(ROOT, "catalog", "glossary.json");
/** Extracted strings reviewed and left out: not shown to users, or English on purpose. */
const SKIP = path.join(ROOT, "catalog", "skip.json");

interface SkipFile {
	version: 1;
	strings: string[];
}

interface OmpCatalog {
	version: 1;
	revision: number;
	strings: Record<string, string>;
	templates: Record<string, string>;
	/** Words translated only inside template placeholders (see omp/catalog.ts). */
	values?: Record<string, string>;
}

function writeOmpCatalog(catalog: OmpCatalog): void {
	writeJson(OMP_CATALOG, {
		version: 1,
		revision: catalog.revision,
		strings: sortRecord(catalog.strings),
		templates: sortRecord(catalog.templates),
		values: sortRecord(catalog.values ?? {}),
	});
}

interface TernCatalog {
	version: 1;
	revision: number;
	actions: Record<string, string>;
}

interface TernSource {
	version: 1;
	actions: { id: string; label: string }[];
}

interface Glossary {
	terms: { en: string; ko: string; also?: string[]; match?: string; note?: string }[];
	keep: string[];
	untranslated: string[];
}

interface Finding {
	level: "error" | "warning";
	en: string;
	ko: string;
	message: string;
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const writeJson = (file: string, value: unknown): void => fs.writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;
const PLACEHOLDER = /\{\d+\}/g;

function sortRecord(record: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(record).sort()) out[key] = record[key]!;
	return out;
}

/** Terminal cells: Hangul, CJK and full-width forms take two. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		width +=
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6)
				? 2
				: 1;
	}
	return width;
}

/** Tokens that must survive translation verbatim: code spans, commands, flags, variables, paths, URLs, keys. */
function verbatimTokens(en: string): string[] {
	const tokens = new Set<string>();
	for (const match of en.matchAll(/`[^`]+`/g)) tokens.add(match[0]);
	const outsideCode = en.replace(/`[^`]+`/g, " ");
	const patterns = [
		/(?<![\w/])\/[a-z][\w-]*(?:\s+[a-z][\w-]*)?/g, // slash commands (the command word only is checked below)
		/(?<=^|[\s("'[])--?[a-z][\w-]*/g, // flags, after a space or an opening bracket ("{0}-level" is not one)
		/\$[A-Z_][A-Z0-9_]*/g, // env vars
		/~\/[\w./-]+/g, // home paths
		/https?:\/\/\S+/g, // URLs
		/\b[\w-]+\.(?:json|ya?ml|md|ts|toml|jsonl|db|sh|lua|luau|css)\b/g, // file names
		/\b(?:Ctrl|Alt|Shift|Cmd|Super|Option)\+[\w+]+/g, // key chords
	];
	for (const pattern of patterns) {
		for (const match of outsideCode.matchAll(pattern)) {
			let token = match[0].replace(/[.,:;)]+$/, "");
			if (token.startsWith("/")) token = token.split(/\s+/)[0]!;
			if (token.length > 1) tokens.add(token);
		}
	}
	return [...tokens];
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkEntry(en: string, ko: string, glossary: Glossary): Finding[] {
	const findings: Finding[] = [];
	const add = (level: Finding["level"], message: string) => findings.push({ level, en, ko, message });
	if (typeof ko !== "string" || ko.trim() === "") {
		add("error", "번역이 비어 있습니다");
		return findings;
	}
	if (ko === en) add("error", "원문과 같습니다. 번역하지 않을 문구는 넣지 않습니다");
	if (glossary.untranslated.includes(en)) add("error", "영어로 두는 값입니다(untranslated 목록). 카탈로그에서 뺍니다");
	if (!HANGUL.test(ko)) add("error", "한글이 없습니다");
	if (ko !== ko.trim()) add("error", "앞뒤 공백이 있습니다. 공백은 실행 시 원문에서 옮겨 붙입니다");

	const enHolders = new Set(en.match(PLACEHOLDER) ?? []);
	const koHolders = new Set(ko.match(PLACEHOLDER) ?? []);
	for (const holder of koHolders) if (!enHolders.has(holder)) add("error", `원문에 없는 자리표시자 ${holder}`);
	for (const holder of enHolders) if (!koHolders.has(holder)) add("warning", `자리표시자 ${holder}를 뺐습니다`);

	for (const token of verbatimTokens(en)) if (!ko.includes(token)) add("error", `그대로 두어야 할 ${token}이(가) 없습니다`);
	for (const term of glossary.keep) {
		if (new RegExp(`(?<![A-Za-z])${escapeRegExp(term)}(?![A-Za-z])`).test(en) && !ko.includes(term))
			add("error", `고유명사 ${term}을(를) 영어로 둡니다`);
	}
	// Glossary terms count in prose only: not inside code spans, commands, flags or setting keys.
	const prose = en
		.replace(/`[^`]+`/g, " ")
		.replace(/(?<![\w/])\/[a-z][\w-]*/g, " ")
		.replace(/(?<=^|[\s("'[])--?[a-z][\w-]*/g, " ")
		.replace(/\b[a-z][\w-]*(?:\.[A-Za-z][\w-]*)+\b/g, " ");
	for (const term of glossary.terms) {
		const pattern = new RegExp(term.match ?? `\\b${escapeRegExp(term.en)}(?:s|es)?\\b`, "i");
		if (!pattern.test(prose)) continue;
		const wanted = [term.ko, ...(term.also ?? [])];
		if (!wanted.some(word => ko.includes(word))) add("warning", `용어: ${term.en} → ${wanted.join(" / ")}`);
	}

	const body = ko.replace(/[.…!?:)\]"'」]+$/, "");
	if (/요$/.test(body) && !/(필요|중요|요약|개요|주요|불필요|수요|요소|아니요)$/.test(body)) add("error", "해요체입니다. 합니다체로 씁니다");
	if (/[^니]다$/.test(body) && !/(마다|보다)$/.test(body)) add("warning", "해라체로 보입니다. 합니다체로 씁니다");
	if (en.trimEnd().endsWith(".") && !en.trimEnd().endsWith("...") && !/[.…!?]$/.test(ko.trimEnd()))
		add("warning", "원문은 마침표로 끝납니다");
	if (!/[.]$/.test(en.trimEnd()) && /[^.]\.$/.test(ko.trimEnd())) add("warning", "원문에 없는 마침표");
	// Code spans and command syntax (`completion(x...)`, `<command...>`) keep their dots.
	const literalFree = (text: string) => text.replace(/`[^`]+`|<[^<>\s]+>|\[[^\]\s]+\]/g, " ");
	if (/\.\.\.|…/.test(literalFree(en)) && !ko.includes("…")) add("warning", "말줄임표(…)가 없습니다");
	if (literalFree(ko).includes("...")) add("error", "말줄임표는 … 한 글자로 씁니다");

	const short = en.length <= 24 && !/[.!?]$/.test(en);
	if (short && displayWidth(ko) > displayWidth(en) * 1.6 + 2) add("warning", `짧은 문구인데 폭이 넓어졌습니다 (${displayWidth(en)} → ${displayWidth(ko)}칸)`);
	return findings;
}

function readFlatOrCatalog(file: string): Record<string, string> {
	const parsed = readJson<Record<string, unknown>>(file);
	if (parsed.version === 1 && typeof parsed.strings === "object") {
		const catalog = parsed as unknown as OmpCatalog;
		return { ...catalog.strings, ...catalog.templates };
	}
	if (parsed.version === 1 && typeof parsed.actions === "object") return (parsed as unknown as TernCatalog).actions;
	// A translator's output: `{ translations: { en: ko }, skip: [en] }`.
	if (parsed.translations && typeof parsed.translations === "object") return parsed.translations as Record<string, string>;
	const flat: Record<string, string> = {};
	for (const key in parsed) if (typeof parsed[key] === "string") flat[key] = parsed[key];
	return flat;
}

function gitShow(ref: string, file: string): string | undefined {
	const rel = path.relative(ROOT, file).replaceAll("\\", "/");
	const result = Bun.spawnSync(["git", "show", `${ref}:${rel}`], { cwd: ROOT });
	return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function check(files: string[], base: string | undefined): number {
	const glossary = readJson<Glossary>(GLOSSARY);
	const targets = files.length > 0 ? files : [OMP_CATALOG, TERN_CATALOG];
	let errors = 0;
	let warnings = 0;
	for (const file of targets) {
		const parsed = readJson<Record<string, unknown>>(file);
		const entries = readFlatOrCatalog(file);
		const isTern = typeof parsed.actions === "object";
		const findings: Finding[] = [];
		if (parsed.version === 1 && !isTern) {
			const catalog = parsed as unknown as OmpCatalog;
			for (const key in catalog.strings)
				if (/\{\d+\}/.test(key)) findings.push({ level: "error", en: key, ko: catalog.strings[key]!, message: "자리표시자가 있으면 templates에 둡니다" });
			for (const key in catalog.templates)
				if (!/\{\d+\}/.test(key)) findings.push({ level: "error", en: key, ko: catalog.templates[key]!, message: "자리표시자가 없으면 strings에 둡니다" });
			for (const key in catalog.values ?? {}) {
				const ko = catalog.values![key]!;
				if (!HANGUL.test(ko)) findings.push({ level: "error", en: key, ko, message: "values: 한글이 없습니다" });
			}
			for (const key in catalog.templates) {
				const literal = key.replace(PLACEHOLDER, " ");
				if (!/[A-Za-z]{3,}/.test(literal))
					findings.push({ level: "error", en: key, ko: catalog.templates[key]!, message: "세 글자 이상인 영어 낱말이 없는 템플릿은 무엇에나 맞습니다" });
			}
		}
		// Rows of text and keycap nodes: the nodes cannot be reordered, so the keycaps keep their order.
		const rowKeys = new Set(
			fs.existsSync(OMP_SOURCE) ? readJson<SourceFile>(OMP_SOURCE).strings.filter(entry => entry.contexts.includes("row")).map(entry => entry.en) : [],
		);
		for (const en in entries) {
			if (rowKeys.has(en)) {
				const order = (entries[en]!.match(/\{\d+\}/g) ?? []).join("");
				const expected = (en.match(/\{\d+\}/g) ?? []).join("");
				if (order !== expected) findings.push({ level: "error", en, ko: entries[en]!, message: "키캡 노드 줄입니다: {n}을 원문 순서대로 두십시오" });
			}
			if (isTern) {
				const ko = entries[en]!;
				if (!HANGUL.test(ko)) findings.push({ level: "error", en, ko, message: "한글이 없습니다" });
				continue;
			}
			findings.push(...checkEntry(en, entries[en]!, glossary));
		}
		if (base && parsed.version === 1) {
			const before = gitShow(base, file);
			if (before !== undefined) {
				const old = JSON.parse(before) as { revision?: number };
				const now = parsed as { revision?: number };
				const changed = JSON.stringify({ ...old, revision: 0 }) !== JSON.stringify({ ...parsed, revision: 0 });
				if (changed && !((now.revision ?? 0) > (old.revision ?? 0)))
					findings.push({ level: "error", en: "(revision)", ko: String(now.revision), message: `내용이 바뀌었으니 revision을 ${old.revision}보다 올립니다 (bun tools/catalog.ts bump)` });
			}
		}
		const rel = path.relative(ROOT, file);
		for (const finding of findings) {
			if (finding.level === "error") errors++;
			else warnings++;
			console.log(`${finding.level === "error" ? "오류" : "경고"} ${rel}: ${finding.message}\n  en: ${JSON.stringify(finding.en)}\n  ko: ${JSON.stringify(finding.ko)}`);
		}
		console.log(`${rel}: 항목 ${Object.keys(entries).length}개, 오류 ${findings.filter(f => f.level === "error").length}, 경고 ${findings.filter(f => f.level === "warning").length}`);
	}
	return errors > 0 ? 1 : 0;
}

/** The runtime's lookup key: trimmed, with a trailing `...` read as `…`. */
const normalize = (text: string): string => text.trim().replace(/\.\.\.$/, "…");

function untranslated(): SourceFile["strings"] {
	const source = readJson<SourceFile>(OMP_SOURCE);
	const catalog = readJson<OmpCatalog>(OMP_CATALOG);
	const glossary = readJson<Glossary>(GLOSSARY);
	const have = new Set([...Object.keys(catalog.strings), ...Object.keys(catalog.templates)].map(normalize));
	const skip = new Set(readJson<SkipFile>(SKIP).strings);
	return source.strings.filter(entry => !have.has(normalize(entry.en)) && !skip.has(entry.en) && !glossary.untranslated.includes(entry.en));
}

function coverage(report: string | undefined): void {
	const source = readJson<SourceFile>(OMP_SOURCE);
	const missing = untranslated();
	const done = source.strings.length - missing.length;
	const lines = [
		`## omp ${source.omp}`,
		"",
		`번역: ${done} / ${source.strings.length} (${((done / source.strings.length) * 100).toFixed(1)}%), 남은 문구 ${missing.length}개`,
		"",
	];
	const byFile = new Map<string, string[]>();
	for (const entry of missing) {
		const file = entry.files[0]!;
		byFile.set(file, [...(byFile.get(file) ?? []), entry.en]);
	}
	for (const [file, strings] of [...byFile].sort()) {
		lines.push(`<details><summary>${file} (${strings.length})</summary>`, "", ...strings.map(text => `- \`${text.replaceAll("`", "'")}\``), "", "</details>");
	}
	if (fs.existsSync(TERN_SOURCE)) {
		const tern = readJson<TernSource>(TERN_SOURCE);
		const ternCatalog = readJson<TernCatalog>(TERN_CATALOG);
		const ternMissing = tern.actions.filter(action => ternCatalog.actions[action.id] === undefined);
		lines.push("", "## Tern 팔레트 명령", "", `번역: ${tern.actions.length - ternMissing.length} / ${tern.actions.length}`, "");
		for (const action of ternMissing) lines.push(`- \`${action.id}\` ${action.label}`);
	}
	const text = `${lines.join("\n")}\n`;
	if (report) fs.writeFileSync(report, text);
	console.log(lines.slice(0, 3).join("\n"));
}

function slice(count: number, outDir: string): void {
	const missing = untranslated().sort((a, b) => (a.files[0]! < b.files[0]! ? -1 : a.files[0]! > b.files[0]! ? 1 : 0));
	fs.mkdirSync(outDir, { recursive: true });
	const size = Math.ceil(missing.length / count);
	for (let i = 0; i < count; i++) {
		const part = missing.slice(i * size, (i + 1) * size);
		if (part.length === 0) break;
		writeJson(path.join(outDir, `slice-${String(i + 1).padStart(2, "0")}.json`), part);
		console.log(`slice-${String(i + 1).padStart(2, "0")}: ${part.length}개 (${part[0]!.files[0]} … ${part.at(-1)!.files[0]})`);
	}
}

function nextRevision(current: number): number {
	const now = new Date();
	const day = Number(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}00`);
	return Math.max(current + 1, day);
}

function merge(files: string[]): void {
	const catalog = readJson<OmpCatalog>(OMP_CATALOG);
	const skip = new Set(readJson<SkipFile>(SKIP).strings);
	let added = 0;
	for (const file of files) {
		const skipped = readJson<{ skip?: unknown }>(file).skip;
		if (Array.isArray(skipped)) for (const en of skipped) if (typeof en === "string") skip.add(en);
		const entries = readFlatOrCatalog(file);
		for (const en in entries) {
			const target = /\{\d+\}/.test(en) ? catalog.templates : catalog.strings;
			if (target[en] === undefined) added++;
			target[en] = entries[en]!;
		}
	}
	catalog.revision = nextRevision(catalog.revision ?? 0);
	writeOmpCatalog(catalog);
	for (const en of [...skip]) if (catalog.strings[en] !== undefined || catalog.templates[en] !== undefined) skip.delete(en);
	writeJson(SKIP, { version: 1, strings: [...skip].sort() });
	console.log(`${added}개 추가, 제외 ${skip.size}개, revision ${catalog.revision}`);
}

function mergeTern(files: string[]): void {
	const tern = readJson<TernCatalog>(TERN_CATALOG);
	for (const file of files) Object.assign(tern.actions, readFlatOrCatalog(file));
	tern.revision = nextRevision(tern.revision ?? 0);
	writeJson(TERN_CATALOG, { version: 1, revision: tern.revision, actions: sortRecord(tern.actions) });
	console.log(`Tern 명령 ${Object.keys(tern.actions).length}개, revision ${tern.revision}`);
}

function bump(): void {
	const omp = readJson<OmpCatalog>(OMP_CATALOG);
	omp.revision = nextRevision(omp.revision ?? 0);
	writeOmpCatalog(omp);
	const tern = readJson<TernCatalog>(TERN_CATALOG);
	tern.revision = nextRevision(tern.revision ?? 0);
	writeJson(TERN_CATALOG, { version: 1, revision: tern.revision, actions: sortRecord(tern.actions) });
	console.log(`omp revision ${omp.revision}, Tern revision ${tern.revision}`);
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	const option = (name: string): string | undefined => {
		const index = rest.indexOf(name);
		if (index === -1) return undefined;
		const value = rest[index + 1];
		rest.splice(index, 2);
		return value;
	};
	switch (command) {
		case "check": {
			const base = option("--base");
			process.exit(check(rest, base));
		}
		case "coverage":
			coverage(option("--report"));
			break;
		case "slice":
			slice(Number(option("--count") ?? "8"), option("--out") ?? path.join(ROOT, "work"));
			break;
		case "merge":
			merge(rest);
			break;
		case "merge-tern":
			mergeTern(rest);
			break;
		case "bump":
			bump();
			break;
		default:
			console.log(fs.readFileSync(import.meta.path, "utf8").split("\n").slice(1, 10).join("\n"));
			process.exit(command ? 1 : 0);
	}
}
