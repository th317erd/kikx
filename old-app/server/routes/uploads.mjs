'use strict';

// ============================================================================
// File Upload Routes
// ============================================================================

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, extname } from 'path';
import multer from 'multer';
import { getDatabase } from '../database.mjs';
import { requireAuth } from '../middleware/auth.mjs';
import { ensureUploadsDir, getUploadsDir } from '../lib/config-path.mjs';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// File size limit: 10 MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Allowed MIME types
const ALLOWED_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Archives
  'application/zip',
]);

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let uploadsDir = ensureUploadsDir();

    // Organize by user ID
    let userDir = join(uploadsDir, String(req.user.id));
    if (!existsSync(userDir))
      mkdirSync(userDir, { recursive: true });

    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    let ext      = extname(file.originalname) || '';
    let uniqueId = randomUUID();
    cb(null, `${uniqueId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files:    5, // Max 5 files per request
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

/**
 * POST /api/sessions/:sessionId/uploads
 * Upload file(s) to a session.
 */
router.post('/:sessionId/uploads', (req, res) => {
  let db        = getDatabase();
  let sessionId = parseInt(req.params.sessionId, 10);

  // Verify session exists and belongs to user
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  upload.array('files', 5)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024} MB` });

      if (err.code === 'LIMIT_FILE_COUNT')
        return res.status(400).json({ error: 'Too many files. Maximum: 5 per upload' });

      return res.status(400).json({ error: err.message });
    }

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: 'No files provided' });

    let uploads = [];
    let insertStmt = db.prepare(`
      INSERT INTO uploads (user_id, session_id, filename, original_name, mime_type, size_bytes, storage_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (let file of req.files) {
      let result = insertStmt.run(
        req.user.id,
        sessionId,
        file.filename,
        file.originalname,
        file.mimetype,
        file.size,
        file.path,
      );

      uploads.push({
        id:           Number(result.lastInsertRowid),
        filename:     file.filename,
        originalName: file.originalname,
        mimeType:     file.mimetype,
        sizeBytes:    file.size,
        url:          `/api/uploads/${result.lastInsertRowid}`,
      });
    }

    return res.status(201).json({ uploads });
  });
});

/**
 * GET /api/uploads/:id
 * Serve an uploaded file.
 */
router.get('/:id', (req, res) => {
  let db     = getDatabase();
  let upload = db.prepare(`
    SELECT u.*, s.user_id as session_user_id
    FROM uploads u
    LEFT JOIN sessions s ON u.session_id = s.id
    WHERE u.id = ?
  `).get(req.params.id);

  if (!upload)
    return res.status(404).json({ error: 'File not found' });

  // Verify user owns the file or is in the session
  if (upload.user_id !== req.user.id && upload.session_user_id !== req.user.id)
    return res.status(403).json({ error: 'Access denied' });

  if (!existsSync(upload.storage_path))
    return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('Content-Type', upload.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${upload.original_name}"`);
  res.sendFile(upload.storage_path);
});

/**
 * GET /api/sessions/:sessionId/uploads
 * List uploads for a session.
 */
router.get('/:sessionId/uploads', (req, res) => {
  let db        = getDatabase();
  let sessionId = parseInt(req.params.sessionId, 10);

  // Verify session belongs to user
  let session = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').get(sessionId, req.user.id);

  if (!session)
    return res.status(404).json({ error: 'Session not found' });

  let uploads = db.prepare(`
    SELECT id, filename, original_name, mime_type, size_bytes, created_at
    FROM uploads
    WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(sessionId);

  return res.json({
    uploads: uploads.map((u) => ({
      id:           u.id,
      filename:     u.filename,
      originalName: u.original_name,
      mimeType:     u.mime_type,
      sizeBytes:    u.size_bytes,
      url:          `/api/uploads/${u.id}`,
      createdAt:    u.created_at,
    })),
  });
});

/**
 * DELETE /api/uploads/:id
 * Delete an uploaded file.
 */
router.delete('/:id', (req, res) => {
  let db     = getDatabase();
  let upload = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);

  if (!upload)
    return res.status(404).json({ error: 'File not found' });

  // Remove from disk
  if (existsSync(upload.storage_path)) {
    try {
      unlinkSync(upload.storage_path);
    } catch (e) {
      console.error('Failed to delete file from disk:', e.message);
    }
  }

  // Remove from database
  db.prepare('DELETE FROM uploads WHERE id = ?').run(upload.id);

  return res.json({ success: true });
});

export default router;
