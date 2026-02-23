'use strict';

// ============================================================================
// Avatar Generation
// ============================================================================
// Generates deterministic SVG avatars based on name hashing.
// Each agent/user gets a unique color derived from their name.

import { createHash } from 'crypto';

// Palette of visually distinct, accessible colors
const COLORS = [
  '#4F46E5', // indigo
  '#7C3AED', // violet
  '#DB2777', // pink
  '#DC2626', // red
  '#EA580C', // orange
  '#D97706', // amber
  '#65A30D', // lime
  '#059669', // emerald
  '#0891B2', // cyan
  '#2563EB', // blue
  '#7C3AED', // purple
  '#9333EA', // fuchsia
  '#0D9488', // teal
  '#4338CA', // indigo-dark
  '#B91C1C', // red-dark
  '#047857', // green-dark
];

/**
 * Generate a deterministic hash index from a string.
 *
 * @param {string} input - Input string
 * @returns {number} Hash as integer
 */
function hashString(input) {
  let hash = createHash('md5').update(input).digest();
  return hash.readUInt32BE(0);
}

/**
 * Get initials from a name (up to 2 characters).
 *
 * @param {string} name - Display name
 * @returns {string} 1-2 character initials
 */
export function getInitials(name) {
  if (!name || typeof name !== 'string')
    return '?';

  let parts = name.trim().split(/[\s\-_]+/).filter(Boolean);

  if (parts.length === 0)
    return '?';

  if (parts.length === 1)
    return parts[0].charAt(0).toUpperCase();

  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * Get a deterministic color for a name.
 *
 * @param {string} name - Name to hash
 * @returns {string} Hex color string
 */
export function getColor(name) {
  let index = hashString(name || '') % COLORS.length;
  return COLORS[index];
}

/**
 * Generate an SVG avatar as a data URI.
 *
 * @param {string} name - Name to generate avatar for
 * @param {number} [size=40] - Width/height in pixels
 * @returns {string} SVG data URI
 */
export function generateAvatar(name, size = 40) {
  let initials = getInitials(name);
  let color    = getColor(name);
  let fontSize = (initials.length === 1) ? size * 0.5 : size * 0.4;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="${color}"/>
  <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
        font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"
        font-weight="600" font-size="${fontSize}" fill="white">${initials}</text>
</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Get avatar URL for an agent.
 * Returns custom avatar_url if set, otherwise generates a deterministic one.
 *
 * @param {Object} agent - Agent object with name and optional avatar_url
 * @returns {string} Avatar URL (custom or generated data URI)
 */
export function getAgentAvatar(agent) {
  if (agent.avatar_url)
    return agent.avatar_url;

  return generateAvatar(agent.name || 'Agent');
}

/**
 * Get avatar URL for a user.
 *
 * @param {Object} user - User object with username/display_name
 * @returns {string} Avatar data URI
 */
export function getUserAvatar(user) {
  let displayName = user.display_name || user.username || 'User';
  return generateAvatar(displayName);
}

export default {
  getInitials,
  getColor,
  generateAvatar,
  getAgentAvatar,
  getUserAvatar,
};
