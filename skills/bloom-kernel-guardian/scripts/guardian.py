import glob
import pathlib
import re
import sqlite3
import time

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]


def find_sql_migrations():
    candidates = [
        REPO_ROOT / "migrations",
        REPO_ROOT / "db" / "migrations",
        REPO_ROOT / "src" / "db" / "migrations",
    ]
    sql_files = []
    for candidate in candidates:
        if candidate.exists():
            sql_files += sorted(glob.glob(str(candidate / "*.sql")))
    if not sql_files:
        raise SystemExit(
            "No .sql migrations found (looked in migrations/, db/migrations/, src/db/migrations/)."
        )
    return sql_files


def apply_migrations(conn, sql_files):
    cur = conn.cursor()
    for sql_file in sql_files:
        with open(sql_file, "r", encoding="utf-8") as fh:
            sql = fh.read()
        try:
            cur.executescript(sql)
        except Exception as exc:
            raise SystemExit(f"Failed applying migration {sql_file}: {exc}")
    conn.commit()


def require_immutable_table(conn, table):
    cur = conn.cursor()
    triggers = cur.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",
        (table,),
    ).fetchall()
    sql_blob = "\n".join((trigger[1] or "") for trigger in triggers).lower()
    # Heuristic: must contain both update+delete protection and abort/raise
    has_update = "update" in sql_blob
    has_delete = "delete" in sql_blob
    has_abort = ("raise" in sql_blob) or ("abort" in sql_blob)
    if not (has_update and has_delete and has_abort):
        raise SystemExit(
            f"[FAIL] {table} is not DB-immutable. Missing triggers blocking UPDATE/DELETE with RAISE/ABORT."
        )
    print(f"[OK] {table} appears DB-immutable (triggers present).")

def seed_actor(conn):
    now = int(time.time())
    user_id = f"user_guardian_{now}"
    agent_id = f"agent_guardian_{now}"
    conn.execute("INSERT INTO users (user_id, created_at) VALUES (?, ?)", (user_id, now))
    conn.execute(
        "INSERT INTO agents (agent_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (agent_id, user_id, "active", now, now),
    )
    return user_id, agent_id, now


def insert_event(conn, user_id, agent_id, now):
    event_id = f"evt_guardian_{now}"
    conn.execute(
        """
        INSERT INTO events (
          event_id,
          agent_id,
          user_id,
          type,
          payload_json,
          occurred_at,
          created_at,
          hash,
          prev_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_id,
            agent_id,
            user_id,
            "kernel.guardian",
            "{}",
            now,
            now,
            "hash_guardian",
            None,
        ),
    )
    return event_id


def insert_receipt(conn, user_id, agent_id, event_id, now):
    receipt_id = f"rcpt_guardian_{now}"
    conn.execute(
        """
        INSERT INTO receipts (
          receipt_id,
          agent_id,
          user_id,
          source,
          event_id,
          external_ref,
          what_happened,
          why_changed,
          what_happens_next,
          occurred_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            receipt_id,
            agent_id,
            user_id,
            "policy",
            event_id,
            "guardian",
            "Guardian test insert.",
            "guardian",
            "Guardian will attempt mutation.",
            now,
            now,
        ),
    )
    return receipt_id


def assert_blocked(conn, sql, params, label):
    try:
        conn.execute(sql, params)
    except sqlite3.DatabaseError:
        print(f"[OK] {label} blocked as expected.")
        return
    raise SystemExit(f"[FAIL] {label} was allowed; table is not append-only.")


def prove_immutable_by_writes(conn, table, pk_col, pk_value, update_col):
    assert_blocked(
        conn,
        f"UPDATE {table} SET {update_col} = {update_col} WHERE {pk_col} = ?",
        (pk_value,),
        f"UPDATE on {table}",
    )
    assert_blocked(
        conn,
        f"DELETE FROM {table} WHERE {pk_col} = ?",
        (pk_value,),
        f"DELETE on {table}",
    )


def scan_for_ghost_state():
    # Minimal static scan: these are the tables the audit called out
    suspicious_tables = ["budgets", "policies", "agents", "users", "agent_tokens"]
    kernel_path = REPO_ROOT / "kernel.ts"
    if not kernel_path.exists():
        # Try src/kernel.ts or src/kernel/kernel.ts
        alt = REPO_ROOT / "src" / "kernel.ts"
        if alt.exists():
            kernel_path = alt
        else:
            alt = REPO_ROOT / "src" / "kernel" / "kernel.ts"
            kernel_path = alt if alt.exists() else kernel_path

    if not kernel_path.exists():
        print("[WARN] kernel.ts not found for ghost-state scan; skipping.")
        return

    text = kernel_path.read_text(encoding="utf-8")
    # Look for direct INSERT/UPDATE into core tables without any event/receipt nearby
    hits = []
    for table in suspicious_tables:
        pat = re.compile(
            rf"(insert\s+into\s+{table}|update\s+{table}|delete\s+from\s+{table})",
            re.IGNORECASE,
        )
        for match in pat.finditer(text):
            start = max(0, match.start() - 300)
            end = min(len(text), match.end() + 300)
            window = text[start:end].lower()
            if (
                ("event" not in window)
                and ("receipt" not in window)
                and ("append" not in window)
            ):
                hits.append((table, match.group(0), match.start()))
    if hits:
        print("[FAIL] Possible ghost-state mutations in kernel.ts (heuristic):")
        for table, op, pos in hits[:25]:
            print(f"  - {op} on {table} at char {pos}")
        raise SystemExit("Ghost-state heuristic failed. Ensure mutations emit event+receipt or are derived.")
    print("[OK] Ghost-state heuristic passed (no obvious unlogged mutations).")


def main():
    print("== Bloom Kernel Guardian ==")
    sql_files = find_sql_migrations()
    with sqlite3.connect(":memory:") as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        apply_migrations(conn, sql_files)
        require_immutable_table(conn, "events")
        require_immutable_table(conn, "receipts")
        user_id, agent_id, now = seed_actor(conn)
        event_id = insert_event(conn, user_id, agent_id, now)
        receipt_id = insert_receipt(conn, user_id, agent_id, event_id, now)
        prove_immutable_by_writes(conn, "events", "event_id", event_id, "type")
        prove_immutable_by_writes(conn, "receipts", "receipt_id", receipt_id, "what_happened")
    scan_for_ghost_state()
    print("[OK] Guardian checks passed.")


if __name__ == "__main__":
    main()
