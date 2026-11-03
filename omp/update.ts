/**
 * Daily catalog refresh: translations published after a release reach users without a plugin upgrade.
 *
 * The catalog is downloaded with `If-None-Match`, stored under the agent's cache directory, and used
 * whenever its revision is higher than the copy bundled with the installed plugin.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type CatalogFile, parseCatalog } from "./catalog.ts";

export const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/jinhyeok694/omp-tern-korean/main/catalog/ko.json";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

interface Meta {
	etag?: string;
	checkedAt?: number;
}

export interface UpdateOptions {
	url: string;
	cacheDir: string;
	/** Revision in use now; a download replaces it only when newer. */
	currentRevision: number;
	intervalMs?: number;
	now?: number;
	fetch?: typeof fetch;
}

export type UpdateResult =
	| { status: "recent" }
	| { status: "not-modified" }
	| { status: "older"; revision: number }
	| { status: "updated"; catalog: CatalogFile }
	| { status: "failed"; error: string };

const catalogFile = (cacheDir: string): string => path.join(cacheDir, "ko.json");
const metaFile = (cacheDir: string): string => path.join(cacheDir, "meta.json");

/** The downloaded catalog, or undefined when there is none or it is unreadable. */
export function readCachedCatalog(cacheDir: string): CatalogFile | undefined {
	try {
		return parseCatalog(fs.readFileSync(catalogFile(cacheDir), "utf8"));
	} catch {
		return undefined;
	}
}

function readMeta(cacheDir: string): Meta {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(metaFile(cacheDir), "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		return {
			etag: "etag" in parsed && typeof parsed.etag === "string" ? parsed.etag : undefined,
			checkedAt: "checkedAt" in parsed && typeof parsed.checkedAt === "number" ? parsed.checkedAt : undefined,
		};
	} catch {
		return {};
	}
}

/** Writes through a temporary file, so another omp process never reads half a catalog. */
function writeAtomic(file: string, text: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, text);
	fs.renameSync(temporary, file);
}

export async function checkForUpdate(options: UpdateOptions): Promise<UpdateResult> {
	const now = options.now ?? Date.now();
	const meta = readMeta(options.cacheDir);
	if (meta.checkedAt !== undefined && now - meta.checkedAt < (options.intervalMs ?? CHECK_INTERVAL_MS)) return { status: "recent" };
	const haveCache = fs.existsSync(catalogFile(options.cacheDir));
	try {
		const response = await (options.fetch ?? fetch)(options.url, {
			headers: haveCache && meta.etag ? { "If-None-Match": meta.etag } : {},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		fs.mkdirSync(options.cacheDir, { recursive: true });
		if (response.status === 304) {
			writeAtomic(metaFile(options.cacheDir), JSON.stringify({ ...meta, checkedAt: now }));
			return { status: "not-modified" };
		}
		if (!response.ok) return { status: "failed", error: `HTTP ${response.status}` };
		const text = await response.text();
		const catalog = parseCatalog(text);
		writeAtomic(catalogFile(options.cacheDir), text);
		writeAtomic(metaFile(options.cacheDir), JSON.stringify({ etag: response.headers.get("etag") ?? undefined, checkedAt: now }));
		return catalog.revision > options.currentRevision ? { status: "updated", catalog } : { status: "older", revision: catalog.revision };
	} catch (err) {
		return { status: "failed", error: err instanceof Error ? err.message : String(err) };
	}
}
