/**
 * Installs the Tern half next to the omp half: in a Tern pane, links this package's `tern-plugin/`
 * into Tern's plugin directory, and links it again after an omp plugin upgrade moved the package.
 *
 * Left alone: a Tern half installed as a copy (`tern plugin install`), and a link to a folder the
 * user keeps elsewhere (a development checkout).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const TERN_PLUGIN_ID = "ko-kr";

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

export async function ensureTernPlugin(pluginDir: string, runTern: RunTern): Promise<TernLinkResult> {
	try {
		if (!fs.existsSync(path.join(pluginDir, "plugin.toml"))) return { state: "failed", error: `${pluginDir} has no plugin.toml` };
		const pluginsDir = await runTern(["plugin", "dir"]);
		const installed = path.join(pluginsDir, TERN_PLUGIN_ID);
		if (fs.existsSync(path.join(installed, "plugin.toml"))) return { state: "installed", target: installed };
		const linkFile = path.join(pluginsDir, `${TERN_PLUGIN_ID}.path`);
		let target: string | undefined;
		try {
			target = fs.readFileSync(linkFile, "utf8").trim();
		} catch {}
		if (target && samePath(target, pluginDir)) return { state: "present" };
		const targetLoads = target !== undefined && fs.existsSync(path.join(target, "plugin.toml"));
		if (target && targetLoads && !isOmpCacheCopy(target)) return { state: "elsewhere", target };
		await runTern(["plugin", "link", pluginDir]);
		return { state: target ? "relinked" : "linked" };
	} catch (err) {
		return { state: "failed", error: err instanceof Error ? err.message : String(err) };
	}
}
