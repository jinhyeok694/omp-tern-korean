import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkForUpdate, readCachedCatalog } from "../omp/update.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ko-update-"));
	dirs.push(dir);
	return dir;
};

const catalogBody = (revision: number) => JSON.stringify({ version: 1, revision, strings: { Close: "닫기" }, templates: {} });

/** A fetch double serving one body with an ETag and honouring If-None-Match; records request headers. */
function server(body: string, etag = '"v1"') {
	const seen: Record<string, string>[] = [];
	const fake = (async (_url: string, init?: RequestInit) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		seen.push(headers);
		if (headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
		return new Response(body, { status: 200, headers: { etag } });
	}) as unknown as typeof fetch;
	return { fetch: fake, seen };
}

describe("checkForUpdate", () => {
	test("downloads a newer catalog, caches it, then revalidates with the ETag after the interval", async () => {
		const cacheDir = tempDir();
		const remote = server(catalogBody(10));
		const first = await checkForUpdate({ url: "u", cacheDir, currentRevision: 5, now: 1000, fetch: remote.fetch });
		expect(first.status).toBe("updated");
		expect(readCachedCatalog(cacheDir)?.revision).toBe(10);
		expect(remote.seen[0]).toEqual({});

		const recent = await checkForUpdate({ url: "u", cacheDir, currentRevision: 10, now: 2000, fetch: remote.fetch });
		expect(recent.status).toBe("recent");
		expect(remote.seen.length).toBe(1);

		const day = 24 * 60 * 60 * 1000;
		const later = await checkForUpdate({ url: "u", cacheDir, currentRevision: 10, now: 1000 + day, fetch: remote.fetch });
		expect(later.status).toBe("not-modified");
		expect(remote.seen[1]).toEqual({ "If-None-Match": '"v1"' });
	});

	test("keeps the current catalog when the download is not newer", async () => {
		const result = await checkForUpdate({ url: "u", cacheDir: tempDir(), currentRevision: 20, fetch: server(catalogBody(10)).fetch });
		expect(result).toEqual({ status: "older", revision: 10 });
	});

	test("fails without touching the cache on errors and invalid bodies", async () => {
		const cacheDir = tempDir();
		const broken = await checkForUpdate({ url: "u", cacheDir, currentRevision: 0, fetch: server("not json").fetch });
		expect(broken.status).toBe("failed");
		const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		expect((await checkForUpdate({ url: "u", cacheDir, currentRevision: 0, fetch: down })).status).toBe("failed");
		expect(readCachedCatalog(cacheDir)).toBeUndefined();
	});

	test("does not send If-None-Match when the cached catalog is gone", async () => {
		const cacheDir = tempDir();
		const remote = server(catalogBody(3));
		await checkForUpdate({ url: "u", cacheDir, currentRevision: 0, now: 0, fetch: remote.fetch });
		fs.rmSync(path.join(cacheDir, "ko.json"));
		const again = await checkForUpdate({ url: "u", cacheDir, currentRevision: 0, now: 0, intervalMs: 0, fetch: remote.fetch });
		expect(remote.seen[1]).toEqual({});
		expect(again.status).toBe("updated");
	});
});
