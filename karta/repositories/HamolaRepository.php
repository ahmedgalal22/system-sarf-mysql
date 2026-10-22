<?php
/**
 * repositories/HamolaRepository.php — Hamola Details data access
 */

class HamolaRepository {
    private PDO $db;

    public function __construct(PDO $db) {
        $this->db = $db;
    }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM hamola_details WHERE id = :id AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch();
        return $r ?: null;
    }

    public function getByOfficeId(int $officeId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM hamola_details WHERE office_id = :oid AND deleted_at IS NULL ORDER BY created_at ASC'
        );
        $stmt->execute([':oid' => $officeId]);
        return $stmt->fetchAll();
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM hamola_details WHERE username = :u AND deleted_at IS NULL ORDER BY office_id, created_at ASC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $stmt = $this->db->prepare(
            'INSERT INTO hamola_details (uuid, office_id, username, loading_place, destination_place, nolon, office_amount, item_type, price, created_by, created_at, updated_at)
             VALUES (:uuid, :office_id, :username, :loading_place, :destination_place, :nolon, :office_amount, :item_type, :price, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'              => $data['uuid'] ?? $this->generateUUID(),
            ':office_id'         => $data['office_id'],
            ':username'          => $data['username'],
            ':loading_place'     => $data['loading_place'],
            ':destination_place' => $data['destination_place'],
            ':nolon'             => $data['nolon'] ?? 0,
            ':office_amount'     => $data['office_amount'] ?? 0,
            ':item_type'         => $data['item_type'] ?? null,
            ':price'             => $data['price'] ?? 0,
            ':created_by'        => $data['username'],
        ]);
        return $this->getById((int) $this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username): ?array {
        $allowed = ['loading_place', 'destination_place', 'nolon', 'office_amount', 'item_type', 'price'];
        $fields = [];
        $params = [':id' => $id, ':updated_by' => $username];

        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) {
                $fields[] = "`{$f}` = :{$f}";
                $params[":{$f}"] = $patch[$f];
            }
        }

        if (empty($fields)) return $this->getById($id);

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $sql = 'UPDATE hamola_details SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL';
        $this->db->prepare($sql)->execute($params);
        return $this->getById($id);
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare(
            'UPDATE hamola_details SET deleted_at = NOW(3), deleted_by = :u, updated_by = :u WHERE id = :id AND deleted_at IS NULL'
        );
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
