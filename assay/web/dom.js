/* DOM builders shared by every view.
   Everything shown that came from a gateway or a report is set through text nodes, never
   innerHTML: model names and error strings are untrusted input. */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Element builder. `on*` props are listeners, `class` maps to className, false/null are skipped.
 * @param {string} tag @param {Record<string, any>} [props] @param {...any} kids
 */
export function h(tag, props = {}, ...kids) {
  return build(document.createElementNS(HTML_NS, tag), props, kids);
}
/** SVG variant of {@link h}. */
export function s(tag, props = {}, ...kids) {
  return build(document.createElementNS(SVG_NS, tag), props, kids);
}
function build(el, props, kids) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
export const $ = (sel) => document.querySelector(sel);
export const clear = (el) => el.replaceChildren();
