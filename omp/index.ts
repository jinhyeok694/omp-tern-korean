/**
 * omp-tern-korean: shows omp's interface in Korean.
 *
 * - In Tern, every frame omp sends over the Tern Surface Protocol passes through `FrameTranslator`,
 *   which rewrites UI copy and never conversation, code or user input. omp keeps its own English
 *   data, so searches and filters omp runs still match English.
 * - In other terminals, settings and slash-command descriptions are translated where omp keeps them.
 * - Once a day the catalog is refreshed from GitHub, and in Tern the Tern half is linked in.
 *
 * Every hook checks that its target exists and turns itself off otherwise, so a changed omp shows
 * English instead of breaking.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { bundledCatalogPath, type Catalog, type CatalogFile, createCatalog, parseCatalog } from "./catalog.ts";
import { ensureTernPlugin, runTernWith, type TernLinkResult } from "./tern-link.ts";
import { DEFAULT_APC_LIMIT, FrameTranslator, TSP_PREFIX, translateWrite } from "./tsp.ts";
import { checkForUpdate, DEFAULT_CATALOG_URL, readCachedCatalog, type UpdateResult } from "./update.ts";

type Write = (this: unknown, data: string) => void;

/** Process-wide state: a reload imports this file again, while the prototype patches belong to the process. */
interface Shared {
	enabled: boolean;
	translator?: FrameTranslator;
	originalWrite?: Write;
	wrapper?: Write;
	frames: number;
	translatedFrames: number;
	totalMs: number;
	lastError?: string;
	/** Original UI text of settings this extension translated. */
	settings: Map<object, { label: string; description: string }>;
	/** Original description properties of slash commands this extension translated. */
	slash: Map<object, PropertyDescriptor>;
	update?: Promise<UpdateResult>;
	updateResult?: UpdateResult;
	ternLink?: Promise<TernLinkResult>;
	ternLinkResult?: TernLinkResult;
}

const shared: Shared = ((globalThis as Record<symbol, Shared | undefined>)[Symbol.for("omp-tern-korean")] ??= {
	enabled: true,
	frames: 0,
	translatedFrames: 0,
	totalMs: 0,
	settings: new Map(),
	slash: new Map(),
});

const IN_TERN = process.env.TERM_PROGRAM === "tern" || process.env.TERN_PANE !== undefined;
/** Catalog building: a JSON file that collects UI strings without a translation. */
const CAPTURE_FILE = process.env.OMP_KO_CAPTURE;
/** Debugging: a file that receives every TSP write as omp sent it, before translation. */
const DUMP_FILE = process.env.OMP_KO_DUMP;
/** `0` turns the daily catalog download off; `OMP_KO_CATALOG_URL` points it elsewhere. */
const UPDATES = process.env.OMP_KO_UPDATE !== "0";
const CATALOG_URL = process.env.OMP_KO_CATALOG_URL || DEFAULT_CATALOG_URL;
/** `0` stops this extension from linking the Tern half into Tern. */
const TERN_LINK = process.env.OMP_KO_TERN !== "0";
const TERN_PLUGIN_DIR = path.join(import.meta.dir, "..", "tern-plugin");

let catalog: Catalog | undefined;
let catalogSource: "bundled" | "downloaded" = "bundled";
let catalogError: string | undefined;
try {
	catalog = createCatalog(parseCatalog(fs.readFileSync(bundledCatalogPath(), "utf8")), CAPTURE_FILE !== undefined);
} catch (err) {
	catalogError = err instanceof Error ? err.message : String(err);
}

const translate = (text: string): string | undefined => (shared.enabled ? catalog?.translate(text) : undefined);
shared.translator ??= new FrameTranslator(translate);
shared.translator.setTranslate(translate);

// ─── Tern: the TSP write boundary ──────────────────────────────────────────

// omp's internal modules are imported dynamically on purpose: a release that moves or drops one
// must turn that hook off, while a failed static import would stop the whole extension from loading.
const ProcessTerminal = await import("@oh-my-pi/pi-tui/terminal").then(
	module => (typeof module.ProcessTerminal?.prototype?.write === "function" ? module.ProcessTerminal : undefined),
	() => undefined,
);

function installWriteHook(): boolean {
	if (!ProcessTerminal) return false;
	const proto = ProcessTerminal.prototype as { write: Write };
	if (shared.wrapper && proto.write === shared.wrapper) return true;
	shared.originalWrite ??= proto.write;
	const original = shared.originalWrite;
	const translator = shared.translator!;
	shared.wrapper = function (this: unknown, data: string) {
		if (shared.enabled && typeof data === "string" && data.includes(TSP_PREFIX)) {
			if (DUMP_FILE) {
				try {
					fs.appendFileSync(DUMP_FILE, `${data}\n`);
				} catch {}
			}
			const started = performance.now();
			try {
				const rewritten = translateWrite(data, translator, DEFAULT_APC_LIMIT);
				shared.frames++;
				if (rewritten !== undefined) {
					data = rewritten;
					shared.translatedFrames++;
				}
			} catch (err) {
				shared.lastError = err instanceof Error ? (err.stack ?? err.message) : String(err);
			}
			shared.totalMs += performance.now() - started;
		}
		return original.call(this, data);
	};
	proto.write = shared.wrapper;
	return true;
}

