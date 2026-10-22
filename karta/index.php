<?php
/**
 * index.php — API root
 *
 * Accessing /karta/ directly returns system info.
 */

require_once __DIR__ . '/core/bootstrap.php';

jsonSuccess([
    'name'      => 'Karta ERP API',
    'version'   => '1.0.0',
    'status'    => 'running',
    'endpoints' => [
        'POST /api/auth/login.php'    => 'تسجيل الدخول',
        'POST /api/auth/logout.php'   => 'تسجيل الخروج',
        'GET  /api/auth/me.php'       => 'بيانات المستخدم',
        'GET  /api/auth/session.php'  => 'فحص الجلسة',
        'GET  /api/health/ping.php'   => 'فحص النظام',
    ],
], 'Karta ERP API is running');
