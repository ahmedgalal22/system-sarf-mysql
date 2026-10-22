<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/HamolaRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
try {
    $repo = new HamolaRepository(getDB());
    $officeId = intval($_GET['office_id'] ?? 0);
    if ($officeId > 0) {
        $data = $repo->getByOfficeId($officeId);
    } else {
        $data = $repo->getAllByUsername($authUser['username']);
    }
    jsonSuccess($data);
} catch (PDOException $e) {
    error_log('[HAMOLA LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
