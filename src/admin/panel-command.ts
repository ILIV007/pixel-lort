/**
 * Slice 3 — the `/menu` argument parser (the R1.18.1 grammar discipline).
 *
 * Grammar (exactly one of):
 *   `/menu`         main panel
 *   `/menu mode`    mode screen
 *   `/menu cap`     cap screen
 *   `/menu event`   event screen
 *
 * Validation happens BEFORE any store access:
 * - The remainder must be a single token — newlines, control characters
 *   and extra tokens are `invalid`.
 *
 * The parser is pure: it never touches D1, never logs, and never echoes
 * the rejected input (the caller renders the static invalid-usage text).
 */
import type { PanelScreen } from './panel-strings';

export type MenuArgumentParse =
  | { readonly kind: 'main' }
  | { readonly kind: 'screen'; readonly screen: Exclude<PanelScreen, 'main'> }
  | { readonly kind: 'invalid' };

const MENU_SCREENS: readonly string[] = ['mode', 'cap', 'event'];

function isMenuScreen(value: string): value is Exclude<PanelScreen, 'main'> {
  return (MENU_SCREENS as readonly string[]).includes(value);
}

/**
 * Parse the WHOLE remainder of `/menu` (the router already stripped the
 * command token and its separator). `undefined` is the documented
 * no-argument main-panel form.
 */
export function parseMenuArgument(remainder: string | undefined): MenuArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'main' };
  }
  // Newlines / control characters can never be part of a valid argument —
  // they are a grammar failure, never a separator. (Checked by code point,
  // not by a control-character regex — the lint rule forbids the latter.)
  if (
    [...remainder].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return { kind: 'invalid' };
  }
  const tokens = remainder.split(/[ \t]+/u);
  if (tokens.length !== 1) {
    return { kind: 'invalid' };
  }
  const [screen] = tokens as [string | undefined];
  if (screen === undefined || !isMenuScreen(screen)) {
    return { kind: 'invalid' };
  }
  return { kind: 'screen', screen };
}
