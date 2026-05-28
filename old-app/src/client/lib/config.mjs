'use strict';

// Runtime base path detection for multi-prefix deployment.
// Detects /kikx/ vs /kikx2/ (or any prefix) from the current URL.

let match = window.location.pathname.match(/^(\/[^/]+)\//);

export const BASE_PATH    = match ? match[1] : '/kikx';
export const API_BASE_URL = `${BASE_PATH}/api/v2`;
