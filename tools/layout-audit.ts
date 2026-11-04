/**
 * Finds Korean text that wraps or overflows where omp's English does not.
 *
 *   bun tools/layout-audit.ts capture --control PORT --out DIR [--size W,H] [--full]
 *   bun tools/layout-audit.ts compare <korean-dir> <english-dir> [--json out.json]
 *
 * `capture` drives omp running in a headless Tern (`tern serve --control PORT`) through its screens
 * (the welcome screen, the palette's scope tabs, every settings tab, slash-command overlays, a failed
 * request) and writes each screen's element tree (`tern ctl tree`) as `DIR/NAME.tree.json`, with a
 * screenshot beside it in the serve's `--out` directory. Run it twice on the same Tern build and window
 * size: once with this plugin (`omp -e omp/index.ts`) and once without, then `compare` the two.
 *
 * `compare` matches elements by their place in the tree and reports Korean text that
 *   - `wrap`: is taller than the English it replaces (a label pushed onto a second line), or
 *   - `overflow`: sticks out past its parent's right or bottom edge further than the English did.
 * Findings are grouped by element kind, so one fix (a CSS rule, a shorter translation) covers a group.
 * Tern's own labels that this plugin draws with CSS `::before` are not elements: check those on the
 * screenshots.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createCatalog, parseCatalog } from "../omp/catalog.ts";
import { WORD_JOINER } from "../omp/words.ts";

export interface TreeNode {
	tag: string;
	class?: string;
	id?: string;
	text?: string | null;
	title?: string | null;
	rect: [number, number, number, number];
	children?: TreeNode[];
}

interface FlatNode extends TreeNode {
	key: string;
	/** Enclosing elements, nearest first. */
	ancestors: TreeNode[];
}

/**
 * How many enclosing elements an element's box is checked against: its own box (a button, a chip,
 * a row) and the one around it. Further out are scroll views, whose edges cut content on purpose.
 */
const ANCESTOR_DEPTH = 2;

export interface Finding {
	kind: "wrap" | "overflow";
	screen: string;
	group: string;
	text: string;
	english: string;
	/** `wrap`: heights English → Korean. `overflow`: pixels past the parent's edge. */
	detail: string;
}

const HANGUL = /[\uac00-\ud7a3]/;

/** Each element by its place in the tree: tag and first class, numbered among such siblings. */
export function flatten(tree: TreeNode[]): Map<string, FlatNode> {
	const out = new Map<string, FlatNode>();
	const walk = (nodes: TreeNode[] | undefined, parentKey: string, ancestors: TreeNode[]) => {
		const seen = new Map<string, number>();
		for (const node of nodes ?? []) {
			const base = `${node.tag}.${(node.class ?? "").split(/\s+/)[0]}`;
			const index = seen.get(base) ?? 0;
			seen.set(base, index + 1);
			const key = `${parentKey}/${base}[${index}]`;
			out.set(key, { ...node, key, ancestors });
			walk(node.children, key, [node, ...ancestors].slice(0, ANCESTOR_DEPTH));
		}
	};
	walk(tree, "", []);
	return out;
}

/** The element kind a finding belongs to: its last three tree steps without numbering. */
function groupOf(key: string): string {
	return key
		.split("/")
		.slice(-3)
		.map(step => step.replace(/\[\d+\]$/, ""))
		.join(" > ");
}

/** How far `node` sticks out past the right and bottom edges of any of its enclosing elements. */
function overhang(node: FlatNode | undefined): { right: number; bottom: number } {
	let right = 0;
	let bottom = 0;
	if (!node) return { right, bottom };
	const [x, y, w, h] = node.rect;
	for (const ancestor of node.ancestors) {
		const [ax, ay, aw, ah] = ancestor.rect;
		// A zero-size box is no boundary.
		if (aw <= 0 || ah <= 0) continue;
		// Only a box that starts inside and ends outside sticks out; one wholly past the edge is
		// content scrolled out of a scroll container's view.
		if (x < ax + aw) right = Math.max(right, x + w - (ax + aw));
		if (y < ay + ah) bottom = Math.max(bottom, y + h - (ay + ah));
	}
	return { right, bottom };
}

/** Whether `korean` can be the translation of `english` (false when the two runs showed different content). */
export type IsTranslation = (english: string, korean: string) => boolean;

