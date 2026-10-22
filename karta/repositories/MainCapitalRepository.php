<?php
/**
 * repositories/MainCapitalRepository.php — Main Capital Treasury data access (Phase 6)
 *
 * Independent capital tracking for dashboard.
 * Simple CRUD — no reversal logic, no reference linking.
 */

class MainCapitalRepository {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT *, description AS note FROM main_capital_treasury WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT *, description AS note FROM main_capital_treasury WHERE username = :u AND deleted_at IS NULL AND is_archived = 0 ORDER BY created_at DESC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $uuid = $data['uuid'] ?? $data['id'] ?? $this->uuid();
        $stmt = $this->db->prepare(
            'INSERT INTO main_capital_treasury (uuid, username, type, amount, description, date,
                is_archived, archive_batch_id, created_by, created_at, updated_at)
             VALUES (:uuid, :username, :type, :amount, :description, :date,
                :is_archived, :archive_batch_id, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'            => $uuid,
            ':username'        => $data['username'],
            ':type'            => $data['type'] ?? 'deposit',
            ':amount'          => intval($data['amount'] ?? 0),
            ':description'     => $data['description'] ?? $data['note'] ?? null,
            ':date'            => $data['date'] ?? null,
            ':is_archived'     => intval($data['is_archived'] ?? 0),
            ':archive_batch_id'=> $data['archive_batch_id'] ?? null,
            ':created_by'      => $data['username'],
        ]);
        return $this->getById((int)$this->db->lastInsertId());
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare('UPDATE main_capital_treasury SET deleted_at = NOW(3), deleted_by = :u WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function uuid(): string {
        $d = random_bytes(16); $d[6] = chr(ord($d[6]) & 0x0f | 0x40); $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
