import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureTernPlugin } from "../omp/tern-link.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake Tern: a plugins directory, and `plugin link` writing `<id>.path` as Tern does. */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ko-link-"));
	dirs.push(root);
	const pluginsDir = path.join(root, "tern-plugins");
	fs.mkdirSync(pluginsDir);
	const plugin = (dir: string) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "plugin.toml"), 'id = "ko-kr"\n');
		return dir;
	};
	const calls: string[][] = [];
	const runTern = async (args: string[]) => {
		calls.push(args);
		if (args[1] === "dir") return pluginsDir;
		if (args[1] === "link") fs.writeFileSync(path.join(pluginsDir, "ko-kr.path"), args[2]!);
		return "";
	};
	return { root, pluginsDir, plugin, calls, runTern };
}

describe("ensureTernPlugin", () => {
	test("links when Tern has no ko-kr plugin, then finds it present", async () => {
		const t = setup();
		const ours = t.plugin(path.join(t.root, "omp-tern-korean___omp-tern-korean___0.2.0", "tern-plugin"));
		expect(await ensureTernPlugin(ours, t.runTern)).toEqual({ state: "linked" });
		expect(await ensureTernPlugin(ours, t.runTern)).toEqual({ state: "present" });
		expect(t.calls.filter(args => args[1] === "link").length).toBe(1);
	});

	test("relinks after an omp upgrade moved the package, even when the old folder is gone", async () => {
		const t = setup();
		const old = path.join(t.root, "omp-tern-korean___omp-tern-korean___0.1.0", "tern-plugin");
		fs.writeFileSync(path.join(t.pluginsDir, "ko-kr.path"), old);
		const ours = t.plugin(path.join(t.root, "omp-tern-korean___omp-tern-korean___0.2.0", "tern-plugin"));
		expect(await ensureTernPlugin(ours, t.runTern)).toEqual({ state: "relinked" });
		expect(fs.readFileSync(path.join(t.pluginsDir, "ko-kr.path"), "utf8")).toBe(ours);
	});

	test("leaves an installed copy and a link to the user's own checkout alone", async () => {
		const t = setup();
		const ours = t.plugin(path.join(t.root, "omp-tern-korean___omp-tern-korean___0.2.0", "tern-plugin"));
		const checkout = t.plugin(path.join(t.root, "src", "omp-tern-korean", "tern-plugin"));
		fs.writeFileSync(path.join(t.pluginsDir, "ko-kr.path"), checkout);
		expect(await ensureTernPlugin(ours, t.runTern)).toEqual({ state: "elsewhere", target: checkout });
		t.plugin(path.join(t.pluginsDir, "ko-kr"));
		expect((await ensureTernPlugin(ours, t.runTern)).state).toBe("installed");
		expect(t.calls.some(args => args[1] === "link")).toBe(false);
	});

	test("reports a failing tern command instead of throwing", async () => {
		const t = setup();
		const ours = t.plugin(path.join(t.root, "pkg", "tern-plugin"));
		const failing = async () => {
			throw new Error("tern: no daemon");
		};
		expect(await ensureTernPlugin(ours, failing)).toEqual({ state: "failed", error: "tern: no daemon" });
	});
});
