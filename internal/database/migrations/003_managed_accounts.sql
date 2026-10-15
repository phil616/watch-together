ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER' CHECK(role IN ('USER','SUPER_ADMIN'));
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1));
CREATE UNIQUE INDEX one_super_admin ON users(role) WHERE role='SUPER_ADMIN';
CREATE TRIGGER protect_super_admin_delete BEFORE DELETE ON users WHEN OLD.role='SUPER_ADMIN'
BEGIN SELECT RAISE(ABORT, 'super administrator cannot be deleted'); END;
CREATE TRIGGER protect_super_admin_update BEFORE UPDATE ON users
WHEN OLD.role='SUPER_ADMIN' AND (NEW.role!='SUPER_ADMIN' OR NEW.disabled!=0)
BEGIN SELECT RAISE(ABORT, 'super administrator cannot be disabled or demoted'); END;
