/**
 * Korean line breaking for Tern.
 *
 * Korean breaks lines between words (어절), at spaces, like English. Tern breaks Korean between any
 * two syllables instead, and its CSS has no `word-break: keep-all` to change that, so a wrapped
 * sentence splits words ("작업 줄" / "의 세션") and a short label in a tight box stacks one syllable
 * per line. A WORD JOINER (U+2060: no width, no glyph, no break on either side) between the
 * characters of each Korean word leaves Tern only the spaces to break at. A word too wide for its
 * line still breaks where Tern's CSS sets `overflow-wrap: anywhere`.
 */

export const WORD_JOINER = "\u2060";

/** Hangul syllables, jamo and compatibility jamo. */
const HANGUL = "\\u1100-\\u11ff\\u3130-\\u318f\\uac00-\\ud7a3";
/**
 * Neighbours a Korean word may break at: whitespace, the joiner itself, and separators Tern may
 * break after (`켜기/끄기`, `빠름 · 느림`, `— 설명`).
 */
const BREAKABLE = "\\s\\u2060/|·—–";
const WITHIN_WORD = new RegExp(`(?<=[${HANGUL}])(?=[^${BREAKABLE}])|(?<=[^${BREAKABLE}])(?=[${HANGUL}])`, "g");

/**
 * `text` with every Korean word joined into one unbreakable run: between two Hangul characters,
 * and between Hangul and what it touches (`omp에서`, `3개`, `(기본값)`, a placeholder in `{0}로`).
 */
export function keepWords(text: string): string {
	return text.replace(WITHIN_WORD, WORD_JOINER);
}
