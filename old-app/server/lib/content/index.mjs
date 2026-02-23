'use strict';

// ============================================================================
// Rich Content Type Registry
// ============================================================================
// Extension point for custom content renderers.
// Plugins can register renderers for custom content types in frame payloads.
// The client-side renderer dispatches based on contentType field.

/**
 * Registry of content type renderers.
 * Map<contentType, { render, description, source }>
 */
const renderers = new Map();

/**
 * Built-in content types (always available).
 */
const BUILTIN_TYPES = new Set([
  'text',       // Plain text / HTML (default)
  'markdown',   // Markdown content
  'code',       // Code block with syntax highlighting
  'image',      // Image (url or base64)
  'file',       // File attachment reference
]);

/**
 * Register a custom content type renderer.
 *
 * @param {string} contentType - Unique content type identifier
 * @param {Object} renderer - Renderer definition
 * @param {string} renderer.description - Human-readable description
 * @param {string} [renderer.source] - Source identifier (e.g., plugin name)
 * @param {Function} [renderer.serverTransform] - Server-side transform: (payload) => transformedPayload
 * @param {string} [renderer.clientComponent] - Custom element tag name for client rendering
 * @param {string} [renderer.clientScript] - URL to client-side script that registers the component
 * @returns {boolean} True if registered, false if already exists
 */
export function registerContentType(contentType, renderer) {
  if (!contentType || typeof contentType !== 'string')
    throw new Error('contentType must be a non-empty string');

  if (BUILTIN_TYPES.has(contentType))
    throw new Error(`Cannot override built-in content type: ${contentType}`);

  if (renderers.has(contentType))
    return false;

  renderers.set(contentType, {
    description:     renderer.description || contentType,
    source:          renderer.source || 'unknown',
    serverTransform: renderer.serverTransform || null,
    clientComponent: renderer.clientComponent || null,
    clientScript:    renderer.clientScript || null,
  });

  return true;
}

/**
 * Unregister a custom content type renderer.
 *
 * @param {string} contentType - Content type to unregister
 * @returns {boolean} True if was registered and removed
 */
export function unregisterContentType(contentType) {
  if (BUILTIN_TYPES.has(contentType))
    return false;

  return renderers.delete(contentType);
}

/**
 * Get renderer for a content type.
 *
 * @param {string} contentType - Content type
 * @returns {Object|null} Renderer definition or null
 */
export function getContentRenderer(contentType) {
  return renderers.get(contentType) || null;
}

/**
 * List all registered content types.
 *
 * @returns {Array<Object>} Array of { contentType, description, source, isBuiltin }
 */
export function listContentTypes() {
  let types = [];

  // Built-in types
  for (let type of BUILTIN_TYPES) {
    types.push({
      contentType: type,
      description: `Built-in ${type} renderer`,
      source:      'core',
      isBuiltin:   true,
    });
  }

  // Custom types
  for (let [contentType, renderer] of renderers) {
    types.push({
      contentType: contentType,
      description: renderer.description,
      source:      renderer.source,
      isBuiltin:   false,
    });
  }

  return types;
}

/**
 * Apply server-side transform if registered for a content type.
 *
 * @param {string} contentType - Content type
 * @param {Object} payload - Frame payload
 * @returns {Object} Transformed payload (or original if no transform)
 */
export function transformContent(contentType, payload) {
  let renderer = renderers.get(contentType);

  if (renderer && renderer.serverTransform) {
    try {
      return renderer.serverTransform(payload);
    } catch (e) {
      console.error(`[ContentRegistry] Transform error for ${contentType}:`, e.message);
      return payload;
    }
  }

  return payload;
}

/**
 * Check if a content type is known (built-in or registered).
 *
 * @param {string} contentType - Content type to check
 * @returns {boolean} True if known
 */
export function isKnownContentType(contentType) {
  return BUILTIN_TYPES.has(contentType) || renderers.has(contentType);
}

export default {
  registerContentType,
  unregisterContentType,
  getContentRenderer,
  listContentTypes,
  transformContent,
  isKnownContentType,
  BUILTIN_TYPES,
};
