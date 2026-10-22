<?php
/**
 * config/session.php — Session settings
 *
 * Secure defaults for LAN deployment.
 * httponly prevents JavaScript access to session cookie.
 * samesite=Lax prevents CSRF from external sites.
 */

return [
    'name'            => 'KARTA_SESSION',
    'lifetime'        => 28800,      // 8 hours
    'path'            => '/',
    'domain'          => '',         // Empty = auto-detect (works on LAN IPs)
    'secure'          => false,      // LAN uses HTTP, not HTTPS
    'httponly'         => true,
    'samesite'        => 'Lax',
    'gc_maxlifetime'  => 28800,
    'save_path'       => '',         // Empty = PHP default (XAMPP temp)
];
