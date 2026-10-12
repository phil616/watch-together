import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, json } from "../api/client";
import { uploadMedia } from "../api/upload";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import type { Media, Room } from "../types";

const roomStatusLabel = (status: Room["status"]) => {
  if (status === "OPEN") return "开放中";
  if (status === "HOST_DISCONNECTED") return "等待房主返回";
  return "已关闭，可重新开放";
};

/** Dashboard for creating rooms and uploading media. */
export function HomePage() {
  const { identity, loading } = useAuth();
  const nav = useNavigate();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState("");
  const [busy, setBusy] = useState(false);
  const uploadController = useRef<AbortController | null>(null);
  const [storageHealth, setStorageHealth] = useState("");
  const [checkingStorage, setCheckingStorage] = useState(false);
  useEffect(() => () => uploadController.current?.abort(), []);
  const checkStorage = async () => {
    setCheckingStorage(true);
    setStorageHealth("正在检测 OSS…");
    try {
      const result = await api<{ message: string }>("/api/v1/storage/health", {
        signal: AbortSignal.timeout(10_000),
      });
      setStorageHealth(result.message);
    } catch (e) {
      setStorageHealth(
        (e as Error).name === "TimeoutError"
          ? "OSS 健康检测超时"
          : (e as Error).message,
      );
    } finally {
      setCheckingStorage(false);
    }
  };

  /** Reload both room and media lists from the API. */
  const load = () =>
    Promise.all([api<Room[]>("/api/v1/rooms"), api<Media[]>("/api/v1/media")])
      .then(([r, m]) => {
        setRooms(r ?? []);
        setMedia(m ?? []);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (!loading && !identity) nav("/login");
    else if (identity && !identity.guest) load();
  }, [identity, loading]);
  if (loading || !identity) return null;
  if (identity.guest)
    return (
      <Layout>
        <section className="hero">
          <h1>你的游客会话仍然有效</h1>
          <p>请从邀请链接返回房间，或退出后登录正式账户。</p>
        </section>
      </Layout>
    );
  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<Room>("/api/v1/rooms", {
        method: "POST",
        body: json({
          title: f.get("title"),
          maxMembers: Number(f.get("maxMembers")),
        }),
      });
      nav(`/room/${r.code}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const removeMedia = async (id: string) => {
    if (!confirm("确定删除这部影片？此操作会删除对象存储中的文件。")) return;
    try {
      await api(`/api/v1/media/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  /** Upload a selected file directly to object storage from the browser. */
  const upload = async (e: FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file || uploadController.current) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setBusy(true);
    setError("");
    try {
      await uploadMedia(file, controller.signal, setUploading);
    } catch (e) {
      setError((e as Error).message);
      setUploading("");
    } finally {
      uploadController.current = null;
      setBusy(false);
      input.value = "";
      await load();
    }
  };
  return (
    <Layout>
      <section className="hero dashboard-hero">
        <span className="eyebrow">REMOTE SCREENING ROOM</span>
        <h1>今晚，看点什么？</h1>
        <p>您可创建一间放映室并分享给其他人</p>
      </section>
      {error && <div className="error-box global-error">{error}</div>}
      <div className="dashboard-grid">
        <form className="panel create-panel" onSubmit={create}>
          <div className="panel-heading">
            <h2>新建房间</h2>
            <span className="step-number">01</span>
          </div>
          <label>
            房间标题
            <input
              name="title"
              placeholder="周五夜场"
              maxLength={100}
              required
            />
          </label>
          <label>
            最多人数
            <input
              name="maxMembers"
              type="number"
              min={2}
              max={20}
              defaultValue={8}
            />
          </label>
          <button className="primary">创建并进入</button>
        </form>
        <section className="panel upload-panel">
          <div className="panel-heading">
            <h2>上传影片</h2>
            <span className="step-number">02</span>
          </div>
          <p className="muted">
            视频由浏览器直接传到你的私有对象存储，不经过观影服务器。
          </p>
          <label className="file-drop">
            选择 MP4 或浏览器支持的视频
            <input
              type="file"
              accept="video/*"
              onChange={upload}
              disabled={busy}
            />
          </label>
          {uploading && (
            <p className="progress-text" role="status">
              {uploading}
            </p>
          )}
          {busy && (
            <button
              type="button"
              className="ghost small"
              onClick={() => uploadController.current?.abort()}
            >
              取消上传
            </button>
          )}
          <button
            type="button"
            className="ghost small"
            disabled={checkingStorage}
            onClick={checkStorage}
          >
            {checkingStorage ? "检测中…" : "检测 OSS 连接"}
          </button>
          {storageHealth && (
            <p className="progress-text" role="status">
              {storageHealth}
            </p>
          )}
        </section>
      </div>
      <section className="library">
        <div className="section-title">
          <h2>我的房间</h2>
          <span>{rooms.length} 间</span>
        </div>
        <div className="card-list">
          {rooms.map((r) => (
            <button
              className="room-card"
              key={r.id}
              onClick={() => nav(`/room/${r.code}`)}
            >
              <span className={`status-dot ${r.status.toLowerCase()}`} />
              <strong>{r.title}</strong>
              <small>
                {r.code} · {roomStatusLabel(r.status)}
              </small>
              <span className="arrow">→</span>
            </button>
          ))}
          {!rooms.length && <div className="empty-list">尚未创建房间</div>}
        </div>
      </section>
      <section className="library">
        <div className="section-title">
          <h2>我的影片</h2>
          <span>{media.length} 部</span>
        </div>
        <div className="media-grid">
          {media.map((m) => (
            <article className="media-card" key={m.id}>
              <div className="poster-placeholder">▶</div>
              <strong>{m.originalFilename}</strong>
              <small>
                {(m.sizeBytes / 1024 / 1024).toFixed(1)} MB · {m.status}
              </small>
              <button
                className="ghost small danger"
                onClick={() => removeMedia(m.id)}
              >
                删除影片
              </button>
            </article>
          ))}
          {!media.length && (
            <div className="empty-list">上传一部影片，开始第一次同步观影。</div>
          )}
        </div>
      </section>
    </Layout>
  );
}
