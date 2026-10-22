<?php
/**
 * config/database.php — MySQL connection settings
 *
 * For XAMPP default installation:
 *   host = 127.0.0.1, user = root, password = '' (empty)
 *
 * IMPORTANT: Change password in production!
 */

return [
    'host'     => '127.0.0.1',
    'port'     => 3306,
    'dbname'   => 'karta_erp_v2',
    'username' => 'root',
    'password' => '',
    'charset'  => 'utf8mb4',
    'options'  => [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
    ],
];
