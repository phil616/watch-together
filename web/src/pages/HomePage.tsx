import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, json } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import type { Media, Room } from "../types";

type UploadInit = {
  mediaId: string;
  uploadId: string;
  mode: "single" | "multipart";
  partSizeBytes?: number;
  url?: string;
};

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
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    setUploading("正在申请上传…");
    setError("");
    try {
      const init = await api<UploadInit>("/api/v1/media/uploads", {
        method: "POST",
        body: json({
          filename: file.name,
          sizeBytes: file.size,
          contentType: file.type || "video/mp4",
        }),
      });
      const parts: { partNumber: number; etag: string }[] = [];
      if (init.mode === "single") {
        setUploading("正在直传对象存储…");
        const put = await fetch(init.url!, {
          method: "PUT",
          headers: { "Content-Type": file.type || "video/mp4" },
          body: file,
        });
        if (!put.ok) throw new Error(`上传失败 (${put.status})`);
      } else {
        const size = init.partSizeBytes!;
        const count = Math.ceil(file.size / size);
        const nums = Array.from({ length: count }, (_, i) => i + 1);
        for (let offset = 0; offset < nums.length; offset += 100) {
          const batch = nums.slice(offset, offset + 100);
          const signed = await api<{
            parts: { partNumber: number; url: string }[];
          }>(`/api/v1/media/uploads/${init.uploadId}/parts`, {
            method: "POST",
            body: json({ partNumbers: batch }),
          });
          for (const p of signed.parts) {
            setUploading(`上传分片 ${p.partNumber}/${count}`);
            const put = await fetch(p.url, {
              method: "PUT",
              body: file.slice(
                (p.partNumber - 1) * size,
                Math.min(file.size, p.partNumber * size),
              ),
            });
            if (!put.ok) throw new Error(`分片 ${p.partNumber} 上传失败`);
            const etag = put.headers.get("ETag");
            if (!etag) throw new Error("对象存储 CORS 未暴露 ETag 响应头");
            parts.push({ partNumber: p.partNumber, etag });
          }
        }
      }
      setUploading("正在校验媒体…");
      await api(`/api/v1/media/uploads/${init.uploadId}/complete`, {
        method: "POST",
        body: json({ parts }),
      });
      setUploading("上传完成");
      await load();
    } catch (e) {
      setError((e as Error).message);
      setUploading("");
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
            <input type="file" accept="video/*" onChange={upload} />
          </label>
          {uploading && <p className="progress-text">{uploading}</p>}
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
