export const formatWithOptions = (_o, ...a) => a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
export const types = { isNativeError: (e) => e instanceof Error };
export default { formatWithOptions, types };
