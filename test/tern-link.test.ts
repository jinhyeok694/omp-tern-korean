import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureTernPlugin, syncTernPlugin } from "../omp/tern-link.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const FILES = ["plugin.toml", "window.luau", "ko-kr.css", "ko.json"];

/** A fake Tern: a plugins directory, and `plugin link` writing `<id>.path` as Tern does. */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ko-link-"));
	dirs.push(root);
	const pluginsDir = path.join(root, "tern-plugins");
	fs.mkdirSync(pluginsDir);
	const plugin = (dir: string, body = "v1") => {
		fs.mkdirSync(dir, { recursive: true });
		for (const name of FILES) fs.writeFileSync(path.join(dir, name), `${name} ${body}`);
		return dir;
	};
	const calls: string[][] = [];
	const runTern = async (args: string[]) => {
		calls.push(args);
		if (args[1] === "dir") return pluginsDir;
		if (args[1] === "link") fs.writeFileSync(path.join(pluginsDir, "ko-kr.path"), args[2]!);
		return "";
	};
	const stable = path.join(root, "agent", "cache", "omp-tern-korean", "tern-plugin");
	return { root, pluginsDir, plugin, calls, runTern, stable };
}

describe("ensureTernPlugin", () => {
	test("copies the Tern half to the stable folder and links it once", async () => {
		const t = setup();
		const source = t.plugin(path.join(t.root, "omp-tern-korean___omp-tern-korean___0.2.0", "tern-plugin"));
		expect(await ensureTernPlugin(source, t.stable, t.runTern)).toEqual({ state: "linked" });
		expect(fs.readFileSync(path.join(t.stable, "window.luau"), "utf8")).toBe("window.luau v1");
		expect(await ensureTernPlugin(source, t.stable, t.runTern)).toEqual({ state: "present" });
		expect(t.calls.filter(args => args[1] === "link").length).toBe(1);
	});

	test("an upgrade refreshes the copy without relinking", async () => {
		const t = setup();
		await ensureTernPlugin(t.plugin(path.join(t.root, "pkg-0.1.0", "tern-plugin")), t.stable, t.runTern);
		const upgraded = t.plugin(path.join(t.root, "pkg-0.2.0", "tern-plugin"), "v2");
		expect(await ensureTernPlugin(upgraded, t.stable, t.runTern)).toEqual({ state: "present" });
		expect(fs.readFileSync(path.join(t.stable, "ko.json"), "utf8")).toBe("ko.json v2");
		expect(syncTernPlugin(upgraded, t.stable)).toBe(0);
	});

	test("moves a link that points into omp's version folders to the stable copy", async () => {
		const t = setup();
		const old = t.plugin(path.join(t.root, "omp-tern-korean___omp-tern-korean___0.1.0", "tern-plugin"));
		fs.writeFileSync(path.join(t.pluginsDir, "ko-kr.path"), old);
		expect(await ensureTernPlugin(old, t.stable, t.runTern)).toEqual({ state: "relinked" });
		expect(fs.readFileSync(path.join(t.pluginsDir, "ko-kr.path"), "utf8")).toBe(t.stable);
	});

	test("leaves an installed copy and a link to the user's own checkout alone", async () => {
		const t = setup();
		const source = t.plugin(path.join(t.root, "pkg", "tern-plugin"));
		const checkout = t.plugin(path.join(t.root, "src", "omp-tern-korean", "tern-plugin"));
		fs.writeFileSync(path.join(t.pluginsDir, "ko-kr.path"), checkout);
		expect(await ensureTernPlugin(source, t.stable, t.runTern)).toEqual({ state: "elsewhere", target: checkout });
		t.plugin(path.join(t.pluginsDir, "ko-kr"));
		expect((await ensureTernPlugin(source, t.stable, t.runTern)).state).toBe("installed");
		expect(t.calls.some(args => args[1] === "link")).toBe(false);
		expect(fs.existsSync(t.stable)).toBe(false);
	});

	test("reports a failing tern command instead of throwing", async () => {
		const t = setup();
		const source = t.plugin(path.join(t.root, "pkg", "tern-plugin"));
		const failing = async () => {
			throw new Error("tern: no daemon");
		};
		expect(await ensureTernPlugin(source, t.stable, failing)).toEqual({ state: "failed", error: "tern: no daemon" });
	});
});
