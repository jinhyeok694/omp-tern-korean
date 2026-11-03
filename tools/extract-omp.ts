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
	emitNotice: true,
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
	// Native view helpers that take an id, then a label (`button("retry", "Retry", ["F5"])`).
	button: true,
	pickerAction: true,
	roleAction: true,
	statusRow: true,
	statTile: true,
	stat: true,
	overlayCard: true,
	previewSection: true,
	footnote: true,
	fg: true,
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
const CODING_AGENT_UI_DIRS = ["src/modes/", "src/slash-commands/", "src/config/", "src/extensibility/custom-commands/", "src/debug/", "src/cli/git-tui"];
/** coding-agent directories whose strings are model-facing or print before extensions load. */
const CODING_AGENT_NON_UI = /\/src\/(?:cli\/(?!git-tui)|commands\/|tools\/|web\/|eval\/|commit\/agentic\/|prompts\/)/;
const DIRECT_UI_CALLEES: Record<string, true> = {
	notify: true,
	emitNotice: true,
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

// ─── Whole sentences out of composed code ─────────────────────────────────
//
// omp builds many lines in pieces: `${on ? "enabled" : "disabled"}`, `"Saved" + suffix`, a plural
// `job${n === 1 ? "" : "s"}`, a span array around a keycap, a row of text and keycap nodes. The
// catalog needs the whole sentence, so these are expanded into every variant the code can produce,
// with `{n}` where a runtime value goes.

type Piece = { text: string } | { hole: true; icon?: boolean } | { choices: string[] };
const MAX_VARIANTS = 16;
/** Span style tokens drawn verbatim (see omp/sequence.ts): such a span is a placeholder in the catalog. */
const VERBATIM_TOKENS = /\b(?:key|code|mono|path|num|link|icon|typo|ins|del)\b/;

function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current))
		current = current.expression;
	return current;
}

/** Every string `node` can evaluate to, when the code spells them out; undefined otherwise. */
function choicesOf(node: ts.Expression, depth = 0): string[] | undefined {
	if (depth > 4) return undefined;
	const expr = unwrap(node);
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
	if (ts.isConditionalExpression(expr)) {
		const a = choicesOf(expr.whenTrue, depth + 1);
		const b = choicesOf(expr.whenFalse, depth + 1);
		return a && b ? [...new Set([...a, ...b])] : undefined;
	}
	if (ts.isTemplateExpression(expr) || (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
		const pieces = piecesOf(expr, depth + 1);
		if (!pieces || pieces.some(piece => "hole" in piece)) return undefined;
		const variants = expand(pieces);
		return variants.length <= MAX_VARIANTS ? variants : undefined;
	}
	if (ts.isIdentifier(expr)) return identifierChoices(expr, depth + 1);
	return undefined;
}

/** Values of a local `const` or of a parameter typed as a union of string literals. */
function identifierChoices(id: ts.Identifier, depth: number): string[] | undefined {
	for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
		if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
			for (const statement of scope.statements) {
				if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
				for (const declaration of statement.declarationList.declarations) {
					if (ts.isIdentifier(declaration.name) && declaration.name.text === id.text && declaration.initializer)
						return choicesOf(declaration.initializer, depth);
				}
			}
		}
		if (ts.isFunctionLike(scope)) {
			for (const parameter of scope.parameters) {
				if (!ts.isIdentifier(parameter.name) || parameter.name.text !== id.text) continue;
				const type = parameter.type;
				if (type && ts.isUnionTypeNode(type)) {
					const literals = type.types.map(member => (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : undefined));
					if (literals.every(value => value !== undefined)) return literals as string[];
				}
				return undefined;
			}
		}
	}
	return undefined;
}

/** Theme helpers that wrap their last argument in escapes and nothing else. */
const STYLE_WRAPPERS: Record<string, true> = { fg: true, bg: true, bold: true, italic: true, underline: true, dim: true, inverse: true, strikethrough: true };

