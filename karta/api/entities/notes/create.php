<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/NoteRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
try {
    $repo = new NoteRepository(getDB());
    $record = $repo->create(['uuid' => $body['uuid'] ?? null, 'username' => $authUser['username'], 'related_store' => sanitizeString($body['related_store'] ?? null) ?: null, 'related_id' => sanitizeString($body['related_id'] ?? null) ?: null, 'title' => sanitizeString($body['title'] ?? null) ?: null, 'content' => sanitizeString($body['content'] ?? null) ?: null]);
    bumpVersion(getDB(), 'notes');
    jsonSuccess($record, 'تم الإنشاء بنجاح', 201);
} catch (PDOException $e) { error_log('[NOTE CREATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
