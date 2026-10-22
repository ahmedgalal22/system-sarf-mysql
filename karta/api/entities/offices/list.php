<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../../repositories/HamolaRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
try {
    $db = getDB();
    $repo = new OfficeRepository($db);
    $filters = [];
    $name = sanitizeString($_GET['name'] ?? null); if ($name !== '') $filters['name'] = $name;
    $data = empty($filters) ? $repo->getAllByUsername($authUser['username']) : $repo->findByFields($authUser['username'], $filters);
    // Attach hamolaRows from hamola_details table (grouped by office_id)
    $hamolaRepo = new HamolaRepository($db);
    $allHamola = $hamolaRepo->getAllByUsername($authUser['username']);
    $hamolaByOffice = [];
    foreach ($allHamola as $h) {
        $oid = $h['office_id'];
        if (!isset($hamolaByOffice[$oid])) $hamolaByOffice[$oid] = [];
        $hamolaByOffice[$oid][] = $h;
    }
    foreach ($data as &$r) {
        $r['hamolaRows'] = $hamolaByOffice[$r['id']] ?? [];
    }
    unset($r);
    jsonSuccess($data);
} catch (PDOException $e) { error_log('[OFFICES LIST] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
