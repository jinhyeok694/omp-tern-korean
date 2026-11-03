/**
 * Collects Tern's built-in palette commands (id and English label) from the published reference.
 *
 *   bun tools/extract-tern.ts [--out tern-plugin/source.json]
 *
 * Reads the "Commands" section of https://docs.stencil.so/tern/reference/actions.md, which lists
 * every command id with its palette label. Keymap-only actions, which have no palette row, are skipped.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DOC = "https://docs.stencil.so/tern/reference/actions.md";

export interface TernSource {
	version: 1;
	actions: { id: string; label: string }[];
}

export function parseActions(markdown: string): TernSource["actions"] {
	const start = markdown.indexOf("\n## Commands");
	const end = markdown.indexOf("\n## ", start + 1);
	if (start === -1) throw new Error("actions.md: no Commands section");
	const section = markdown.slice(start, end === -1 ? undefined : end);
	const actions: TernSource["actions"] = [];
	const seen = new Set<string>();
	for (const line of section.split("\n")) {
		const match = /^\|\s*`([a-z][\w:.-]*)`\s*\|\s*([^|]+?)\s*\|/.exec(line);
		if (!match || seen.has(match[1]!)) continue;
		seen.add(match[1]!);
		actions.push({ id: match[1]!, label: match[2]!.replaceAll("\\|", "|") });
	}
	return actions;
}

if (import.meta.main) {
	const index = process.argv.indexOf("--out");
	const out = index === -1 ? path.join(import.meta.dir, "..", "tern-plugin", "source.json") : process.argv[index + 1]!;
	const response = await fetch(DOC);
	if (!response.ok) throw new Error(`${DOC}: ${response.status}`);
	const actions = parseActions(await response.text());
	if (actions.length < 100) throw new Error(`${DOC}: only ${actions.length} commands parsed; the page layout changed`);
	const result: TernSource = { version: 1, actions };
	fs.writeFileSync(out, `${JSON.stringify(result, null, "\t")}\n`);
	console.log(`Tern: ${actions.length} palette commands → ${out}`);
}
