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

