'use strict';

import fs from 'node:fs/promises';
import path from 'node:path';
import { computeDiff } from './diff.mjs';
import { FilesPermissions } from './files-permissions.mjs';

// =============================================================================
// Files Plugin
// =============================================================================
// Provides file read, write, and edit tools with structured output and
// render hints for client-side visualization.
//
// Tools registered:
//   files:read   — Read file contents with line numbers
//   files:write  — Write/overwrite a file (with diff against previous)
//   files:edit   — Find-and-replace within a file (with diff)
// =============================================================================

const MAX_LINES      = 2000;
const BINARY_CHECK   = 8192;

function isBinary(buffer) {
  let check = buffer.subarray(0, BINARY_CHECK);

  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0)
      return true;
  }

  return false;
}

function guessLanguage(filePath) {
  let ext = path.extname(filePath).toLowerCase();
  let map = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript',
    '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.go': 'go',
    '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.css': 'css', '.scss': 'scss', '.html': 'html', '.xml': 'xml',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.md': 'markdown', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.sql': 'sql', '.graphql': 'graphql', '.proto': 'protobuf',
    '.dockerfile': 'dockerfile', '.tf': 'terraform',
  };

  return map[ext] || 'text';
}

export function setup({ registerTool, PluginInterface }) {

  // ---------------------------------------------------------------------------
  // files:read
  // ---------------------------------------------------------------------------

  class FileReadTool extends PluginInterface {
    static pluginID    = 'files';
    static featureName = 'read';
    static displayName = 'Read File';
    static description = 'Read the contents of a file';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['filePath'],
      properties: {
        filePath: { type: 'string', description: 'Absolute or relative path to the file' },
        offset:   { type: 'integer', description: 'Line offset to start reading from (0-based, default 0)' },
        limit:    { type: 'integer', description: `Maximum number of lines to read (default ${MAX_LINES})` },
      },
    };

    getPermissionsClass() { return FilesPermissions; }

    async _execute({ filePath, offset, limit }) {
      if (!filePath || typeof filePath !== 'string')
        throw new Error('filePath is required');

      let resolvedPath = path.resolve(filePath);

      let buffer;
      try {
        buffer = await fs.readFile(resolvedPath);
      } catch (error) {
        if (error.code === 'ENOENT')
          throw new Error(`File not found: ${resolvedPath}`);

        if (error.code === 'EISDIR')
          throw new Error(`Path is a directory: ${resolvedPath}`);

        throw error;
      }

      if (isBinary(buffer))
        throw new Error(`File appears to be binary: ${resolvedPath}`);

      let content     = buffer.toString('utf8');
      let allLines    = content.split('\n');
      let totalLines  = allLines.length;

      // Trim trailing empty line from final newline
      if (totalLines > 0 && allLines[totalLines - 1] === '') {
        allLines.pop();
        totalLines = allLines.length;
      }

      let lineOffset = Math.max(0, offset || 0);
      let lineLimit  = Math.min(limit || MAX_LINES, MAX_LINES);
      let endLine    = Math.min(lineOffset + lineLimit, totalLines);
      let truncated  = endLine < totalLines;
      let sliced     = allLines.slice(lineOffset, endLine);

      // Build numbered content for the agent
      let numberedLines = sliced.map((line, i) => {
        let lineNum = lineOffset + i + 1;
        return `${String(lineNum).padStart(6, ' ')}\t${line}`;
      });

      let numberedContent = numberedLines.join('\n');
      let language        = guessLanguage(resolvedPath);

      let agentOutput = {
        content:   numberedContent,
        filePath:  resolvedPath,
        lineCount: sliced.length,
        totalLines,
        truncated,
      };

      if (truncated)
        agentOutput.message = `Showing lines ${lineOffset + 1}-${endLine} of ${totalLines}. Use offset/limit to read more.`;

      // Render hint for client visualization
      agentOutput._renderHint = {
        renderType: 'file-read',
        renderData: {
          filePath:  resolvedPath,
          content:   sliced.join('\n'),
          lineCount: sliced.length,
          totalLines,
          offset:    lineOffset,
          truncated,
          language,
        },
      };

      return agentOutput;
    }
  }

  // ---------------------------------------------------------------------------
  // files:write
  // ---------------------------------------------------------------------------

  class FileWriteTool extends PluginInterface {
    static pluginID    = 'files';
    static featureName = 'write';
    static displayName = 'Write File';
    static description = 'Write content to a file (creates or overwrites)';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['filePath', 'content'],
      properties: {
        filePath:          { type: 'string', description: 'Absolute or relative path to the file' },
        content:           { type: 'string', description: 'Content to write to the file' },
        createDirectories: { type: 'boolean', description: 'Create parent directories if they don\'t exist (default false)' },
      },
    };

    getPermissionsClass() { return FilesPermissions; }

    async _execute({ filePath, content, createDirectories }) {
      if (!filePath || typeof filePath !== 'string')
        throw new Error('filePath is required');

      if (content == null)
        throw new Error('content is required');

      let resolvedPath = path.resolve(filePath);
      let oldContent   = null;
      let created      = false;

      // Read existing content for diff (if file exists)
      try {
        let buffer = await fs.readFile(resolvedPath);
        oldContent = buffer.toString('utf8');
      } catch (error) {
        if (error.code === 'ENOENT')
          created = true;
        else if (error.code !== 'EISDIR')
          oldContent = null;
        else
          throw new Error(`Path is a directory: ${resolvedPath}`);
      }

      // Create parent directories if requested
      if (createDirectories) {
        let dir = path.dirname(resolvedPath);
        await fs.mkdir(dir, { recursive: true });
      }

      await fs.writeFile(resolvedPath, content, 'utf8');

      // Compute diff for render hint
      let diff = computeDiff(oldContent || '', content);

      let agentOutput = {
        message:  (created) ? `Created: ${resolvedPath}` : `Updated: ${resolvedPath}`,
        filePath: resolvedPath,
        created,
      };

      agentOutput._renderHint = {
        renderType: 'file-write',
        renderData: {
          filePath: resolvedPath,
          created,
          diff,
          language: guessLanguage(resolvedPath),
        },
      };

      return agentOutput;
    }
  }

  // ---------------------------------------------------------------------------
  // files:edit
  // ---------------------------------------------------------------------------

  class FileEditTool extends PluginInterface {
    static pluginID    = 'files';
    static featureName = 'edit';
    static displayName = 'Edit File';
    static description = 'Find and replace a string in a file. The oldString must be unique within the file.';
    static riskLevel   = 'high';
    static inputSchema = {
      type:       'object',
      required:   ['filePath', 'oldString', 'newString'],
      properties: {
        filePath:  { type: 'string', description: 'Absolute or relative path to the file' },
        oldString: { type: 'string', description: 'The exact string to find and replace (must be unique in the file)' },
        newString: { type: 'string', description: 'The replacement string' },
      },
    };

    getPermissionsClass() { return FilesPermissions; }

    async _execute({ filePath, oldString, newString }) {
      if (!filePath || typeof filePath !== 'string')
        throw new Error('filePath is required');

      if (oldString == null || typeof oldString !== 'string')
        throw new Error('oldString is required');

      if (newString == null || typeof newString !== 'string')
        throw new Error('newString is required');

      if (oldString === newString)
        throw new Error('oldString and newString are identical — no change needed');

      let resolvedPath = path.resolve(filePath);

      let buffer;
      try {
        buffer = await fs.readFile(resolvedPath);
      } catch (error) {
        if (error.code === 'ENOENT')
          throw new Error(`File not found: ${resolvedPath}`);

        throw error;
      }

      let oldContent = buffer.toString('utf8');

      // Validate uniqueness
      let firstIndex = oldContent.indexOf(oldString);
      if (firstIndex === -1)
        throw new Error(`oldString not found in ${resolvedPath}`);

      let secondIndex = oldContent.indexOf(oldString, firstIndex + 1);
      if (secondIndex !== -1)
        throw new Error(`oldString is not unique in ${resolvedPath} — found at multiple positions. Provide more surrounding context to make the match unique.`);

      // Apply replacement
      let newContent = oldContent.slice(0, firstIndex) + newString + oldContent.slice(firstIndex + oldString.length);

      await fs.writeFile(resolvedPath, newContent, 'utf8');

      // Compute diff
      let diff = computeDiff(oldContent, newContent);

      let agentOutput = {
        message:  `Edited: ${resolvedPath}`,
        filePath: resolvedPath,
      };

      agentOutput._renderHint = {
        renderType: 'file-write',
        renderData: {
          filePath: resolvedPath,
          created:  false,
          diff,
          language: guessLanguage(resolvedPath),
        },
      };

      return agentOutput;
    }
  }

  // ---------------------------------------------------------------------------
  // Register tools
  // ---------------------------------------------------------------------------

  registerTool('files:read',  FileReadTool);
  registerTool('files:write', FileWriteTool);
  registerTool('files:edit',  FileEditTool);

  return () => {};
}