/** A template literal or a `+` chain as pieces; undefined when it holds no literal text. */
function piecesOf(node: ts.Expression, depth = 0): Piece[] | undefined {
	const expr = unwrap(node);
	const part = (child: ts.Expression): Piece[] => {
		const inner = unwrap(child);
		if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return [{ text: inner.text }];
		if (ts.isTemplateExpression(inner) || (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken))
			return piecesOf(inner, depth + 1) ?? [{ hole: true }];
		// Colour and weight wrappers (`theme.fg("dim", "Use")`) only add escapes; Tern shows their text.
		if (ts.isCallExpression(inner) && STYLE_WRAPPERS[calleeName(inner) ?? ""] === true && inner.arguments.length > 0)
			return part(inner.arguments[inner.arguments.length - 1]!);
		const choices = choicesOf(inner, depth + 1);
		return choices ? [{ choices }] : [{ hole: true }];
	};
	if (ts.isTemplateExpression(expr)) {
		const pieces: Piece[] = [{ text: expr.head.text }];
		for (const span of expr.templateSpans) pieces.push(...part(span.expression), { text: span.literal.text });
		return pieces;
	}
	if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...part(expr.left), ...part(expr.right)];
	if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [{ text: expr.text }];
	return undefined;
}

/**
 * Every string the pieces can form: choices expanded (up to MAX_VARIANTS, else kept as holes),
 * holes written `{0}`, `{1}`… Adjacent holes collapse into one, as the runtime merges adjacent
 * verbatim spans; icon holes get spaces around them, as the runtime adds them.
 */
function expand(pieces: Piece[]): string[] {
	let total = 1;
	for (const piece of pieces) if ("choices" in piece) total *= piece.choices.length;
	const usable = total <= MAX_VARIANTS ? pieces : pieces.map(piece => ("choices" in piece ? ({ hole: true } as Piece) : piece));
	let variants: Piece[][] = [[]];
	for (const piece of usable) {
		if (!("choices" in piece)) {
			for (const variant of variants) variant.push(piece);
			continue;
		}
		variants = variants.flatMap(variant => piece.choices.map(choice => [...variant, { text: choice } as Piece]));
	}
	return [...new Set(variants.map(render))];
}

function render(pieces: Piece[]): string {
	let out = "";
	let holes = 0;
	let lastHole = false;
	let lastIcon = false;
	/** Whitespace after a hole: dropped when another hole follows (they merge), kept before text. */
	let pendingSpace = "";
	for (const piece of pieces) {
		if ("text" in piece) {
			if (piece.text.length === 0) continue;
			if (lastHole && piece.text.trim().length === 0) {
				pendingSpace += piece.text;
				continue;
			}
			if (lastIcon && pendingSpace.length === 0 && /^\S/.test(piece.text)) out += " ";
			out += pendingSpace + piece.text;
			pendingSpace = "";
			lastHole = false;
			lastIcon = false;
			continue;
		}
		if ("hole" in piece) {
			if (lastHole) {
				pendingSpace = "";
				lastIcon &&= piece.icon === true;
				continue;
			}
			if (piece.icon && out.length > 0 && !/\s$/.test(out)) out += " ";
			out += `{${holes++}}`;
			lastHole = true;
			lastIcon = piece.icon === true;
		}
	}
	return out.replace(/\s+$/, "").replace(/^\s+/, "");
}

function calleeName(node: ts.Expression): string | undefined {
	if (!ts.isCallExpression(node)) return undefined;
	const callee = node.expression;
	if (ts.isIdentifier(callee)) return callee.text;
	if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
	return undefined;
}

/** A `span(text, style?)` call as pieces: one hole when its style is drawn verbatim. */
function spanPieces(call: ts.CallExpression): Piece[] {
	const [textArg, styleArg] = call.arguments;
	if (styleArg) {
		const style = choicesOf(styleArg);
		if (style?.some(value => VERBATIM_TOKENS.test(value))) return [{ hole: true, icon: style.some(value => /\bicon\b/.test(value)) }];
	}
	if (!textArg) return [];
	return piecesOf(textArg) ?? (choicesOf(textArg) ? [{ choices: choicesOf(textArg)! }] : [{ hole: true }]);
}

