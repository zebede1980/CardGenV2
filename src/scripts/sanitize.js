// Shared sanitization utilities — loaded before all other app scripts.
// Prevents XSS when injecting user/AI-generated content into innerHTML.

/**
 * Escape a string for safe insertion into HTML via innerHTML.
 * Handles &, <, >, ", and ' characters.
 * @param {*} raw — any value (toString'd)
 * @returns {string}
 */
function escapeHtml(raw) {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape for safe use inside a `style` attribute value.
 * Blocks `expression()`, `url()`, `javascript:`, and closes parens.
 */
function escapeStyleValue(raw) {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/expression\s*\(/gi, "")
    .replace(/url\s*\(/gi, "")
    .replace(/javascript\s*:/gi, "");
}
