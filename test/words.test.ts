import { describe, expect, test } from "bun:test";
import { keepWords, WORD_JOINER } from "../omp/words.ts";

const shown = (text: string) => text.replaceAll(WORD_JOINER, "·");

describe("keepWords", () => {
	test("joins the syllables of each Korean word and leaves the spaces as the only breaks", () => {
		expect(shown(keepWords("작업 줄의 세션"))).toBe("작·업 줄·의 세·션");
	});

	test("keeps a particle on the word, number, code or placeholder it follows", () => {
		expect(shown(keepWords("omp에서 3개를"))).toBe("omp·에·서 3·개·를");
		expect(shown(keepWords("\ufdd0로 반복"))).toBe("\ufdd0·로 반·복");
		expect(shown(keepWords("(기본값)"))).toBe("(·기·본·값·)");
	});

	test("leaves English, and the separators Korean may break after, untouched", () => {
		expect(keepWords("Fetch all")).toBe("Fetch all");
		expect(shown(keepWords("켜기/끄기 · 빠름"))).toBe("켜·기/끄·기 · 빠·름");
	});
});
