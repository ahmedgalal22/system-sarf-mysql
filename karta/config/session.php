<?php
/**
 * config/session.php — Session settings
 *
 * 30-day rolling inactivity expiration policy for LAN/desktop deployment.
 * - lifetime / gc_maxlifetime: 2592000 seconds (30 days)
 * - renewal_interval: 60 seconds (throttles Set-Cookie header renewal)
 * - save_path: dedicated storage/sessions directory isolated from shared XAMPP temp GC
 * - httponly prevents JavaScript access to session cookie
 * - samesite=Lax prevents CSRF from external sites
 */

return [
    'name'             => 'KARTA_V2_SESSION',
    'lifetime'         => 2592000,    // 30 days (30 * 24 * 60 * 60)
    'path'             => '/',
    'domain'           => '',         // Empty = auto-detect (works on LAN IPs)
    'secure'           => false,      // LAN uses HTTP, not HTTPS
    'httponly'         => true,
    'samesite'         => 'Lax',
    'gc_maxlifetime'   => 2592000,    // 30 days (matches cookie lifetime)
    'renewal_interval' => 60,         // Minimum seconds between Set-Cookie header renewals
    'save_path'        => __DIR__ . '/../storage/sessions',
];

