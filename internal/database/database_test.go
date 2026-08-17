package database

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenMigratesAndEnablesSQLiteSafety(t *testing.T) {
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil || count < 2 {
		t.Fatalf("migration missing: count=%d err=%v", count, err)
	}
	var fk int
	if err = db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign keys disabled: %d %v", fk, err)
	}
	var mode string
	if err = db.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("WAL disabled: %s %v", mode, err)
	}
	if _, err = db.Exec(`INSERT INTO room_members(room_id,user_id,role,joined_at_ms) VALUES('missing','missing','MEMBER',1)`); err == nil {
		t.Fatal("foreign key violation accepted")
	}
}

func TestMigrationRestoresLegacyAutoClosedRooms(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	initial, err := migrations.ReadFile("migrations/001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(string(initial)); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (1, 1); INSERT INTO users(id,username,password_hash,nickname,created_at_ms,updated_at_ms) VALUES('u','user','hash','User',1,1); INSERT INTO rooms(id,code,title,host_user_id,status,join_policy,max_members,created_at_ms,updated_at_ms,closed_at_ms) VALUES('r','ABC23456','Legacy','u','CLOSED','INVITE',5,1,2,2)`); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var status string
	var closedAt any
	if err = db.QueryRow(`SELECT status,closed_at_ms FROM rooms WHERE id='r'`).Scan(&status, &closedAt); err != nil {
		t.Fatal(err)
	}
	if status != "HOST_DISCONNECTED" || closedAt != nil {
		t.Fatalf("legacy room status=%s closedAt=%v", status, closedAt)
	}
	if _, err = db.Exec(`INSERT INTO rooms(id,code,title,host_user_id,status,join_policy,max_members,created_at_ms,updated_at_ms,closed_at_ms) VALUES('r2','DEF23456','Explicit','u','CLOSED','INVITE',5,3,4,4)`); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT status FROM rooms WHERE id='r2'`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "CLOSED" {
		t.Fatalf("one-time repair changed a future explicit close to %s", status)
	}
}
