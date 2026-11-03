/**
 * Installs the Tern half next to the omp half. In a Tern pane, this package's `tern-plugin/` is
 * copied into a folder of its own under the agent's cache directory, and that folder is linked into
 * Tern's plugin directory.
 *
 * The copy keeps the link stable: omp keeps plugins in version-named folders that an upgrade
 * replaces, and on Windows a folder Tern has loaded cannot be renamed, which makes `omp plugin
 * upgrade` fail. Every start refreshes the copy, so an upgrade reaches Tern without relinking.
 *
 * Left alone: a Tern half installed as a copy (`tern plugin install`), and a link to a folder the
 * user keeps elsewhere (a development checkout).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const TERN_PLUGIN_ID = "ko-kr";
/** The files Tern loads from the plugin folder. */
const TERN_PLUGIN_FILES = ["plugin.toml", "window.luau", "ko-kr.css", "ko.json"] as const;

export type TernLinkResult =
	| { state: "linked" | "relinked" | "present" }
	| { state: "installed" | "elsewhere"; target: string }
	| { state: "failed"; error: string };

export type RunTern = (args: string[]) => Promise<string>;

export function runTernWith(exe: string): RunTern {
	return args => {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(exe, args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${[exe, ...args].join(" ")}: ${stderr.trim() || error.message}`));
			else resolve(stdout.trim());
		});
		return promise;
	};
}

function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		const resolved = path.resolve(p);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return norm(a) === norm(b);
}

/** Whether `dir` is a version folder of this plugin in omp's plugin cache, which an upgrade replaces. */
function isOmpCacheCopy(dir: string): boolean {
	return /omp-tern-korean___/.test(dir) || /[\\/]plugins[\\/](cache|node_modules)[\\/]/.test(dir);
}

/** Copies the Tern half's files from `sourceDir` to `targetDir` where they differ; returns how many changed. */
export function syncTernPlugin(sourceDir: string, targetDir: string): number {
	fs.mkdirSync(targetDir, { recursive: true });
	let changed = 0;
	for (const name of TERN_PLUGIN_FILES) {
		const next = fs.readFileSync(path.join(sourceDir, name));
		const target = path.join(targetDir, name);
		let current: Buffer | undefined;
		try {
			current = fs.readFileSync(target);
		} catch {}
		if (current?.equals(next)) continue;
		// Write then rename, so Tern's reload on change never reads half a file.
		const temporary = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, next);
		fs.renameSync(temporary, target);
		changed++;
	}
	return changed;
}

/** Refreshes the copy in `stableDir` from `sourceDir` and makes sure Tern loads it. */
export async function ensureTernPlugin(sourceDir: string, stableDir: string, runTern: RunTern): Promise<TernLinkResult> {
	try {
		if (!fs.existsSync(path.join(sourceDir, "plugin.toml"))) return { state: "failed", error: `${sourceDir} has no plugin.toml` };
		const pluginsDir = await runTern(["plugin", "dir"]);
		const installed = path.join(pluginsDir, TERN_PLUGIN_ID);
		if (fs.existsSync(path.join(installed, "plugin.toml"))) return { state: "installed", target: installed };
		const linkFile = path.join(pluginsDir, `${TERN_PLUGIN_ID}.path`);
		let target: string | undefined;
		try {
			target = fs.readFileSync(linkFile, "utf8").trim();
		} catch {}
		const targetLoads = target !== undefined && fs.existsSync(path.join(target, "plugin.toml"));
		if (target && targetLoads && !samePath(target, stableDir) && !isOmpCacheCopy(target)) return { state: "elsewhere", target };
		syncTernPlugin(sourceDir, stableDir);
		if (target && samePath(target, stableDir)) return { state: "present" };
		await runTern(["plugin", "link", stableDir]);
		return { state: target ? "relinked" : "linked" };
	} catch (err) {
		return { state: "failed", error: err instanceof Error ? err.message : String(err) };
	}
}
