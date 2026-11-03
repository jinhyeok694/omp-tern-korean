/**
 * Extracts omp's user-facing strings from the TypeScript sources that the npm packages ship.
 *
 *   bun tools/extract-omp.ts [--version <x.y.z>] [--out catalog/source.json]
 *
 * Downloads `@oh-my-pi/pi-tui` and `@oh-my-pi/pi-coding-agent` (latest unless --version), walks
 * their `src/` with the TypeScript parser, and keeps string and template literals that read as UI
 * copy. A template literal becomes a `{0}`-placeholder template, the same shape the catalog uses.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";

export interface SourceString {
	en: string;
	kind: "exact" | "template";
	/** Package-relative files the string appears in. */
	files: string[];
	/** The property or callee each occurrence sits under (`label`, `notify`, …). */
	contexts: string[];
}

export interface SourceFile {
	version: 1;
	omp: string;
	strings: SourceString[];
}

const PACKAGES = ["pi-tui", "pi-coding-agent"] as const;

/** Property names whose string values are shown to the user. */
const UI_KEYS: Record<string, true> = {
	label: true,
	description: true,
	title: true,
	subtitle: true,
	placeholder: true,
	hint: true,
	text: true,
	head: true,
	heading: true,
	header: true,
	footer: true,
	empty: true,
	message: true,
	detail: true,
	details: true,
	summary: true,
	question: true,
	action: true,
	help: true,
	tooltip: true,
	caption: true,
	note: true,
	warning: true,
	confirm: true,
	verb: true,
	group: true,
	inlineHint: true,
	statusText: true,
	emptyText: true,
	emptyMessage: true,
	doneLabel: true,
	activeLabel: true,
	tip: true,
	reason: true,
	body: true,
};

/** Callees whose string arguments are shown to the user. */
const UI_CALLEES: Record<string, true> = {
	notify: true,
	showStatus: true,
	showError: true,
	showWarning: true,
	showInfo: true,
	showSuccess: true,
	showNotice: true,
	setStatus: true,
	setWorkingMessage: true,
	setTitle: true,
	span: true,
	text: true,
	actionButton: true,
	kv: true,
	item: true,
	badge: true,
	toast: true,
	confirm: true,
	select: true,
	input: true,
	editor: true,
	notice: true,
	statusNotice: true,
	transcriptNotice: true,
	noteSpans: true,
	hint: true,
	keyHint: true,
	rawKeyHint: true,
	addMessageToChat: true,
	appendNotice: true,
	header: true,
	sectionHeader: true,
};

/** Callees whose arguments are never UI copy. */
const NON_UI_CALLEES: Record<string, true> = {
	debug: true,
	trace: true,
	require: true,
	resolve: true,
	join: true,
	startsWith: true,
	endsWith: true,
	includes: true,
	indexOf: true,
	split: true,
	replace: true,
	replaceAll: true,
	match: true,
	test: true,
	get: true,
	has: true,
	set: true,
	delete: true,
	getEnv: true,
	env: true,
	lookup: true,
	register: true,
	on: true,
	emit: true,
	fetch: true,
	exec: true,
	spawn: true,
	spawnSync: true,
	execSync: true,
	readFile: true,
	writeFile: true,
	querySelector: true,
	encodeURIComponent: true,
	RegExp: true,
	Symbol: true,
	for: true,
	keyHintId: true,
	parse: true,
	stringify: true,
	isKeyRelease: true,
	matchesKey: true,
	sendMessage: true,
	sendUserMessage: true,
	appendEntry: true,
};

/**
 * coding-agent directories that render the interactive UI. Elsewhere in coding-agent, only arguments
 * of direct UI calls count: tool schemas, telemetry and RPC docs carry `description` keys the user
 * never sees, and `omp <subcommand>` output (src/cli, src/commands) prints before extensions load.
 */
const CODING_AGENT_UI_DIRS = ["src/modes/", "src/slash-commands/", "src/config/", "src/extensibility/custom-commands/"];
const DIRECT_UI_CALLEES: Record<string, true> = {
	notify: true,
	showStatus: true,
	showError: true,
	showWarning: true,
	showInfo: true,
	setStatus: true,
	confirm: true,
	select: true,
	input: true,
};
/** Property names whose values are documentation for other programs, never shown in the TUI. */
const NON_UI_KEYS: Record<string, true> = { acpDescription: true, doc: true, examples: true, usageText: true };