// ─── Other terminals: data omp renders itself ──────────────────────────────

const registry = await import("@oh-my-pi/pi-coding-agent/config/registry").catch(() => undefined);
const slashRegistry = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry").catch(() => undefined);

function translateSettings(): number {
	let count = 0;
	for (const setting of registry?.all?.() ?? []) {
		// omp's settings UI metadata; only these two string fields are read and replaced.
		const ui = setting.ui as { label?: unknown; description?: unknown } | undefined;
		if (!ui || typeof ui.label !== "string" || typeof ui.description !== "string") continue;
		const saved = shared.settings.get(ui) ?? { label: ui.label, description: ui.description };
		const label = translate(saved.label);
		const description = translate(saved.description);
		if (label === undefined && description === undefined) continue;
		shared.settings.set(ui, saved);
		ui.label = label ?? saved.label;
		ui.description = description ?? saved.description;
		count++;
	}
	return count;
}

function restoreSettings(): void {
	for (const [ui, saved] of shared.settings) Object.assign(ui, saved);
	shared.settings.clear();
}

/** Puts a translating getter on `description`, keeping omp's own value (or getter) underneath. */
function translateDescription(target: object): boolean {
	const own = Object.getOwnPropertyDescriptor(target, "description");
	if (!own?.configurable) return false;
	const original = shared.slash.get(target) ?? own;
	const read = (): unknown => (original.get ? original.get.call(target) : original.value);
	shared.slash.set(target, original);
	Object.defineProperty(target, "description", {
		configurable: true,
		enumerable: original.enumerable,
		get() {
			const value = read();
			return typeof value === "string" ? (translate(value) ?? value) : value;
		},
	});
	return true;
}

function translateSlashCommands(): number {
	let count = 0;
	for (const command of slashRegistry?.BUILTIN_SLASH_COMMANDS_INTERNAL ?? []) {
		if (translateDescription(command)) count++;
		const subcommands = "subcommands" in command ? command.subcommands : undefined;
		if (!Array.isArray(subcommands)) continue;
		for (const sub of subcommands) if (sub && typeof sub === "object") translateDescription(sub);
	}
	return count;
}

function restoreSlashCommands(): void {
	for (const [target, descriptor] of shared.slash) Object.defineProperty(target, "description", descriptor);
	shared.slash.clear();
}

/** Switches to another catalog; the frame translator reads it on its next lookup. */
function useCatalog(file: CatalogFile, source: "bundled" | "downloaded"): void {
	catalog = createCatalog(file, CAPTURE_FILE !== undefined);
	catalogSource = source;
	catalogError = undefined;
	if (!IN_TERN && shared.enabled) translateSettings();
}

// ─── Capture of untranslated strings (catalog building) ────────────────────

let captureTimer: NodeJS.Timeout | undefined;
function startCapture(): void {
	if (!CAPTURE_FILE || captureTimer) return;
	let written = 0;
	captureTimer = setInterval(() => {
		const misses = catalog?.misses;
		if (!misses || misses.size === written) return;
		written = misses.size;
		try {
			fs.writeFileSync(CAPTURE_FILE, `${JSON.stringify([...misses].sort(), null, "\t")}\n`);
		} catch {}
	}, 2000);
	captureTimer.unref?.();
}

// ─── Status ────────────────────────────────────────────────────────────────

function describeUpdate(): string {
	if (!UPDATES) return "꺼짐 (OMP_KO_UPDATE=0)";
	const result = shared.updateResult;
	if (!result) return shared.update ? "확인하는 중" : "아직 확인하지 않았습니다";
	switch (result.status) {
		case "recent":
			return "오늘 이미 확인했습니다";
		case "not-modified":
			return "새 번역이 없습니다";
		case "older":
			return `받은 카탈로그(${result.revision})가 지금 것보다 오래되었습니다`;
		case "updated":
			return `새 번역을 받았습니다 (${result.catalog.revision})`;
		case "failed":
			return `확인하지 못했습니다 (${result.error})`;
	}
}

