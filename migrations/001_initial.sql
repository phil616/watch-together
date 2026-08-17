CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);

CREATE TABLE media (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    duration_ms INTEGER,
    video_width INTEGER,
    video_height INTEGER,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    FOREIGN KEY(owner_user_id) REFERENCES users(id)
);

CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    host_user_id TEXT NOT NULL,
    media_id TEXT,
    status TEXT NOT NULL,
    join_policy TEXT NOT NULL DEFAULT 'INVITE',
    max_members INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    FOREIGN KEY(host_user_id) REFERENCES users(id),
    FOREIGN KEY(media_id) REFERENCES media(id)
);

CREATE TABLE room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    joined_at_ms INTEGER NOT NULL,
    left_at_ms INTEGER,
    PRIMARY KEY(room_id, user_id),
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE room_invites (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    expires_at_ms INTEGER,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE guest_sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE media_uploads (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    s3_upload_id TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media(id) ON DELETE CASCADE
);

CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    sender_user_id TEXT,
    sender_guest_id TEXT,
    sender_nickname TEXT NOT NULL,
    content TEXT NOT NULL,
    media_position_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_chat_room_time ON chat_messages(room_id, created_at_ms DESC, id DESC);

CREATE TABLE room_playback_checkpoints (
    room_id TEXT PRIMARY KEY,
    media_id TEXT,
    position_ms INTEGER NOT NULL,
    playback_rate REAL NOT NULL,
    phase TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    actor_id TEXT,
    event_type TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}'
);

