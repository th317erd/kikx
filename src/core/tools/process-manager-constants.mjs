'use strict';

import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TEMP_ROOT = path.join(os.tmpdir(), 'kikx-processes');
export const PROCESS_AUTHOR_ID = 'internal:process-manager';
export const DEFAULT_PROCESS_READ_BYTES = 128 * 1024;
export const DEFAULT_GREP_MATCH_LIMIT = 50;
export const DEFAULT_EXEC_GRACE_MS = 2500;
export const DEFAULT_EXIT_STDIO_GRACE_MS = 250;
