<?php
/**
 * repositories/TreasuryRepository2.php — Treasury data access (Phase 6)
 *
 * Named TreasuryRepository2 to avoid confusion with frontend treasuryRepository.js.
 * Handles: deposits, withdrawals, salfa, expenses, payouts, reversals.
 *
 * RULES:
 *   - BIGINT cents only (no floats)
 *   - reference_id is NOT unique (multiple entries per receipt)
 *   - Reversal = is_reversed flag (NOT soft-delete)
 *   - Soft-delete = deleted_at (separate from reversal)
 */

class TreasuryRepo {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM treasury WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getByUuid(string $uuid): ?array {
        $stmt = $this->db->prepare('SELECT * FROM treasury WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':uuid' => $uuid]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM treasury WHERE username = :u AND deleted_at IS NULL AND is_archived = 0 ORDER BY created_at DESC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function getByReference(string $referenceId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM treasury WHERE reference_id = :rid AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':rid' => $referenceId]);
        return $stmt->fetchAll();
    }

    /**
     * Get active (non-reversed) entries for a reference — used for _assertNotApplied equivalent.
     */
    public function getActiveByReference(string $referenceId, string $referenceType): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM treasury WHERE reference_id = :rid AND reference_type = :rt AND is_reversed = 0 AND deleted_at IS NULL'
        );
        $stmt->execute([':rid' => $referenceId, ':rt' => $referenceType]);
        return $stmt->fetchAll();
    }

    /**
     * Get active (non-reversed, non-deleted) entries for a user + reference.
     * Supports optional FOR UPDATE locking inside an active transaction.
     */
    public function getActiveByReferenceForUser(
        string $username,
        string $referenceId,
        string $referenceType,
        bool $forUpdate = false
    ): array {
        $sql = 'SELECT * FROM treasury
                WHERE username = :u
                  AND reference_id = :rid
                  AND reference_type = :rt
                  AND is_reversed = 0
                  AND deleted_at IS NULL';
        if ($forUpdate) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute([
            ':u'   => $username,
            ':rid' => $referenceId,
            ':rt'  => $referenceType,
        ]);
        return $stmt->fetchAll();
    }

    public function getByIndex(string $username, string $indexName, $value): array {
        $allowed = ['type', 'effect', 'account_type', 'reference_type', 'client_id', 'is_reversed'];
        if (!in_array($indexName, $allowed, true)) return [];
        $stmt = $this->db->prepare(
            "SELECT * FROM treasury WHERE username = :u AND `{$indexName}` = :v AND deleted_at IS NULL ORDER BY created_at DESC"
        );
        $stmt->execute([':u' => $username, ':v' => $value]);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $uuid = $data['uuid'] ?? $this->uuid();
        $stmt = $this->db->prepare(
            'INSERT INTO treasury (uuid, username, type, effect, account_type, entry_type, amount,
                reference_type, reference_id, client_id, client_type, client_name, agent_id, receipt_number,
                date, applied_at, description, note, is_reversed, is_archived, archive_batch_id,
                created_by, created_at, updated_at)
             VALUES (:uuid, :username, :type, :effect, :account_type, :entry_type, :amount,
                :reference_type, :reference_id, :client_id, :client_type, :client_name, :agent_id, :receipt_number,
                :date, :applied_at, :description, :note, :is_reversed, :is_archived, :archive_batch_id,
                :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'            => $uuid,
            ':username'        => $data['username'],
            ':type'            => $data['type'] ?? 'deposit',
            ':effect'          => $data['effect'] ?? null,
            ':account_type'    => $data['account_type'] ?? 'cash',
            ':entry_type'      => $data['entry_type'] ?? null,
            ':amount'          => intval($data['amount'] ?? 0),
            ':reference_type'  => $data['reference_type'] ?? null,
            ':reference_id'    => $data['reference_id'] ?? null,
            ':client_id'       => $data['client_id'] ?? null,
            ':client_type'     => $data['client_type'] ?? null,
            ':client_name'     => $data['client_name'] ?? null,
            ':agent_id'        => $data['agent_id'] ?? null,
            ':receipt_number'  => $data['receipt_number'] ?? null,
            ':date'            => $data['date'] ?? null,
            ':applied_at'      => $data['applied_at'] ?? null,
            ':description'     => $data['description'] ?? null,
            ':note'            => $data['note'] ?? null,
            ':is_reversed'     => intval($data['is_reversed'] ?? 0),
            ':is_archived'     => intval($data['is_archived'] ?? 0),
            ':archive_batch_id'=> $data['archive_batch_id'] ?? null,
            ':created_by'      => $data['username'],
        ]);
        return $this->getById((int)$this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): ?array {
        if ($expectedUpdatedAt !== null) {
            $cur = $this->getById($id);
            if ($cur && $cur['updated_at'] !== $expectedUpdatedAt) return null;
        }
        $allowed = ['type','effect','account_type','amount','date','description','note',
                     'is_reversed','reversed_at','reversed_by','client_id','client_type','client_name',
                     'receipt_number'];
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
        $this->db->prepare('UPDATE treasury SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL')->execute($params);
        return $this->getById($id);
    }

    /**
     * Reverse all active entries matching a reference — sets is_reversed = true.
     * Returns count of reversed entries.
     */
    public function reverseByReference(string $referenceId, string $referenceType, string $username): int {
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $stmt = $this->db->prepare(
            'UPDATE treasury SET is_reversed = 1, reversed_at = :now, reversed_by = :u, updated_at = NOW(3)
             WHERE reference_id = :rid AND reference_type = :rt AND is_reversed = 0 AND deleted_at IS NULL'
        );
        $stmt->execute([':rid' => $referenceId, ':rt' => $referenceType, ':u' => $username, ':now' => $now]);
        return $stmt->rowCount();
    }

    /**
     * Reverse all active entries matching a reference scoped to a specific user.
     */
    public function reverseByReferenceForUser(
        string $username,
        string $referenceId,
        string $referenceType
    ): int {
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $stmt = $this->db->prepare(
            'UPDATE treasury
             SET is_reversed = 1, reversed_at = :now, reversed_by = :rev_by, updated_at = NOW(3)
             WHERE username = :u
               AND reference_id = :rid
               AND reference_type = :rt
               AND is_reversed = 0
               AND deleted_at IS NULL'
        );
        $stmt->execute([
            ':rev_by' => $username,
            ':u'      => $username,
            ':rid'    => $referenceId,
            ':rt'     => $referenceType,
            ':now'    => $now,
        ]);
        return $stmt->rowCount();
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare('UPDATE treasury SET deleted_at = NOW(3), deleted_by = :u WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function uuid(): string {
        $d = random_bytes(16); $d[6] = chr(ord($d[6]) & 0x0f | 0x40); $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
