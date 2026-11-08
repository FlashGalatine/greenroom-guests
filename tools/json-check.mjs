// The reference for the strict JSON check the push actions run (GRN-07), written the simple way so
// the C# validator can be compared against it: the mock Streamer.bot uses it to reject a payload, and
// tools/cs-harness/fuzz.mjs uses it as the oracle the compiled action must agree with.
//
// A text passes when it is ONE JSON object (RFC 8259, nothing after it), no object repeats a key
// (compared after decoding escapes, so "a" and "a" collide), and containers are nested at most
// MAX_DEPTH deep, the top-level object counting as 1.

export const MAX_DEPTH = 32;

// null when the text is acceptable, else a short reason.
export function objectError(text) {
  if (typeof text !== 'string') return 'empty';
  let v;
  try { v = JSON.parse(text); } catch { return 'not valid JSON'; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  // JSON.parse has vouched for the syntax, so this pass only counts nesting and looks for repeated keys.
  const stack = []; // one entry per open container: a Set of its decoded keys, or null for an array
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      let k = j + 1;
      while (' \t\n\r'.includes(text[k] ?? 'x')) k++;
      const top = stack[stack.length - 1];
      if (top && text[k] === ':') {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.has(key)) return 'duplicate key';
        top.add(key);
      }
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[') {
      if (stack.length >= MAX_DEPTH) return 'nested too deep';
      stack.push(c === '{' ? new Set() : null);
    } else if (c === '}' || c === ']') stack.pop();
    i++;
  }
  return null;
}