const SKIP_PATH = /(\.test\.ts$|\.d\.ts$|\/test\/|\/gallery-fixtures\/|\/prompts\/|\/__fixtures__\/|\/modes\/rpc\/|\/modes\/acp\/)/;

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function latestVersion(pkg: string): Promise<string> {
	const response = await fetch(`https://registry.npmjs.org/@oh-my-pi/${pkg}/latest`);
	if (!response.ok) throw new Error(`npm registry: ${response.status}`);
	const body = (await response.json()) as { version?: unknown };
	if (typeof body.version !== "string") throw new Error("npm registry: no version");
	return body.version;
}

async function download(pkg: string, version: string, into: string): Promise<string> {
	const url = `https://registry.npmjs.org/@oh-my-pi/${pkg}/-/${pkg}-${version}.tgz`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: ${response.status}`);
	const tarball = path.join(into, `${pkg}.tgz`);
	await Bun.write(tarball, response);
	const target = path.join(into, pkg);
	fs.mkdirSync(target, { recursive: true });
	const tar = Bun.spawnSync(["tar", "-xzf", tarball, "-C", target]);
	if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
	return path.join(target, "package");
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** The property name or callee a literal sits under, looking through `??`, ternaries, arrays and parens. */
function contextOf(node: ts.Node): { key?: string; callee?: string; skip?: boolean } {
	let child: ts.Node = node;
	let parent = node.parent;
	while (parent) {
		if (
			ts.isParenthesizedExpression(parent) ||
			ts.isConditionalExpression(parent) ||
			ts.isArrayLiteralExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			(ts.isBinaryExpression(parent) &&
				(parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
					parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
					parent.operatorToken.kind === ts.SyntaxKind.PlusToken))
		) {
			if (ts.isConditionalExpression(parent) && parent.condition === child) return { skip: true };
			child = parent;
			parent = parent.parent;
			continue;
		}
		break;
	}
	if (!parent) return {};
	if (ts.isBinaryExpression(parent)) return { skip: true }; // comparisons, `in`, assignments to keys
	if (ts.isCaseClause(parent) || ts.isElementAccessExpression(parent)) return { skip: true };
	if (ts.isPropertyAssignment(parent)) {
		if (parent.name === child) return { skip: true };
		const name = parent.name;
		return { key: ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined };
	}
	if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
		const callee = parent.expression;
		let name: string | undefined;
		if (ts.isIdentifier(callee)) name = callee.text;
		else if (ts.isPropertyAccessExpression(callee)) {
			name = callee.name.text;
			const target = callee.expression;
			if (ts.isIdentifier(target) && (target.text === "logger" || target.text === "console")) return { skip: true };
		}
		return { callee: name };
	}
	if (ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) return { key: "return" };
	if (ts.isVariableDeclaration(parent)) return { key: ts.isIdentifier(parent.name) ? `var:${parent.name.text}` : "var" };
	if (
		ts.isImportDeclaration(parent) ||
		ts.isExportDeclaration(parent) ||
		ts.isLiteralTypeNode(parent) ||
		ts.isExternalModuleReference(parent) ||
		ts.isImportTypeNode(parent) ||
		ts.isEnumMember(parent) ||
		ts.isPropertySignature(parent) ||
		ts.isTaggedTemplateExpression(parent)
	)
		return { skip: true };
	if (ts.isTemplateSpan(parent)) return { skip: true }; // a literal inside another template's expression
	return {};
}

/** The literal's text with `{n}` for each template expression; undefined for anything else. */
function literalText(node: ts.Node): { text: string; template: boolean } | undefined {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, template: false };
	if (ts.isTemplateExpression(node)) {
		let text = node.head.text;
		node.templateSpans.forEach((span, index) => {
			text += `{${index}}${span.literal.text}`;
		});
		return { text, template: true };
	}
	return undefined;
}

const CODE_LIKE = /(=>|\$\{|^\s*[{[(<]|[;{}]\s*$|\\[nt]|^#!|^\s*import |\bfunction\b|\bconst\b|\breturn\b|="|<\/?[a-z]+[ >/])/;
const PATH_LIKE = /^[\w.~@$%-]*[\\/][\w./\\@*$%-]*$/;
const IDENT_LIKE = /^[a-z0-9_.:@/#-]+$/;
const CAPITALIZED_WORD = /^[A-Z][a-z]+(?:[-'][A-Za-z]+)?[.:…?!]?$/;

/** Whether `text` reads as UI copy: words a person reads, not an identifier, a path, a pattern or code. */
export function isUiText(text: string, template: boolean, uiContext: boolean): boolean {
	const core = text.trim();
	if (core.length < 2 || core.length > 600) return false;
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(core)) return false;
	if (core.includes("://") && !core.includes(" ")) return false;
	if (CODE_LIKE.test(core)) return false;
	const literal = template ? core.replace(/\{\d+\}/g, " ") : core;
	const letters = literal.match(/[A-Za-z]/g)?.length ?? 0;
	if (letters < 2) return false;
	// Words of three or more letters anchor a template; without one it would match anything.
	if (template && !/[A-Za-z]{3,}/.test(literal)) return false;
	const words = literal.trim().split(/\s+/).filter(Boolean);
	if (words.length <= 1) {
		const word = words[0] ?? "";
		if (PATH_LIKE.test(word) || IDENT_LIKE.test(word)) return false;
		if (/[a-z][A-Z]/.test(word) || word.includes("_")) return false; // camelCase, snake_case
		if (!CAPITALIZED_WORD.test(word)) return false;
		return uiContext;
	}
	if (PATH_LIKE.test(core)) return false;
	// Mostly identifiers or flags (`--model <id>`, `foo.bar baz.qux`).
	const plain = words.filter(word => /^[A-Za-z][a-z]*[,.:;!?…)]*$/.test(word) || /^\(?[A-Za-z][a-z']+/.test(word)).length;
	if (plain / words.length < 0.5) return false;
	return true;
}

export async function extract(version: string, workdir: string): Promise<SourceFile> {
	const found = new Map<string, SourceString>();
	for (const pkg of PACKAGES) {
		const root = await download(pkg, version, workdir);
		for (const file of walk(path.join(root, "src"))) {
			const rel = `${pkg}/${path.relative(root, file).replaceAll("\\", "/")}`;
			if (SKIP_PATH.test(`/${rel}`)) continue;
			const uiFile =
				pkg === "pi-tui" ||
				CODING_AGENT_UI_DIRS.some(dir => rel.includes(`/${dir}`)) ||
				/(^|[/-])settings(-[\w-]+)?\.ts$/.test(rel); // settings.ts, title-settings.ts, settings-defs.ts
			const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
			const visit = (node: ts.Node): void => {
				const literal = literalText(node);
				if (literal) {
					const context = contextOf(node);
					const excluded =
						context.skip === true ||
						(context.callee !== undefined && (NON_UI_CALLEES[context.callee] === true || context.callee === "doc")) ||
						(context.key !== undefined && NON_UI_KEYS[context.key] === true);
					if (!excluded) {
						const uiContext =
							(context.key !== undefined && UI_KEYS[context.key] === true) ||
							(context.callee !== undefined && UI_CALLEES[context.callee] === true);
						const counts = uiFile || (context.callee !== undefined && DIRECT_UI_CALLEES[context.callee] === true);
						if (counts && isUiText(literal.text, literal.template, uiContext)) {
							const en = literal.text.trim();
							let entry = found.get(en);
							if (!entry) {
								entry = { en, kind: literal.template ? "template" : "exact", files: [], contexts: [] };
								found.set(en, entry);
							}
							if (!entry.files.includes(rel)) entry.files.push(rel);
							const label = context.key ?? (context.callee ? `${context.callee}()` : "");
							if (label && !entry.contexts.includes(label)) entry.contexts.push(label);
						}
					}
					if (!ts.isTemplateExpression(node)) return;
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
	}
	const strings = [...found.values()].sort((a, b) => (a.en < b.en ? -1 : a.en > b.en ? 1 : 0));
	for (const entry of strings) {
		entry.files.sort();
		entry.contexts.sort();
	}
	return { version: 1, omp: version, strings };
}

if (import.meta.main) {
	const version = arg("--version") ?? (await latestVersion("pi-coding-agent"));
	const out = arg("--out") ?? path.join(import.meta.dir, "..", "catalog", "source.json");
	const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ko-extract-"));
	try {
		const result = await extract(version, workdir);
		fs.writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`);
		const templates = result.strings.filter(entry => entry.kind === "template").length;
		console.log(`omp ${version}: ${result.strings.length} strings (${templates} templates) → ${out}`);
	} finally {
		fs.rmSync(workdir, { recursive: true, force: true });
	}
}