function describeTernLink(): string {
	if (!IN_TERN) return "Tern 밖에서는 확인하지 않습니다";
	if (!TERN_LINK) return "자동 연결 꺼짐 (OMP_KO_TERN=0)";
	if (!process.env.TERN_EXE) return "tern 실행 파일을 찾지 못했습니다";
	const result = shared.ternLinkResult;
	if (!result) return "확인하는 중";
	switch (result.state) {
		case "linked":
			return "연결했습니다";
		case "relinked":
			return "새 위치로 다시 연결했습니다";
		case "present":
			return "연결되어 있습니다";
		case "installed":
			return `따로 설치된 사본을 씁니다 (${result.target})`;
		case "elsewhere":
			return `다른 폴더에 연결되어 있습니다 (${result.target})`;
		case "failed":
			return `연결하지 못했습니다 (${result.error})`;
	}
}

// ─── Extension ─────────────────────────────────────────────────────────────

export default function ompTernKorean(pi: ExtensionAPI): void {
	pi.setLabel("한국어 번역");
	const agentDir = typeof pi.pi.getAgentDir === "function" ? pi.pi.getAgentDir() : path.join(os.homedir(), ".omp", "agent");
	const cacheDir = path.join(agentDir, "cache", "omp-tern-korean");
	const cached = UPDATES ? readCachedCatalog(cacheDir) : undefined;
	if (cached && cached.revision > (catalog?.revision ?? -1)) useCatalog(cached, "downloaded");

	const tsp = installWriteHook();
	const settingsCount = IN_TERN ? 0 : translateSettings();
	const slashCount = IN_TERN ? 0 : translateSlashCommands();
	startCapture();

	const startUpdate = (intervalMs?: number): Promise<UpdateResult> => {
		shared.updateResult = undefined;
		shared.update = checkForUpdate({ url: CATALOG_URL, cacheDir, currentRevision: catalog?.revision ?? 0, intervalMs }).then(result => {
			shared.updateResult = result;
			if (result.status === "updated") useCatalog(result.catalog, "downloaded");
			return result;
		});
		return shared.update;
	};

	pi.on("session_start", () => {
		if (UPDATES && !shared.update) void startUpdate();
		const ternExe = process.env.TERN_EXE;
		if (IN_TERN && TERN_LINK && ternExe && !shared.ternLink) {
			shared.ternLink = ensureTernPlugin(TERN_PLUGIN_DIR, runTernWith(ternExe)).then(result => {
				shared.ternLinkResult = result;
				return result;
			});
		}
	});

	const setEnabled = (enabled: boolean, ctx: ExtensionContext): void => {
		shared.enabled = enabled;
		if (!IN_TERN) {
			if (enabled) {
				translateSettings();
				translateSlashCommands();
			} else {
				restoreSettings();
				restoreSlashCommands();
			}
		}
		ctx.ui.notify(enabled ? "한국어 번역을 켰습니다." : "한국어 번역을 껐습니다.", "info");
	};

	// A shortcut also makes omp load this extension before the first frame instead of after the
	// composer accepts input, so the startup screen is translated too.
	pi.registerShortcut("ctrl+alt+k", {
		description: "한국어 번역 켜기/끄기",
		handler: ctx => setEnabled(!shared.enabled, ctx),
	});

	pi.registerCommand("ko", {
		description: "한국어 번역 상태를 보거나 켜고 끄거나 새 번역을 받습니다 (status | on | off | update)",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "on" || action === "off") {
				setEnabled(action === "on", ctx);
				return;
			}
			if (action === "update") {
				if (!UPDATES) {
					ctx.ui.notify("번역 자동 업데이트가 꺼져 있습니다 (OMP_KO_UPDATE=0).", "warning");
					return;
				}
				await startUpdate(0);
				ctx.ui.notify(`번역 업데이트: ${describeUpdate()}`, "info");
				return;
			}
			const average = shared.frames === 0 ? 0 : shared.totalMs / shared.frames;
			const lines = [
				`상태: ${shared.enabled ? "켜짐" : "꺼짐"}`,
				catalog
					? `카탈로그: ${catalog.size}개 항목, revision ${catalog.revision} (${catalogSource === "bundled" ? "플러그인에 포함된 것" : "내려받은 것"})`
					: `카탈로그: 불러오지 못했습니다 (${catalogError})`,
				`번역 업데이트: ${describeUpdate()}`,
				`Tern 프레임 번역: ${tsp ? "동작 중" : "꺼짐 (대상이 없습니다)"}, 프레임 ${shared.frames}개 중 ${shared.translatedFrames}개 번역, 평균 ${average.toFixed(3)} ms`,
				`Tern 플러그인: ${describeTernLink()}`,
				`설정·슬래시 명령: ${IN_TERN ? "Tern에서는 프레임에서 번역합니다" : `설정 ${settingsCount}개, 슬래시 명령 ${slashCount}개`}`,
			];
			if (shared.lastError) lines.push(`마지막 오류: ${shared.lastError.split("\n")[0]}`);
			// Tern's toast flows lines into one paragraph; separators keep the fields apart.
			ctx.ui.notify(lines.join(" · "), "info");
		},
	});
}
