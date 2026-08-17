import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, json } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Layout } from "../components/Layout";
import { VideoPlayer } from "../components/VideoPlayer";
import { SyncController, type SyncStatus } from "../player/SyncController";
import {
  WebSocketClient,
  type ConnectionStatus,
} from "../realtime/WebSocketClient";
import type {
  Envelope,
  PlaybackState,
  RoomSnapshot,
} from "../realtime/protocol";
import type { ChatMessage, Media, Member, Room } from "../types";

type SidePanel = "chat" | "members";
const DANMAKU_PREFERENCE = "movie-sync:danmaku";
const SYNC_STATUS_PREFERENCE = "movie-sync:sync-status";

const initialDanmakuPreference = () => {
  try {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return false;
    return window.localStorage.getItem(DANMAKU_PREFERENCE) !== "off";
  } catch {
    return true;
  }
};

const initialSyncStatusPreference = () => {
  try {
    return window.localStorage.getItem(SYNC_STATUS_PREFERENCE) !== "off";
  } catch {
    return true;
  }
};

const formatTime = (ms?: number) => {
  if (ms === undefined) return "";
  const t = Math.floor(ms / 1000);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};
/** Realtime room page: playback, chat, members, and host controls. */
export function RoomPage() {
  const { code = "" } = useParams();
  const { identity, loading, refresh } = useAuth();
  const nav = useNavigate();
  const [room, setRoom] = useState<Room>();
  const [playback, setPlayback] = useState<PlaybackState>();
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [danmakuMessages, setDanmakuMessages] = useState<ChatMessage[]>([]);
  const [danmakuEnabled, setDanmakuEnabled] = useState(
    initialDanmakuPreference,
  );
  const [syncStatusVisible, setSyncStatusVisible] = useState(
    initialSyncStatusPreference,
  );
  const [sidePanel, setSidePanel] = useState<SidePanel>("chat");
  const [media, setMedia] = useState<Media>();
  const [src, setSrc] = useState<string>();
  const [pendingSrc, setPendingSrc] = useState<string>();
  const [ticketNonce, setTicketNonce] = useState(0);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("synced");
  const [error, setError] = useState("");
  const [invite, setInvite] = useState("");
  const [library, setLibrary] = useState<Media[]>([]);
  const danmakuEnabledRef = useRef(danmakuEnabled);
  const messageListRef = useRef<HTMLDivElement>(null);
  const keepChatAtBottom = useRef(true);
  const ws = useMemo(() => new WebSocketClient(code, setConnection), [code]);
  const isHost = !!identity && room?.hostUserId === identity.id;
  const roomClosed = room?.status === "CLOSED";
  const controller = useMemo(
    () => new SyncController(ws, false, setSyncStatus),
    [ws],
  );
  useEffect(() => {
    if (!loading && !identity) nav("/login");
  }, [identity, loading]);
  useEffect(() => {
    controller.setHost(isHost);
  }, [controller, isHost]);
  useEffect(() => {
    if (connection !== "connected") controller.suspend();
  }, [connection, controller]);
  useEffect(() => {
    danmakuEnabledRef.current = danmakuEnabled;
  }, [danmakuEnabled]);
  useEffect(() => {
    if (sidePanel !== "chat" || !keepChatAtBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, sidePanel]);
  useEffect(() => {
    if (!identity) return;
    setRoom(undefined);
    setConnection("connecting");
    api<{ room: Room; media?: Media }>(
      `/api/v1/rooms/${encodeURIComponent(code)}`,
    )
      .then((v) => {
        setRoom(v.room);
        setMedia(v.media);
      })
      .catch((e) => {
        setConnection("disconnected");
        setError(e.message);
      });
    api<ChatMessage[]>(`/api/v1/rooms/${encodeURIComponent(code)}/messages`)
      .then((history) =>
        setMessages((current) => {
          const merged = new Map<string, ChatMessage>();
          for (const message of history ?? []) merged.set(message.id, message);
          for (const message of current) merged.set(message.id, message);
          return [...merged.values()]
            .sort((a, b) => a.createdAtMs - b.createdAtMs)
            .slice(-300);
        }),
      )
      .catch(() => {});
    if (!identity.guest)
      api<Media[]>("/api/v1/media")
        .then((v) => setLibrary(v ?? []))
        .catch(() => {});
  }, [code, identity]);
  useEffect(() => {
    if (!identity || !room || room.code !== code.toUpperCase()) return;
    if (roomClosed) {
      setConnection("closed");
      controller.suspend();
      return;
    }
    const unsubscribe = ws.subscribe((e: Envelope) => {
      if (e.type === "event.room.snapshot") {
        const s = e.payload as RoomSnapshot;
        setRoom(s.room);
        setPlayback(s.playback);
        setMembers(s.members);
        controller.setRoomState(s.playback, true);
      } else if (e.type === "event.playback.state") {
        const p = e.payload as PlaybackState;
        setPlayback((old) => (!old || p.revision > old.revision ? p : old));
      } else if (e.type === "event.chat.message") {
        const message = e.payload as ChatMessage;
        setMessages((items) => [...items, message].slice(-300));
        if (danmakuEnabledRef.current)
          setDanmakuMessages((items) => [...items, message].slice(-48));
      } else if (e.type === "event.room.member_joined") {
        const x = (
          e.payload as {
            member: { id: string; nickname: string; guest: boolean };
          }
        ).member;
        setMembers((ms) =>
          ms.some((m) => m.id === x.id)
            ? ms
            : [
                ...ms,
                {
                  id: x.id,
                  nickname: x.nickname,
                  kind: x.guest ? "guest" : "user",
                  role: "member",
                  online: true,
                  ready: false,
                },
              ],
        );
      } else if (e.type === "event.room.member_left") {
        const id = (e.payload as { memberId: string }).memberId;
        setMembers((ms) => ms.filter((m) => m.id !== id));
      } else if (e.type === "event.room.host_changed") {
        const id = (e.payload as { hostUserId: string }).hostUserId;
        setRoom((r) => (r ? { ...r, hostUserId: id } : r));
        setMembers((ms) =>
          ms.map((m) => ({ ...m, role: m.id === id ? "host" : "member" })),
        );
      } else if (e.type === "event.room.closed") {
        setError("房间已关闭");
        setRoom((r) => (r ? { ...r, status: "CLOSED" } : r));
      } else if (e.type === "event.server.shutdown") {
        setError("服务器正在维护，播放已暂停");
      }
    });
    ws.connect();
    return () => {
      unsubscribe();
      ws.disconnect();
    };
  }, [identity, ws, controller, room?.id, roomClosed, code]);
  useEffect(() => {
    const mediaId = playback?.mediaId ?? room?.mediaId;
    if (!mediaId || !identity) {
      setSrc(undefined);
      setPendingSrc(undefined);
      return;
    }
    let refreshTimer: number | undefined;
    let stopped = false;
    const fetchTicket = async (activate: boolean) => {
      try {
        const ticket = await api<{ url: string; expiresAtMs: number }>(
          `/api/v1/rooms/${room?.id ?? code}/media-ticket`,
          { method: "POST", body: "{}" },
        );
        if (stopped) return;
        if (activate) {
          setSrc(ticket.url);
          setPendingSrc(undefined);
        } else {
          // Replacing <video src> restarts playback, so hold the renewed URL
          // until the browser needs another network request.
          setPendingSrc(ticket.url);
        }
        const delay = Math.max(
          1_000,
          ticket.expiresAtMs - Date.now() - 30 * 60_000,
        );
        refreshTimer = window.setTimeout(() => fetchTicket(false), delay);
      } catch (cause) {
        if (activate && !stopped) setError((cause as Error).message);
      }
    };
    void fetchTicket(true);
    if (!media || media.id !== mediaId)
      api<{ room: Room; media?: Media }>(`/api/v1/rooms/${room?.id ?? code}`)
        .then((v) => setMedia(v.media))
        .catch(() => {});
    return () => {
      stopped = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [playback?.mediaId, room?.mediaId, room?.id, code, identity, ticketNonce]);
  const sendChat = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("message") as HTMLInputElement;
    if (!input.value.trim()) return;
    try {
      await ws.send("chat.send", { content: input.value });
      input.value = "";
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggleDanmaku = () => {
    setDanmakuEnabled((current) => {
      const next = !current;
      danmakuEnabledRef.current = next;
      if (!next) setDanmakuMessages([]);
      try {
        window.localStorage.setItem(DANMAKU_PREFERENCE, next ? "on" : "off");
      } catch {
        // Storage may be unavailable in privacy mode; the in-memory setting
        // still remains valid for the current room visit.
      }
      return next;
    });
  };
  const toggleSyncStatus = () => {
    setSyncStatusVisible((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(
          SYNC_STATUS_PREFERENCE,
          next ? "on" : "off",
        );
      } catch {
        // Keep the preference for this visit when storage is unavailable.
      }
      return next;
    });
  };
  const createInvite = async () => {
    try {
      const v = await api<{ url: string }>(
        `/api/v1/rooms/${room!.id}/invites`,
        { method: "POST", body: json({ expiresInSeconds: 86400 }) },
      );
      setInvite(v.url);
      await navigator.clipboard?.writeText(v.url);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const reopenRoom = async () => {
    if (!room) return;
    try {
      const reopened = await api<Room>(
        `/api/v1/rooms/${encodeURIComponent(room.id)}/reopen`,
        { method: "POST", body: "{}" },
      );
      setError("");
      setRoom(reopened);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  const changeMedia = async (id: string) => {
    if (!id) return;
    try {
      await api(`/api/v1/rooms/${room!.id}/media`, {
        method: "POST",
        body: json({ mediaId: id }),
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const closeRoom = async () => {
    if (!confirm("确定关闭房间？所有连接都将断开。")) return;
    await api(`/api/v1/rooms/${room!.id}/close`, {
      method: "POST",
      body: "{}",
    }).catch((e) => setError(e.message));
  };
  const leaveRoom = async () => {
    if (!confirm("确定离开放映室？再次进入需要新的邀请。")) return;
    try {
      await api(`/api/v1/rooms/${room!.id}/leave`, {
        method: "POST",
        body: "{}",
      });
      await refresh();
      nav(identity?.guest ? "/login" : "/");
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  if (loading || !identity) return null;
  return (
    <Layout wide>
      <div className="room-head">
        <div>
          <button className="back-link" onClick={() => nav("/")}>
            ← 返回首页
          </button>
          <h1>{room?.title ?? "正在进入放映室"}</h1>
          <span className="room-code">房间 {room?.code}</span>
        </div>
        <div className="room-actions">
          <span
            className={`connection ${connection === "connected" || connection === "connecting" ? connection : "disconnected"}`}
          >
            ●{" "}
            {connection === "connected"
              ? "实时连接"
              : connection === "connecting"
                ? "正在连接"
                : connection === "superseded"
                  ? "已在其他页面接管"
                  : connection === "closed"
                    ? "房间已关闭"
                    : connection === "forbidden"
                      ? "无权连接房间"
                      : connection === "full"
                        ? "房间人数已满"
                        : "连接中断"}
          </span>
          {room?.status === "CLOSED" && isHost && (
            <button className="ghost" onClick={reopenRoom}>
              重新开放房间
            </button>
          )}
          {isHost && (
            <button className="ghost" onClick={createInvite}>
              复制邀请链接
            </button>
          )}
          {isHost && (
            <button className="danger ghost" onClick={closeRoom}>
              关闭房间
            </button>
          )}
          {!isHost && room && (
            <button className="danger ghost" onClick={leaveRoom}>
              离开房间
            </button>
          )}
        </div>
      </div>
      {invite && (
        <div className="notice">
          邀请链接已复制：<span>{invite}</span>
        </div>
      )}
      {error && (
        <div className="error-box global-error">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      <div className="room-grid">
        <div className="room-main">
          <VideoPlayer
            src={src}
            state={playback}
            isHost={isHost}
            controller={controller}
            syncStatus={syncStatus}
            syncStatusVisible={syncStatusVisible}
            danmakuMessages={danmakuMessages}
            danmakuEnabled={danmakuEnabled}
            onSyncStatusToggle={toggleSyncStatus}
            onDanmakuToggle={toggleDanmaku}
            onMediaError={() => {
              if (pendingSrc) {
                setSrc(pendingSrc);
                setPendingSrc(undefined);
              } else {
                setTicketNonce((value) => value + 1);
              }
            }}
          />
          {isHost && (
            <section className="host-tools panel">
              <div>
                <strong>当前影片</strong>
                <span>{media?.originalFilename ?? "尚未选择"}</span>
              </div>
              <select
                aria-label="切换影片"
                value={media?.id ?? ""}
                onChange={(e) => changeMedia(e.target.value)}
              >
                <option value="">选择影片…</option>
                {library
                  .filter((m) => m.status === "READY")
                  .map((m) => (
                    <option value={m.id} key={m.id}>
                      {m.originalFilename}
                    </option>
                  ))}
              </select>
            </section>
          )}
        </div>
        <aside className={`room-side ${sidePanel}-panel`}>
          <div className="side-tabs" role="tablist" aria-label="房间侧栏">
            <button
              type="button"
              role="tab"
              aria-selected={sidePanel === "chat"}
              aria-controls="room-chat-panel"
              className={sidePanel === "chat" ? "active" : ""}
              onClick={() => {
                keepChatAtBottom.current = true;
                setSidePanel("chat");
              }}
            >
              聊天 <small>{messages.length}</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidePanel === "members"}
              aria-controls="room-member-panel"
              className={sidePanel === "members" ? "active" : ""}
              onClick={() => setSidePanel("members")}
            >
              成员{" "}
              <small>
                {members.length}/{room?.maxMembers}
              </small>
            </button>
          </div>
          {sidePanel === "chat" ? (
            <>
              <div
                className="messages"
                id="room-chat-panel"
                ref={messageListRef}
                role="log"
                aria-live="polite"
                onScroll={(event) => {
                  const list = event.currentTarget;
                  keepChatAtBottom.current =
                    list.scrollHeight - list.scrollTop - list.clientHeight < 80;
                }}
              >
                {messages.map((message) => {
                  const own = message.senderId === identity.id;
                  return (
                    <article
                      className={`message${own ? " own" : ""}`}
                      key={message.id}
                    >
                      <div className="message-meta">
                        <strong>{own ? "我" : message.senderNickname}</strong>
                        {message.mediaPositionMs !== undefined && (
                          <button
                            className="timestamp"
                            disabled={!isHost}
                            onClick={() =>
                              controller.onUserSeek(message.mediaPositionMs!)
                            }
                          >
                            {formatTime(message.mediaPositionMs)}
                          </button>
                        )}
                      </div>
                      <div className="message-bubble">
                        <p>{message.content}</p>
                      </div>
                    </article>
                  );
                })}
                {!messages.length && (
                  <div className="empty-chat">
                    放映厅很安静。
                    <br />
                    说点什么，消息也会飘过屏幕。
                  </div>
                )}
              </div>
              <form className="chat-form" onSubmit={sendChat}>
                <input
                  aria-label="聊天消息"
                  name="message"
                  maxLength={2000}
                  autoComplete="off"
                  placeholder={
                    connection === "connected" ? "发送消息…" : "等待重新连接…"
                  }
                  disabled={connection !== "connected"}
                />
                <button
                  aria-label="发送消息"
                  disabled={connection !== "connected"}
                >
                  ↑
                </button>
              </form>
            </>
          ) : (
            <div className="member-list" id="room-member-panel" role="tabpanel">
              <h3>在线成员</h3>
              {members.map((member) => (
                <div className="member" key={member.id}>
                  <span className="avatar">
                    {member.nickname.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{member.nickname}</strong>
                    <small>
                      {member.role === "host"
                        ? "房主"
                        : member.kind === "guest"
                          ? "游客"
                          : "成员"}{" "}
                      · {member.ready ? "已就绪" : "加载中"}
                    </small>
                  </div>
                  {member.online && <i />}
                  {isHost &&
                    member.id !== identity.id &&
                    member.kind === "user" && (
                      <button
                        className="tiny"
                        onClick={() =>
                          api(`/api/v1/rooms/${room!.id}/transfer-host`, {
                            method: "POST",
                            body: json({ userId: member.id }),
                          }).catch((cause) => setError(cause.message))
                        }
                      >
                        转让
                      </button>
                    )}
                  {isHost && member.id !== identity.id && (
                    <button
                      className="tiny danger"
                      onClick={() =>
                        api(`/api/v1/rooms/${room!.id}/kick`, {
                          method: "POST",
                          body: json({ userId: member.id }),
                        }).catch((cause) => setError(cause.message))
                      }
                    >
                      移除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </Layout>
  );
}
