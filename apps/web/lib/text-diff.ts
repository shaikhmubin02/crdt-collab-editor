export interface TextEdit {
  /** Visible index where the edit starts. */
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
}

/**
 * The single contiguous edit that turns `prev` into `next`, as produced by one textarea `input`
 * event (typing, paste, cut, backspace, replace-selection, autocorrect).
 *
 * A pure prefix/suffix diff is ambiguous for repeated characters: typing "a" at position 1 of
 * "aa" yields "aaa", and the common prefix alone would place the insert at 2. Locally the text is
 * the same, but for a CRDT the position matters: it decides the origin, and so where the text
 * lands relative to concurrent edits. The caret disambiguates: after an input event it sits at
 * the end of the inserted text, so the edit cannot start after `caret - insertedLength`.
 *
 * Never splits a surrogate pair: an edit boundary inside one is moved outward.
 */
export function diffText(prev: string, next: string, caret?: number): TextEdit {
  let prefix = 0;
  const maxPrefix = Math.min(prev.length, next.length);
  while (prefix < maxPrefix && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  if (caret !== undefined) {
    const grown = Math.max(0, next.length - prev.length);
    prefix = Math.max(0, Math.min(prefix, caret - grown));
  }
  if (prefix > 0 && isHighSurrogate(prev.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  const maxSuffix = Math.min(prev.length, next.length) - prefix;
  while (
    suffix < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(prev.charCodeAt(prev.length - suffix))) suffix--;

  return {
    index: prefix,
    deleteCount: prev.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
