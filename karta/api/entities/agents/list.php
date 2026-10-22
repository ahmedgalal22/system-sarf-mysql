<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/AgentRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
try {
    $repo = new AgentRepository(getDB());
    $filters = [];
    foreach (['name'] as $k) {
        $v = sanitizeString($_GET[$k] ?? null); if ($v !== '') $filters[$k] = $v;
    }
    $data = empty($filters) ? $repo->getAllByUsername($authUser['username']) : $repo->findByFields($authUser['username'], $filters);
    jsonSuccess($data);
} catch (PDOException $e) { error_log('[AGENTS LIST] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
