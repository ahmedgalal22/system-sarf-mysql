<?php
/**
 * repositories/VehicleRepository.php — Vehicle data access layer
 */

class VehicleRepository {
    private PDO $db;

    public function __construct(PDO $db) {
        $this->db = $db;
    }

    /**
     * Get all non-deleted vehicles for a user.
     */
    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicles WHERE username = :username AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':username' => $username]);
        return $stmt->fetchAll();
    }

    /**
     * Get single vehicle by ID.
     */
    public function getById(int $id): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicles WHERE id = :id AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /**
     * Find vehicles by plate number.
     */
    public function findByPlate(string $plate): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicles WHERE plate = :plate AND deleted_at IS NULL'
        );
        $stmt->execute([':plate' => $plate]);
        return $stmt->fetchAll();
    }

    /**
     * Create a new vehicle.
     */
    public function create(array $data): array {
        $uuid = $data['uuid'] ?? $this->generateUUID();
        $stmt = $this->db->prepare(
            'INSERT INTO vehicles (uuid, plate, owner_id, owner_name, driver_name, notes, username, created_by, created_at, updated_at)
             VALUES (:uuid, :plate, :owner_id, :owner_name, :driver_name, :notes, :username, :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'        => $uuid,
            ':plate'       => $data['plate'],
            ':owner_id'    => $data['owner_id'] ?? null,
            ':owner_name'  => $data['owner_name'] ?? null,
            ':driver_name' => $data['driver_name'] ?? null,
            ':notes'       => $data['notes'] ?? null,
            ':username'    => $data['username'],
            ':created_by'  => $data['username'],
        ]);
        $id = (int) $this->db->lastInsertId();
        return $this->getById($id);
    }

    /**
     * Update a vehicle with optimistic locking.
     */
    public function update(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): ?array {
        if ($expectedUpdatedAt !== null) {
            $current = $this->getById($id);
            if ($current && $current['updated_at'] !== $expectedUpdatedAt) {
                return null;
            }
        }

        $fields = [];
        $params = [':id' => $id, ':updated_by' => $username];

        $allowedFields = ['plate', 'owner_id', 'owner_name', 'driver_name', 'notes'];
        foreach ($allowedFields as $field) {
            if (array_key_exists($field, $patch)) {
                $fields[] = "{$field} = :{$field}";
                $params[":{$field}"] = $patch[$field];
            }
        }

        if (empty($fields)) {
            return $this->getById($id);
        }

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $sql = 'UPDATE vehicles SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);

        return $this->getById($id);
    }

    /**
     * Soft-delete a vehicle.
     */
    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare(
            'UPDATE vehicles SET deleted_at = NOW(3), deleted_by = :username, updated_by = :username WHERE id = :id AND deleted_at IS NULL'
        );
        $stmt->execute([':id' => $id, ':username' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function generateUUID(): string {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