/** A literal span array (`[span("Press "), span(key, "key"), span(" to begin")]`) as one line. */
function spanArrayPieces(array: ts.ArrayLiteralExpression): Piece[] | undefined {
	if (array.elements.length < 2) return undefined;
	const pieces: Piece[] = [];
	for (const element of array.elements) {
		if (ts.isSpreadElement(element)) pieces.push({ hole: true });
		else if (calleeName(element) === "span") pieces.push(...spanPieces(element as ts.CallExpression));
		else return undefined;
	}
	return pieces.some(piece => "text" in piece && /[A-Za-z]{2}/.test(piece.text)) ? pieces : undefined;
}

/**
 * A literal row of `text(…)` and keycap, chart or counter nodes (`[kbd(key), text("to retry")]`,
 * `[text("Updated"), node("elapsed"), text("ago")]`) as one line, as the runtime masks it.
 */
function rowPieces(elements: readonly ts.Expression[]): Piece[] | undefined {
	const items: ({ kind: "text"; pieces: Piece[] } | { kind: "kbd" | "edge" | "counter" })[] = [];
	for (const element of elements) {
		const name = ts.isSpreadElement(element) ? undefined : calleeName(element);
		const call = element as ts.CallExpression;
		const nodeKind = name === "node" && call.arguments[0] && ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : name;
		if (nodeKind === "kbd" || nodeKind === "chart") items.push({ kind: "kbd" });
		// A counter is an edge at either end of the row and a placeholder inside it.
		else if (nodeKind === "elapsed") items.push({ kind: "counter" });
		else if (nodeKind === "icon" || nodeKind === "spinner") items.push({ kind: "edge" });
		else if (name === "text" && call.arguments[0]) {
			const arg = unwrap(call.arguments[0]);
			const pieces = ts.isArrayLiteralExpression(arg) ? (spanArrayPieces(arg) ?? (arg.elements.length === 1 && calleeName(arg.elements[0]!) === "span" ? spanPieces(arg.elements[0] as ts.CallExpression) : undefined)) : (piecesOf(arg) ?? (choicesOf(arg) ? [{ choices: choicesOf(arg)! } as Piece] : undefined));
			if (!pieces || pieces.some(piece => "hole" in piece && piece.icon !== undefined)) return undefined;
			items.push({ kind: "text", pieces });
		} else return undefined;
	}
	while (items[0]?.kind === "edge" || items[0]?.kind === "counter") items.shift();
	while (items.at(-1)?.kind === "edge" || items.at(-1)?.kind === "counter") items.pop();
	const isHole = (item: (typeof items)[number]) => item.kind === "kbd" || item.kind === "counter";
	if (items.some(item => item.kind === "edge") || !items.some(isHole) || !items.some(item => item.kind === "text")) return undefined;
	const pieces: Piece[] = [];
	items.forEach((item, index) => {
		if (index > 0) pieces.push({ text: " " });
		if (isHole(item)) pieces.push({ hole: true });
		else pieces.push(...(item as { pieces: Piece[] }).pieces.map(piece => ("text" in piece ? { text: piece.text } : piece)));
	});
	return pieces;
}