export function compareScreens(screen: string, korean: TreeNode[], english: TreeNode[], isTranslation: IsTranslation): Finding[] {
	const ko = flatten(korean);
	const en = flatten(english);
	const findings: Finding[] = [];
	for (const [key, node] of ko) {
		const text = node.text ?? "";
		if (!HANGUL.test(text)) continue;
		const counterpart = en.get(key);
		// Only the same element showing English: other matches are different content, not a translation.
		if (!counterpart?.text || HANGUL.test(counterpart.text) || !isTranslation(counterpart.text, text)) continue;
		const base = { screen, group: groupOf(key), text, english: counterpart.text };
		const [, , , height] = node.rect;
		const englishHeight = counterpart.rect[3];
		if (height - englishHeight >= 6 && height >= englishHeight * 1.4)
			findings.push({ ...base, kind: "wrap", detail: `${englishHeight.toFixed(1)} → ${height.toFixed(1)}px` });
		const koOver = overhang(node);
		const enOver = overhang(counterpart);
		const right = koOver.right - enOver.right;
		const bottom = koOver.bottom - enOver.bottom;
		if (right > 1 || bottom > 1) findings.push({ ...base, kind: "overflow", detail: `right ${right.toFixed(1)}px, bottom ${bottom.toFixed(1)}px` });
	}
	return findings;
}

function readTree(file: string): TreeNode[] {
	return (JSON.parse(fs.readFileSync(file, "utf8")) as { tree: TreeNode[] }).tree;
}

export function compareDirs(koreanDir: string, englishDir: string, isTranslation: IsTranslation): Finding[] {
	const findings: Finding[] = [];
	for (const file of fs.readdirSync(koreanDir).filter(name => name.endsWith(".tree.json")).sort()) {
		const englishFile = path.join(englishDir, file);
		if (!fs.existsSync(englishFile)) continue;
		const screen = file.replace(/\.tree\.json$/, "");
		findings.push(...compareScreens(screen, readTree(path.join(koreanDir, file)), readTree(englishFile), isTranslation));
	}
	return findings;
}

/** Checks pairs against this repo's catalog: a string the catalog translates must show that translation. */
function catalogCheck(): IsTranslation {
	const catalog = createCatalog(parseCatalog(fs.readFileSync(path.join(import.meta.dir, "..", "catalog", "ko.json"), "utf8")), false);
	const plain = (text: string) => text.replaceAll(WORD_JOINER, "").replace(/\s+/g, "");
	const latin = (text: string) => new Set((text.match(/[A-Za-z][\w-]+/g) ?? []).map(word => word.toLowerCase()));
	return (english, korean) => {
		const expected = catalog.translate(english);
		if (expected !== undefined) return plain(expected) === plain(korean);
		// No catalog entry for the element's whole text (a line drawn in pieces): a translation keeps
		// the English's names, commands and code, so the Korean holds no Latin word the English lacks.
		const words = latin(english);
		return [...latin(korean)].every(word => words.has(word));
	};
}

// ─── Capture ───────────────────────────────────────────────────────────────

const SLASH_SCREENS = [
	"/hotkeys", "/model", "/agents", "/usage", "/mcp", "/skills", "/extensions", "/plugins", "/context", "/session",
	"/tree", "/resume", "/changelog", "/ssh", "/memory", "/todo", "/queue", "/debug", "/jobs", "/tools", "/providers",
	"/status", "/hub", "/dirs", "/computer", "/advisor", "/prewalk", "/modelpreset", "/marketplace", "/installed",
	"/trace", "/visible", "/disposition", "/ultra", "/ratchet", "/loop", "/fast", "/slow", "/plan", "/effort", "/security", "/git",
];
const QUICK_SCREENS = ["/hotkeys", "/model", "/agents", "/usage", "/context", "/tree", "/debug", "/hub", "/loop", "/plan"];
/** Commands above that toggle a mode: run once more at the end to leave omp as it was. */
const TOGGLES = ["/loop", "/fast", "/slow", "/plan"];

function ctl(port: string, ...args: string[]): string {
	const result = Bun.spawnSync(["tern", "ctl", "--control", port, ...args]);
	return result.stdout.toString();
}

const sleep = (ms: number) => Bun.sleepSync(ms);

function editorEmpty(port: string): boolean {
	try {
		return (JSON.parse(ctl(port, "tree", ".sf-editor.empty")) as { count?: number }).count === 1;
	} catch {
		return false;
	}
}

