<?php
/**
 * repositories/OfficeRepository.php — Office data access
 * hamola_rows removed — hamola details now in hamola_details table
 */

class OfficeRepository {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM offices WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare('SELECT * FROM offices WHERE username = :u AND deleted_at IS NULL ORDER BY created_at DESC');
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function findByFields(string $username, array $filters = []): array {
        $sql = 'SELECT * FROM offices WHERE username = :u AND deleted_at IS NULL';
        $params = [':u' => $username];
        if (!empty($filters['name'])) { $sql .= ' AND name = :name'; $params[':name'] = $filters['name']; }
        $sql .= ' ORDER BY created_at DESC';
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $stmt = $this->db->prepare(
            'INSERT INTO offices (uuid, username, name, phone, notes, created_by, created_at, updated_at)
             VALUES (:uuid, :username, :name, :phone, :notes, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'       => $data['uuid'] ?? $this->generateUUID(),
            ':username'   => $data['username'],
            ':name'       => $data['name'],
            ':phone'      => $data['phone'] ?? null,
            ':notes'      => $data['notes'] ?? null,
            ':created_by' => $data['username'],
        ]);
        return $this->getById((int) $this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): ?array {
        if ($expectedUpdatedAt !== null) {
            $cur = $this->getById($id);
            if ($cur && $cur['updated_at'] !== $expectedUpdatedAt) return null;
        }
        $allowed = ['name','phone','notes'];
        $fields = []; $params = [':id' => $id, ':updated_by' => $username];
        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) {
                $fields[] = "`{$f}` = :{$f}";
                $params[":{$f}"] = $patch[$f];
            }
        }
        if (empty($fields)) return $this->getById($id);
        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $this->db->prepare('UPDATE offices SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL')->execute($params);
        return $this->getById($id);
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare('UPDATE offices SET deleted_at = NOW(3), deleted_by = :u WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function generateUUID(): string {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
