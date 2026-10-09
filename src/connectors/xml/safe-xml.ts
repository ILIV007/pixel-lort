/**
 * Bounded, entity-safe XML scanner (Phase 4 — ADR-0039 §3).
 *
 * A hand-rolled pull-style scanner for RSS 2.0 / Atom feeds. Zero runtime
 * dependencies (ADR-0003 heritage); the parser concentrates feed-parsing
 * risk in one small, exhaustively tested module instead of a dependency
 * whose entity behavior must be re-audited per release.
 *
 * Security posture (fail safe):
 * - `<!DOCTYPE` and `<!ENTITY` are REJECTED outright — no entity
 *   expansion, no network resolution, no billion-laughs surface.
 * - Conditional sections (`<![INCLUDE[` / `<![IGNORE[`) are rejected.
 * - Only the five predefined XML entities and numeric character
 *   references are decoded; any other named entity is a parse FAILURE.
 * - CDATA is literal text (terminated only by `]]>`).
 * - Hard bounds: depth, element count, text-node size, attribute count,
 *   attribute value size — malformed or hostile input fails safely.
 *
 * The scanner never resolves external identifiers and never performs
 * network I/O.
 */

export type XmlParseFailureReason =
  | 'doctype_rejected'
  | 'entity_decl_rejected'
  | 'conditional_section_rejected'
  | 'unknown_entity'
  | 'malformed_markup'
  | 'depth_exceeded'
  | 'element_count_exceeded'
  | 'text_too_long'
  | 'truncated_input'
  | 'cdata_unterminated'
  | 'attr_too_long'
  | 'tag_mismatch';

export interface XmlParseError {
  readonly reason: XmlParseFailureReason;
}

export interface XmlTextEvent {
  readonly kind: 'text';
  /** Decoded text (entities resolved, CDATA literal). */
  readonly text: string;
}

export interface XmlOpenEvent {
  readonly kind: 'open';
  /** Local name (namespace prefix stripped). */
  readonly name: string;
  /** Raw qualified name as written. */
  readonly qualified: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
}

export interface XmlCloseEvent {
  readonly kind: 'close';
  readonly name: string;
  readonly qualified: string;
}

export type XmlEvent = XmlTextEvent | XmlOpenEvent | XmlCloseEvent;

/** Hard bounds (ADR-0039 §3). */
export const XML_BOUNDS = {
  maxDepth: 64,
  maxElements: 20_000,
  maxTextNodeChars: 65_536,
  maxAttributes: 32,
  maxAttrValueChars: 4_096,
} as const;

export type XmlScanResult =
  | { readonly ok: true; readonly events: readonly XmlEvent[] }
  | { readonly ok: false; readonly error: XmlParseError };

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode XML character data: predefined entities + numeric refs only. */
export function decodeXmlEntities(input: string): { ok: true; text: string } | { ok: false; reason: XmlParseFailureReason } {
  if (!input.includes('&')) {
    return { ok: true, text: input };
  }
  let out = '';
  let i = 0;
  while (i < input.length) {
    const amp = input.indexOf('&', i);
    if (amp === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, amp);
    const semi = input.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) {
      return { ok: false, reason: 'malformed_markup' };
    }
    const entity = input.slice(amp + 1, semi);
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        return { ok: false, reason: 'malformed_markup' };
      }
      out += String.fromCodePoint(code);
    } else if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        return { ok: false, reason: 'malformed_markup' };
      }
      out += String.fromCodePoint(code);
    } else {
      const mapped = PREDEFINED_ENTITIES[entity];
      if (mapped === undefined) {
        return { ok: false, reason: 'unknown_entity' };
      }
      out += mapped;
    }
    i = semi + 1;
  }
  return { ok: true, text: out };
}