function clearEditor(port: string): void {
	if (editorEmpty(port)) return;
	ctl(port, "key", "End");
	for (let i = 0; i < 24; i++) ctl(port, "key", "Backspace");
}

/** Types a line into omp's composer, only when the composer is empty (never sends a half-typed prompt). */
function send(port: string, line: string, waitMs: number): boolean {
	clearEditor(port);
	if (!editorEmpty(port)) return false;
	ctl(port, `type ${JSON.stringify(line)}`);
	ctl(port, "key", "Enter");
	sleep(waitMs);
	return true;
}

function dismiss(port: string): void {
	ctl(port, "key", "Escape");
	sleep(400);
	ctl(port, "key", "Escape");
	sleep(400);
	clearEditor(port);
}

function capture(port: string, out: string, size: [number, number], full: boolean): void {
	fs.mkdirSync(out, { recursive: true });
	const tag = `-${size[0]}x${size[1]}`;
	const save = (name: string) => {
		fs.writeFileSync(path.join(out, `${name}${tag}.tree.json`), ctl(port, "tree"));
		ctl(port, `shot ${name}${tag}`);
		console.log(`${name}${tag}`);
	};
	ctl(port, "resize", String(size[0]), String(size[1]));
	for (let i = 0; i < 40 && !editorEmpty(port); i++) sleep(1000);
	if (!editorEmpty(port)) throw new Error("omp did not reach an empty composer");
	save("start");

	ctl(port, "palette");
	sleep(800);
	for (let scope = 1; scope <= 7; scope++) {
		save(`palette${scope}`);
		ctl(port, "key", "Tab");
		sleep(400);
	}
	ctl(port, "key", "Escape");
	sleep(500);

	if (send(port, "/settings", 3000)) {
		// Every page button of the settings sheet, wherever its group puts it.
		const tabs = (JSON.parse(ctl(port, "tree", "button.nav-row") || "{}") as { nodes?: { rect: number[] }[] }).nodes ?? [];
		tabs.forEach((tab, index) => {
			const [x, y, w, h] = tab.rect as [number, number, number, number];
			ctl(port, "click", String(Math.round(x + w / 2)), String(Math.round(y + h / 2)));
			sleep(600);
			save(`settings${index + 1}`);
		});
	}
	dismiss(port);

	const screens = full ? SLASH_SCREENS : QUICK_SCREENS;
	for (const command of screens) {
		if (send(port, command, 3000)) save(command.slice(1));
		dismiss(port);
	}
	for (const command of TOGGLES.filter(toggle => screens.includes(toggle))) {
		send(port, command, 2000);
		dismiss(port);
	}
	// A prompt the model cannot answer leaves the error card and the retry row.
	if (send(port, "hi", 40_000)) save("error");
	dismiss(port);
}

// ─── CLI ───────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	if (command === "capture") {
		const port = arg("--control");
		const out = arg("--out");
		if (!port || !out) throw new Error("usage: capture --control PORT --out DIR [--size W,H] [--full]");
		const [width, height] = (arg("--size") ?? "1280,800").split(",").map(Number);
		capture(port, out, [width!, height!], process.argv.includes("--full"));
	} else if (command === "compare") {
		const [koreanDir, englishDir] = rest.filter((item, index) => !item.startsWith("--") && rest[index - 1] !== "--json");
		if (!koreanDir || !englishDir) throw new Error("usage: compare <korean-dir> <english-dir> [--json out.json]");
		const findings = compareDirs(koreanDir, englishDir, catalogCheck());
		const json = arg("--json");
		if (json) fs.writeFileSync(json, `${JSON.stringify(findings, null, "\t")}\n`);
		const groups = new Map<string, Finding[]>();
		for (const finding of findings) {
			const key = `${finding.kind} ${finding.group}`;
			groups.set(key, [...(groups.get(key) ?? []), finding]);
		}
		console.log(`줄바꿈 ${findings.filter(f => f.kind === "wrap").length}건, 튀어나감 ${findings.filter(f => f.kind === "overflow").length}건 (${groups.size}개 묶음)`);
		for (const [key, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
			console.log(`\n${key} ×${items.length}`);
			for (const item of items.slice(0, 4)) console.log(`  [${item.screen}] ${item.detail}  ${item.text.slice(0, 80)}  ← ${item.english.slice(0, 60)}`);
		}
	} else {
		console.log("usage: bun tools/layout-audit.ts capture|compare …");
	}
}
