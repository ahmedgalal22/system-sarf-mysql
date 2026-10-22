<?php
/**
 * config/app.php — Application configuration
 */

return [
    'name'        => 'Karta ERP',
    'version'     => '1.0.0',
    'timezone'    => 'Africa/Cairo',
    'charset'     => 'UTF-8',
    'debug'       => false,       // Production: disabled — errors logged to logs/app.log only
    'log_errors'  => true,
    'log_file'    => __DIR__ . '/../logs/app.log',
];