/** Strip a namespace prefix (`content:encoded` → `encoded`). */
export function localName(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

/**
 * Scan a complete XML document into bounded events. Malformed input never
 * throws — a typed failure is returned.
 */
export function scanXmlDocument(input: string): XmlScanResult {
  const events: XmlEvent[] = [];
  const openStack: string[] = [];
  let elementCount = 0;
  let i = 0;
  const len = input.length;

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      // Trailing text after the last element: whitespace is tolerated;
      // non-whitespace tail means truncation (unclosed elements).
      const tail = input.slice(i);
      if (tail.trim() !== '') {
        return {
          ok: false,
          error: { reason: openStack.length > 0 ? 'tag_mismatch' : 'malformed_markup' },
        };
      }
      break;
    }
    if (lt > i) {
      const rawText = input.slice(i, lt);
      if (openStack.length > 0) {
        const decoded = decodeXmlEntities(rawText);
        if (!decoded.ok) {
          return { ok: false, error: { reason: decoded.reason } };
        }
        if (decoded.text.length > XML_BOUNDS.maxTextNodeChars) {
          return { ok: false, error: { reason: 'text_too_long' } };
        }
        if (decoded.text.length > 0) {
          events.push({ kind: 'text', text: decoded.text });
        }
      }
      // Whitespace outside the root is tolerated.
    }

    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) {
        return { ok: false, error: { reason: 'truncated_input' } };
      }
      i = end + 2;
      continue;
    }
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) {
        return { ok: false, error: { reason: 'truncated_input' } };
      }
      i = end + 3;
      continue;
    }
    if (input.startsWith('<![', lt)) {
      // Conditional sections are a DTD feature — rejected with DOCTYPE.
      const upper = input.slice(lt, lt + 12).toUpperCase();
      if (upper.startsWith('<![INCLUDE[') || upper.startsWith('<![IGNORE[')) {
        return { ok: false, error: { reason: 'conditional_section_rejected' } };
      }
      if (input.startsWith('<![CDATA[', lt)) {
        const end = input.indexOf(']]>', lt + 9);
        if (end === -1) {
          return { ok: false, error: { reason: 'cdata_unterminated' } };
        }
        const text = input.slice(lt + 9, end);
        if (text.length > XML_BOUNDS.maxTextNodeChars) {
          return { ok: false, error: { reason: 'text_too_long' } };
        }
        if (openStack.length > 0 && text.length > 0) {
          events.push({ kind: 'text', text });
        }
        i = end + 3;
        continue;
      }
      return { ok: false, error: { reason: 'malformed_markup' } };
    }
    if (input.startsWith('<!', lt)) {
      const upper = input.slice(lt, lt + 16).toUpperCase();
      if (upper.startsWith('<!DOCTYPE')) {
        return { ok: false, error: { reason: 'doctype_rejected' } };
      }
      if (upper.startsWith('<!ENTITY')) {
        return { ok: false, error: { reason: 'entity_decl_rejected' } };
      }
      return { ok: false, error: { reason: 'malformed_markup' } };
    }

    // Element: close, open, or self-closing.
    if (input.startsWith('</', lt)) {
      const end = input.indexOf('>', lt + 2);
      if (end === -1) {
        return { ok: false, error: { reason: 'truncated_input' } };
      }
      const qualified = input.slice(lt + 2, end).trim();
      if (!isValidTagName(qualified)) {
        return { ok: false, error: { reason: 'malformed_markup' } };
      }
      const top = openStack.pop();
      if (top === undefined || top !== qualified) {
        return { ok: false, error: { reason: 'tag_mismatch' } };
      }
      events.push({ kind: 'close', name: localName(qualified), qualified });
      i = end + 1;
      continue;
    }

    // Open tag: find the closing '>' while respecting quotes.
    const tagEnd = findTagEnd(input, lt);
    if (tagEnd === -1) {
      return { ok: false, error: { reason: 'truncated_input' } };
    }
    const tagBody = input.slice(lt + 1, tagEnd);
    const selfClosing = tagBody.endsWith('/');
    const inner = selfClosing ? tagBody.slice(0, -1) : tagBody;
    const nameMatch = /^([^\s/>]+)/.exec(inner);
    if (nameMatch === null || !isValidTagName(nameMatch[1]!)) {
      return { ok: false, error: { reason: 'malformed_markup' } };
    }
    const qualified = nameMatch[1]!;
    const attributes = parseAttributes(inner.slice(qualified.length));
    if (!attributes.ok) {
      return { ok: false, error: { reason: attributes.reason } };
    }
    elementCount += 1;
    if (elementCount > XML_BOUNDS.maxElements) {
      return { ok: false, error: { reason: 'element_count_exceeded' } };
    }
    if (!selfClosing) {
      openStack.push(qualified);
      if (openStack.length > XML_BOUNDS.maxDepth) {
        return { ok: false, error: { reason: 'depth_exceeded' } };
      }
    }
    events.push({
      kind: 'open',
      name: localName(qualified),
      qualified,
      attributes: attributes.attrs,
      selfClosing,
    });
    i = tagEnd + 1;
  }

  if (openStack.length > 0) {
    return { ok: false, error: { reason: 'tag_mismatch' } };
  }
  return { ok: true, events };
}

/** Find the `>` closing an open tag, honoring quoted attribute values. */
function findTagEnd(input: string, start: number): number {
  let inQuote: string | null = null;
  for (let i = start + 1; i < input.length; i++) {
    const ch = input[i];
    if (inQuote !== null) {
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function isValidTagName(name: string): boolean {
  if (name.length === 0 || name.length > 128) {
    return false;
  }
  return /^[\w.:-]+$/.test(name);
}

interface AttrParseOk {
  readonly ok: true;
  readonly attrs: Record<string, string>;
}
interface AttrParseFail {
  readonly ok: false;
  readonly reason: XmlParseFailureReason;
}

function parseAttributes(body: string): AttrParseOk | AttrParseFail {
  const attrs: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = pattern.exec(body)) !== null) {
    // Only whitespace may separate attributes; anything else is malformed.
    if (body.slice(lastEnd, match.index).trim() !== '') {
      return { ok: false, reason: 'malformed_markup' };
    }
    lastEnd = match.index + match[0].length;
    if (Object.keys(attrs).length >= XML_BOUNDS.maxAttributes) {
      return { ok: false, reason: 'malformed_markup' };
    }
    const name = match[1]!;
    const value = match[2] ?? match[3] ?? '';
    if (value.length > XML_BOUNDS.maxAttrValueChars) {
      return { ok: false, reason: 'attr_too_long' };
    }
    const decoded = decodeXmlEntities(value);
    if (!decoded.ok) {
      return { ok: false, reason: decoded.reason };
    }
    attrs[name] = decoded.text;
  }
  // Trailing garbage after the last attribute is malformed.
  if (body.slice(lastEnd).trim() !== '') {
    return { ok: false, reason: 'malformed_markup' };
  }
  return { ok: true, attrs };
}