// Markup means a closing tag or a tag with attributes: `<name>` and `<task>` are argument placeholders in help text.
const CODE_LIKE = /(=>|\$\{|^\s*\{(?!\d+\})|^\s*\[(?![A-Za-z{])|(?:;|\{|(?<!\{\d{1,3})\})\s*$|\\[nt]|^#!|^\s*import |\bfunction\b|\bconst\b|\breturn\b|="|<\/[a-z]+>|<[a-z]+\s+[a-z-]+=)/;
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

/**
 * The welcome screen's tips (`src/prompt/tips.txt`, one per line) as Tern shows them: `[NO-TERN]` tips are
 * dropped there, the `[NEW]` marker becomes a separate tag, key placeholders (`{key:alt+p}`) become the
 * formatted key and links (`[label](url)`) separate link spans — both `{n}` here.
 */
function tipLines(root: string, pkg: string): Array<[string, string]> {
	const file = path.join(root, "src", "prompt", "tips.txt");
	if (!fs.existsSync(file)) return [];
	const rel = `${pkg}/src/prompt/tips.txt`;
	const tips: Array<[string, string]> = [];
	for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("[NO-TERN]")) continue;
		let index = 0;
		const en = line
			.replace(/\s*\[NEW\]\s*$/, "")
			.replace(/\{(?:key|keys|tap|action):[^}]+\}|\[[^\]]+\]\([^\s)]+\)/g, () => `{${index++}}`);
		tips.push([en, rel]);
	}
	return tips;
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
			const nonUi = pkg === "pi-coding-agent" && CODING_AGENT_NON_UI.test(`/${rel}`) && !/settings(-[\w-]+)?\.ts$/.test(rel);
			const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
			const add = (text: string, template: boolean, context: ReturnType<typeof contextOf>, uiContext: boolean) => {
				if (!isUiText(text, template, uiContext)) return;
				const en = text.trim();
				let entry = found.get(en);
				if (!entry) {
					entry = { en, kind: template ? "template" : "exact", files: [], contexts: [] };
					found.set(en, entry);
				}
				if (!entry.files.includes(rel)) entry.files.push(rel);
				const label = context.key ?? (context.callee ? `${context.callee}()` : "");
				if (label && !entry.contexts.includes(label)) entry.contexts.push(label);
			};
			/** Where a literal counts: in UI files, or in a UI call or UI property anywhere but model-facing code. */
			const judge = (node: ts.Node) => {
				const context = contextOf(node);
				const excluded =
					context.skip === true ||
					(context.callee !== undefined && (NON_UI_CALLEES[context.callee] === true || context.callee === "doc")) ||
					(context.key !== undefined && NON_UI_KEYS[context.key] === true);
				const uiContext =
					(context.key !== undefined && UI_KEYS[context.key] === true) ||
					(context.callee !== undefined && UI_CALLEES[context.callee] === true);
				const counts =
					!excluded &&
					(uiFile || (context.callee !== undefined && DIRECT_UI_CALLEES[context.callee] === true) || (!nonUi && uiContext));
				return { context, uiContext, counts };
			};
			const addVariants = (pieces: Piece[], context: ReturnType<typeof contextOf>, uiContext: boolean) => {
				for (const variant of expand(pieces)) add(variant, /\{\d+\}/.test(variant), context, uiContext);
			};
			const visit = (node: ts.Node): void => {
				// A line drawn as spans or as a row of text and keycap nodes.
				if (ts.isArrayLiteralExpression(node) && !nonUi) {
					const spans = spanArrayPieces(node);
					const row = spans ? undefined : rowPieces(node.elements);
					const pieces = spans ?? row;
					if (pieces) addVariants(pieces, { key: spans ? "spans" : "row" }, true);
				}
				// A row's children pushed in one call: `checked.push(text(…), elapsed(…), text(…))`.
				if (ts.isCallExpression(node) && !nonUi && node.arguments.length >= 2 && calleeName(node) === "push") {
					const row = rowPieces(node.arguments);
					if (row) addVariants(row, { key: "row" }, true);
				}
				// A `+` chain mixing literals with values or choices.
				if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
					const parent = node.parent;
					const top = !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) && !ts.isParenthesizedExpression(parent);
					const pieces = top ? piecesOf(node) : undefined;
					if (pieces && pieces.some(piece => !("text" in piece))) {
						const { context, uiContext, counts } = judge(node);
						if (counts) addVariants(pieces, context, uiContext);
					}
				}
				const literal = literalText(node);
				if (literal) {
					const { context, uiContext, counts } = judge(node);
					if (counts) {
						add(literal.text, literal.template, context, uiContext);
						// Every variant of the values the code spells out (`${on ? "enabled" : "disabled"}`).
						if (ts.isTemplateExpression(node)) {
							const pieces = piecesOf(node);
							if (pieces?.some(piece => "choices" in piece)) addVariants(pieces, context, uiContext);
						}
					}
					if (!ts.isTemplateExpression(node)) return;
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
		for (const [en, rel] of tipLines(root, pkg)) {
			if (!found.has(en)) found.set(en, { en, kind: /\{\d+\}/.test(en) ? "template" : "exact", files: [rel], contexts: ["tip"] });
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
